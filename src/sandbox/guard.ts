/**
 * Source for the egress guard that is injected into every sandbox before any
 * verification template runs.
 *
 * This is shipped as a string rather than a module because the same source has to run
 * in two places: a local child process, and a remote Daytona sandbox where our own
 * files do not exist. Both write it to disk and preload it.
 *
 * What it enforces: a template may only open connections to hosts on the allowlist.
 * Everything else throws before a packet leaves.
 *
 * What it does not do: contain hostile code. A template that set out to defeat this
 * could. Our templates are fixed, reviewed, and never written by the model at runtime,
 * so the threat we are actually defending against is a template with a bug in it -
 * a typo'd hostname, a redirect followed somewhere unexpected. For that, this is
 * sufficient and it fails loudly.
 */
export const GUARD_SOURCE = String.raw`
'use strict';
const dns = require('node:dns');
const net = require('node:net');

const allowedHosts = new Set(
  (process.env.SBX_ALLOW_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
);
const allowedIps = new Set();

class EgressBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'EgressBlocked';
  }
}

// Resolve the allowlist up front so the connect hook can compare against addresses
// rather than trusting a hostname supplied at call time.
const realLookup = dns.lookup;
function seedAllowedIps(done) {
  const pending = [...allowedHosts];
  if (pending.length === 0) return done();
  let outstanding = pending.length;
  for (const host of pending) {
    realLookup(host, { all: true }, (err, addresses) => {
      if (!err) for (const a of addresses) allowedIps.add(a.address);
      if (--outstanding === 0) done();
    });
  }
}

dns.lookup = function guardedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  if (!allowedHosts.has(hostname)) {
    const err = new EgressBlocked(
      'DNS blocked for ' + hostname + '; allowlist=' + JSON.stringify([...allowedHosts]),
    );
    return process.nextTick(() => cb(err));
  }
  return realLookup.apply(this, arguments);
};

const realConnect = net.Socket.prototype.connect;

/**
 * Normalise every form of Socket.connect into a destination we can check.
 *
 * Node accepts connect(options), connect(port, host) and connect(path) for IPC. Reading
 * only args[0].host, as an earlier version did, left the positional and IPC forms
 * unchecked, so a template could reach any host by calling net.connect(443, 'evil.com').
 * Anything we cannot positively identify is refused rather than passed through.
 */
function destinationOf(args) {
  const first = args[0];

  if (typeof first === 'object' && first !== null) {
    // IPC has no host to check and no legitimate use in a verification template.
    if (typeof first.path === 'string') return { kind: 'ipc', value: first.path };
    // A missing host defaults to localhost in Node, so treat it as such explicitly.
    return { kind: 'tcp', value: typeof first.host === 'string' ? first.host : 'localhost' };
  }

  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const second = args[1];
    return { kind: 'tcp', value: typeof second === 'string' ? second : 'localhost' };
  }

  if (typeof first === 'string') return { kind: 'ipc', value: first };

  return { kind: 'unknown', value: String(first) };
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const destination = destinationOf(args);

  if (destination.kind !== 'tcp') {
    throw new EgressBlocked(
      'connect blocked: ' + destination.kind + ' connections are not permitted (' +
        destination.value + ')',
    );
  }

  const host = destination.value;
  if (!allowedIps.has(host) && !allowedHosts.has(host)) {
    throw new EgressBlocked(
      'connect blocked to ' + host + '; allowlist=' + JSON.stringify([...allowedHosts]),
    );
  }

  return realConnect.apply(this, args);
};

// Hand control to the template only once the allowlist is resolved.
global.__sandboxReady = new Promise((resolve) => seedAllowedIps(resolve));
`;
