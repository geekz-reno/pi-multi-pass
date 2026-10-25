import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "extensions", "multi-sub.ts"), "utf8");

// Rotated credentials are written inside the same lock that produced them.
assert.match(source, /const run = withAuthFile\(async \(stored\) => \{/);
assert.match(source, /stored\[account\] = \{ \.\.\.current, \.\.\.refreshed, type: "oauth" \};\n\t\treturn \{ value: refreshed, changed: true \};/);

// A token another process already rotated is reused instead of refreshed again.
// (The skew became a parameter when the token keeper started passing its own
// early-refresh lead; the builtin flow keeps AUTH_REFRESH_SKEW_MS.)
assert.match(
	source,
	/if \(isOAuthEntry\(current\) && current\.expires > Date\.now\(\) \+ refreshSkewMs\) \{/,
);

// The refresh deadline is the extension's own, not pi's 15s request deadline.
assert.match(source, /AbortSignal\.timeout\(TOKEN_REFRESH_TIMEOUT_MS\)/);
assert.ok(/TOKEN_REFRESH_TIMEOUT_MS = 25_000/.test(source));

// Opt-in only: without the config flag nothing changes for other setups.
assert.match(source, /function isTokenKeeperEnabled\(\): boolean \{\n\treturn !isOmp && loadGlobalConfig\(\)\.tokenKeeper === true;/);
assert.match(source, /tokenKeeper: parsed\.tokenKeeper === true,/);
assert.match(source, /if \(isOmp \|\| tokenKeeperTimer \|\| !isTokenKeeperEnabled\(\)\) return;/);
assert.match(
	source,
	/isTokenKeeperEnabled\(\)\n\t\t\t\t\? keepFreshCredential\(name, entry\.provider, credentials\)\n\t\t\t\t: defaultRefresh\(credentials, signal\);/,
);

// Built-in logins are renewed ahead of pi's own five-minute window.
assert.match(source, /if \(credential\.expires > Date\.now\(\) \+ TOKEN_KEEPER_LEAD_MS\) continue;/);
assert.match(source, /tokenKeeperTimer = setInterval\(\(\) => void tick\(\), TOKEN_KEEPER_INTERVAL_MS\);/);
assert.match(source, /tokenKeeperTimer\.unref\?\.\(\);/);
assert.match(source, /export default function multiSub\(pi: ExtensionAPI\) \{\n\tstartTokenKeeper\(\);/);

// auth.json stays behind one locked read-modify-write helper.
assert.equal(source.match(/lockfile\.lock\(/g)?.length, 1);
assert.match(source, /async function importShareBundle\(bundle: ShareBundle\): Promise<string\[\]> \{\n\tvalidateBundle\(bundle\);\n\treturn withAuthFile\(/);

// A session with the keeper enabled starts clean and leaves tokens that are
// nowhere near expiry alone.
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-keeper-"));
try {
	writeFileSync(
		join(agentDir, "multi-pass.json"),
		JSON.stringify({
			subscriptions: [{ provider: "openai-codex", index: 2 }],
			pools: [],
			chains: [],
			presets: [],
			tokenKeeper: true,
		}),
	);
	const authPath = join(agentDir, "auth.json");
	const credential = {
		"openai-codex-2": {
			type: "oauth",
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 24 * 60 * 60 * 1000,
		},
	};
	writeFileSync(authPath, JSON.stringify(credential));

	const result = spawnSync(
		"pi",
		[
			"--mode", "rpc",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension", join(root, "extensions", "multi-sub.ts"),
		],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"keeper","type":"prompt","message":"/subs status"}\n',
			encoding: "utf8",
			timeout: 15_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);
	assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), credential);
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}

console.log("token keeper checks passed");
