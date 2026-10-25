import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../lib/routing-insights.ts", import.meta.url), "utf8");
const { validateRoutingConfig, parseCooldownMs, addUsage, weightedNextMember } = new Function(
  stripTypeScriptTypes(source).replace(/^export\s+/gm, "") + "\nreturn {validateRoutingConfig,parseCooldownMs,addUsage,weightedNextMember};",
)();

const now = Date.parse("2026-10-25T00:00:00Z");
for (const [error, expected] of [
  ["429 rate limited\nRetry-After: 120", 120_000],
  ["Retry-After: Sun, 25 Oct 2026 00:02:00 GMT", 120_000],
  ['{"retry_after": 2.5}', 2_500],
  ['{"retryAfter":"15"}', 15_000],
  ['{"reset_at":1792886520}', 120_000],
  ['{"resets_at":"2026-10-25T00:02:00Z"}', 120_000],
  ["rate limit; retry in 2m30s", 150_000],
  ["Please try again after 1 hour 5 minutes", 3_900_000],
  ["retry in 2 minutes and 30 seconds", 150_000],
  ["retry in 2m30s then a separate quota resets in 1h", 150_000],
  ["retry in 2500ms", 2_500],
  ["retry after 30", 30_000],
  ["Retry-After: 0", 1_000],
  ["Retry-After: nonsense", 300_000],
  ['{"reset_at": 1}', 300_000],
]) assert.equal(parseCooldownMs(error, now), expected, error);
assert.equal(parseCooldownMs("Retry-After: 10", now, 300_000, now / 1000 + 3600), 3_600_000, "a known later reset is not shortened");
assert.equal(parseCooldownMs("", now, 300_000, now / 1000 + 30 * 86400), 30 * 86400_000, "30-day quotas are not capped to one week");
assert.equal(parseCooldownMs("", now, Infinity), 300_000);
assert.equal(parseCooldownMs("", now, -1), 1_000);
assert.equal(parseCooldownMs("", now, 100 * 86400_000), 7 * 86400_000);

const catalog = { knownProviders: ["openai-codex", "anthropic"], modelsByProvider: { "openai-codex": ["model-a"], anthropic: ["model-b"] } };
const valid = {
  subscriptions: [{ provider: "openai-codex", index: 2, label: "work" }],
  pools: [{ name: "work", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2"], enabled: true, strategy: "weighted", memberWeights: { "openai-codex": 1, "openai-codex-2": 2 }, memberSchedule: { "openai-codex": { role: "preferred", windows: [{ hours: [22, 6], days: ["sun"], dateRange: { from: "2026-10-01", to: "2026-10-31" } }] } } }],
  chains: [{ name: "fallback", entries: [{ pool: "work", model: "model-a", enabled: true }], enabled: true }],
  presets: [{ name: "coding", entries: [{ provider: "openai-codex-2", model: "model-a" }] }],
};
assert.deepEqual(validateRoutingConfig(valid, catalog), []);
assert.deepEqual(validateRoutingConfig(valid, { ...catalog, knownProviders: [...catalog.knownProviders, "openai-codex-2"] }), [], "registered extra accounts are not mistaken for duplicate definitions");
assert.deepEqual(validateRoutingConfig({ pools: valid.pools }, { ...catalog, project: true, knownProviders: [...catalog.knownProviders, "openai-codex-2"] }), [], "project pools recognize registered account aliases");
assert.deepEqual(validateRoutingConfig({}, catalog), [], "omitted legacy optional fields remain valid");
assert.deepEqual(validateRoutingConfig({ subscriptions: [{ provider: "openai-codex", index: 0 }] }, catalog), [], "automatic legacy subscription numbering remains valid");
assert.deepEqual(validateRoutingConfig({ allowedSubs: ["openai-codex"], chains: [{ name: "local", entries: [{ pool: "inherited", model: "model-a" }] }] }, { ...catalog, project: true, inheritedPools: [{ name: "inherited", baseProvider: "openai-codex", members: ["openai-codex"] }] }), []);
assert.ok(validateRoutingConfig(null).some((issue) => issue.path === "$"));
assert.ok(validateRoutingConfig({ pools: "bad", allowedSubs: 1 }).every((issue) => issue.level === "error"));
const broken = structuredClone(valid);
broken.subscriptions.push({ provider: "unknown", index: -1, label: false });
broken.pools[0].members.push("missing", "anthropic", "openai-codex");
broken.pools[0].memberWeights["openai-codex"] = 0;
broken.pools[0].memberSchedule.missing = { role: "invalid", windows: [{ hours: [25, 6], days: ["someday"], dateRange: { from: "2026-02-31", to: "2026-01-01" } }] };
broken.chains[0].entries.push({ pool: "gone", model: "model-z" }, { pool: "work", model: "missing-model" });
const issues = validateRoutingConfig(broken, catalog);
for (const path of ["subscriptions[1].provider", "subscriptions[1].index", "subscriptions[1].label", "pools[0].members[2]", "pools[0].members[3]", "pools[0].members[4]", "pools[0].memberWeights.openai-codex", "pools[0].memberSchedule.missing.role", "pools[0].memberSchedule.missing.windows[0].hours", "pools[0].memberSchedule.missing.windows[0].days", "pools[0].memberSchedule.missing.windows[0].dateRange.from", "chains[0].entries[1].pool", "chains[0].entries[2].model"]) assert.ok(issues.some((issue) => issue.path === path), path);
assert.ok(validateRoutingConfig({ allowedSubs: [] }, catalog).some((issue) => issue.level === "warning"));
assert.ok(validateRoutingConfig({ pools: [{ name: "p", baseProvider: "openai-codex", members: ["openai-codex"], memberWeights: { "openai-codex": NaN } }] }, catalog).some((issue) => issue.path.endsWith("memberWeights.openai-codex")));

const first = addUsage(undefined, { input: 10, output: 4, cacheRead: 20, cacheWrite: 5, totalTokens: 39 });
assert.deepEqual(first, { requests: 1, inputTokens: 35, outputTokens: 4, totalTokens: 39 });
assert.deepEqual(addUsage(first, { inputTokens: 3, outputTokens: 2, cacheRead: 100 }), { requests: 2, inputTokens: 38, outputTokens: 6, totalTokens: 44 }, "explicit input totals are not double-counted with cache hits");
assert.deepEqual(addUsage(undefined, { input: -4, output: Infinity, totalTokens: NaN }), { requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
assert.deepEqual(addUsage(undefined, { input_tokens: 12, output_tokens: 3, total_tokens: 1 }), { requests: 1, inputTokens: 12, outputTokens: 3, totalTokens: 15 });

const members = ["A", "B", "C"];
assert.equal(weightedNextMember(members, "A", members, {}, {}), "B", "equal scores break in round-robin order");
assert.equal(weightedNextMember(members, "C", ["A", "B"], {}, {}), "A");
assert.equal(weightedNextMember(members, "missing", members, {}, {}), "A");
assert.equal(weightedNextMember(members, "A", ["A"], {}, {}), "A", "weighted allocation may keep the current account");
assert.equal(weightedNextMember(members, "A", ["B"], { B: 0 }, {}), undefined, "zero weights are rejected");
assert.equal(weightedNextMember(members, "A", ["B"], { B: Infinity }, {}), undefined);
assert.equal(weightedNextMember(members, "A", ["B"], { B: Number.MIN_VALUE }, { B: { requests: 10 } }), "B");
assert.equal(weightedNextMember(members, "A", [], {}, {}), undefined);
const usage = {};
let current = "A";
for (let index = 0; index < 600; index++) {
  current = weightedNextMember(["A", "B"], current, ["A", "B"], { A: 1, B: 2 }, usage);
  usage[current] = addUsage(usage[current], { input: 10 });
}
assert.equal(usage.A.requests, 200);
assert.equal(usage.B.requests, 400);
console.log("Routing insights passed: config diagnostics, reset hints, usage accounting, weighted fairness");
