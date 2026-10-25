import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
	fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url)),
	"utf8",
);

assert.match(source, /if \(isAbsolute\(scriptPath\)\) return scriptPath;/);
// The import URL must derive from the validated resolved path (mtime query busts the module cache for edited selectors).
assert.match(source, /import\(`\$\{pathToFileURL\(resolved\)\.href\}\?mtime=\$\{mtimeMs\}`\)/);
assert.match(source, /function saveJsonConfig\(path: string, config: unknown\): void/);
assert.match(source, /copyFileSync\(path, backupPath\)/);
assert.match(source, /renameSync\(temporaryPath, path\)/);
assert.doesNotMatch(source, /writeFileSync\(path, JSON\.stringify\(config/);

console.log("hardening checks passed");
