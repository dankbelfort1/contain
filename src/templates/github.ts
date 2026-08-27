/**
 * Read-only verification for GitHub credentials.
 *
 * One GET against /user answers everything we need:
 *   - 200 means the credential authenticates, so it is LIVE
 *   - 401 means the provider rejected it, so it is DEAD
 *   - anything else is UNKNOWN, and a human decides
 *
 * The same response carries the blast radius. The X-OAuth-Scopes header lists what the
 * credential is permitted to do, and the body reports how much the account owns. No
 * second call, and nothing that writes.
 */
import type { VerificationTemplate } from "./types.js";

const SOURCE = String.raw`
'use strict';

exports.run = async (params) => {
  // Refresh tokens are not bearer credentials for the REST API. They would return 401
  // here whether or not they are still usable, and reporting that as DEAD would leave
  // a working credential in place.
  if (String(params.token).startsWith('ghr_')) {
    return {
      status: 'UNKNOWN',
      capabilities: [],
      facts: { tokenKind: 'refresh' },
      reason: 'GitHub App refresh token. It cannot be tested against /user, so this needs checking by hand.',
    };
  }

  const response = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + params.token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub rejects requests without a user agent.
      'user-agent': 'contain-verifier',
    },
  });

  if (response.status === 401) {
    return { status: 'DEAD', httpStatus: 401, capabilities: [], facts: {} };
  }

  if (response.status !== 200) {
    // Rate limiting, an outage, or a network fault. Not evidence either way, so we
    // say so rather than guessing - a wrong DEAD would leave a live key in place.
    return { status: 'UNKNOWN', httpStatus: response.status, capabilities: [], facts: {} };
  }

  // Absent for fine-grained tokens, which do not report scopes this way.
  const scopeHeader = response.headers.get('x-oauth-scopes') || '';
  const capabilities = scopeHeader.split(',').map((s) => s.trim()).filter(Boolean);

  const body = await response.json();

  return {
    status: 'LIVE',
    httpStatus: 200,
    principal: body.login,
    capabilities,
    facts: {
      accountType: body.type,
      siteAdmin: body.site_admin === true,
      publicRepos: body.public_repos,
      totalPrivateRepos: body.total_private_repos,
      ownedPrivateRepos: body.owned_private_repos,
      collaborators: body.collaborators,
      plan: body.plan ? body.plan.name : null,
      twoFactorEnabled: body.two_factor_authentication,
      accountCreated: body.created_at,
      tokenKind: String(params.token).startsWith('github_pat_') ? 'fine-grained' : 'classic',
    },
  };
};
`;

export const githubTemplate: VerificationTemplate = {
  id: "github.user.v1",
  provider: "github",
  description: "Reads GET /user to establish whether a GitHub credential authenticates, and what it can reach.",
  allowHosts: ["api.github.com"],
  timeoutMs: 20_000,
  source: SOURCE,
};
