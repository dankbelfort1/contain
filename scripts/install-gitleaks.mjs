/**
 * Downloads the gitleaks binary into bin/.
 *
 * The version is pinned rather than tracking latest. Scan results are part of what
 * this project reproduces, and a scanner that silently changes underneath us would
 * make one run's findings incomparable with the next.
 *
 * The download is checked against the checksums file published with the release, so a
 * truncated or tampered download fails loudly instead of installing quietly.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const VERSION = "8.30.1";
const BASE = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}`;

/** Maps Node's platform/arch onto the release asset naming. */
function assetName() {
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);

  switch (process.platform) {
    case "win32":
      return `gitleaks_${VERSION}_windows_${arch}.zip`;
    case "darwin":
      return `gitleaks_${VERSION}_darwin_${arch}.tar.gz`;
    case "linux":
      return `gitleaks_${VERSION}_linux_${arch}.tar.gz`;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function expectedChecksum(asset) {
  const text = (await download(`${BASE}/gitleaks_${VERSION}_checksums.txt`)).toString("utf8");
  const line = text.split("\n").find((l) => l.trim().endsWith(asset));
  if (!line) throw new Error(`No checksum published for ${asset}`);
  return line.trim().split(/\s+/)[0];
}

/**
 * Unpack the release archive.
 *
 * Windows gets PowerShell rather than tar: Windows 10+ does ship a bsdtar that reads
 * zip, but a `tar` resolved from PATH may well be the GNU tar that Git for Windows
 * installs, and GNU tar cannot read a zip at all.
 */
function extract(asset, cwd) {
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${asset}' -DestinationPath '.' -Force`,
      ],
      { cwd, stdio: "inherit" },
    );
    return;
  }
  execFileSync("tar", ["-xf", asset], { cwd, stdio: "inherit" });
}

async function main() {
  const binDir = "bin";
  const binary = join(binDir, process.platform === "win32" ? "gitleaks.exe" : "gitleaks");

  if (existsSync(binary)) {
    const installed = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
    if (installed === VERSION) {
      console.log(`gitleaks ${VERSION} already present at ${binary}`);
      return;
    }
    console.log(`Replacing gitleaks ${installed} with ${VERSION}`);
  }

  const asset = assetName();
  console.log(`Downloading ${asset}`);
  const [archive, wanted] = await Promise.all([download(`${BASE}/${asset}`), expectedChecksum(asset)]);

  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== wanted) {
    throw new Error(`Checksum mismatch for ${asset}\n  expected ${wanted}\n  got      ${actual}`);
  }
  console.log("Checksum verified");

  mkdirSync(binDir, { recursive: true });
  const archivePath = join(binDir, asset);
  writeFileSync(archivePath, archive);
  try {
    extract(asset, binDir);
  } finally {
    rmSync(archivePath, { force: true });
  }

  const version = execFileSync(binary, ["version"], { encoding: "utf8" }).trim();
  console.log(`Installed gitleaks ${version} at ${binary}`);
}

await main();
