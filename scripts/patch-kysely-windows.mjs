/**
 * Makes TrueForge startable on Windows.
 *
 * TrueForge loads its migrations through Kysely's FileMigrationProvider, which calls
 * `await import(filePath)` with an absolute path. Node's ESM loader rejects that on
 * Windows, because it reads the drive letter as a URL scheme:
 *
 *   Only URLs with a scheme in: file, data, and node are supported by the default ESM
 *   loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'e:'
 *
 * The fix is one call to pathToFileURL. It belongs upstream in Kysely, so this patches
 * node_modules rather than pretending it is our code. Idempotent, and a no-op anywhere
 * the file is already correct or absent.
 *
 * Not needed on macOS or Linux, where the same code path works as written.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const TARGET = "node_modules/kysely/dist/migration/file-migration-provider.js";

const IMPORT_LINE = "import { isFunction, isObject } from '../util/object-utils.js';";
const BAD = "await import(/* webpackIgnore: true */ filePath)";
const GOOD = "await import(/* webpackIgnore: true */ pathToFileURL(filePath).href)";

if (!existsSync(TARGET)) {
  console.log("kysely not installed; nothing to patch");
  process.exit(0);
}

const source = await readFile(TARGET, "utf8");

if (source.includes("pathToFileURL")) {
  console.log("kysely already patched for Windows paths");
  process.exit(0);
}

if (!source.includes(BAD)) {
  // Kysely changed. Say so rather than silently doing nothing, because a silent no-op
  // here shows up later as a confusing startup failure.
  console.warn(
    `${TARGET} does not contain the expected import call. ` +
      "Kysely may have fixed this upstream, or changed shape. Check before assuming it works.",
  );
  process.exit(0);
}

const patched = source
  .replace(IMPORT_LINE, `${IMPORT_LINE}\nimport { pathToFileURL } from 'node:url';`)
  .replace(BAD, GOOD);

await writeFile(TARGET, patched, "utf8");
console.log("patched kysely to import migrations via file:// URLs");
