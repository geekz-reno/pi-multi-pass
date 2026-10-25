import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// Exercise the production functions directly without loading either host or
// touching real credentials. Only their host/network boundaries are mocked.
const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
function piece(start, end) {
  const first = source.indexOf(start);
  assert.notEqual(first, -1, `missing source boundary: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(last, -1, `missing source boundary: ${end}`);
  return source.slice(first, last);
}

function load(code, bindings, exports) {
  return new Function(
    ...Object.keys(bindings),
    `${stripTypeScriptTypes(code)}\nreturn ${exports};`,
  )(...Object.values(bindings));
}

const routingInsights = load(
  readFileSync(new URL("../lib/routing-insights.ts", import.meta.url), "utf8").replace(/^export\s+/gm, ""),
  {},
  "{ parseCooldownMs, addUsage, weightedNextMember }",
);

const tests = [];
function test(name, run) { tests.push({ name, run }); }

const { parseScheduleWindowInput: scheduleParser, promptForScheduleWindows } = load(
  piece("function parseScheduleWindowInput(", "function buildPoolConfig("),
  { ALL_DAYS: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  "{ parseScheduleWindowInput, promptForScheduleWindows }",
);

test("schedule input rejects the whole window when any component is invalid", () => {
  for (const input of ["9-9", "9-9 mon-fri", "9-17 mon-frii", "25-6 mon", "typo", "mon 9-9"]) {
    assert.equal(scheduleParser(input), null, input);
  }
  assert.deepEqual(scheduleParser("9-17 mon-fri"), { hours: [9, 17], days: ["mon", "tue", "wed", "thu", "fri"] });
  assert.deepEqual(scheduleParser("22-6"), { hours: [22, 6] });
  assert.deepEqual(scheduleParser("mon wed"), { days: ["mon", "wed"] });
  assert.deepEqual(scheduleParser("2026-10-01..2026-10-31"), { dateRange: { from: "2026-10-01", to: "2026-10-31" } });
});

test("invalid schedule prompts retry instead of configuring an always-active member", async () => {
  const inputs = ["9-9 mon-fri", "9-17 mon-frii", "9-17 mon-fri"];
  const notices = [];
  const windows = await promptForScheduleWindows({ ui: {
    input: async () => inputs.shift(),
    notify: (message) => notices.push(message),
  } }, "account");
  assert.deepEqual(windows, [{ hours: [9, 17], days: ["mon", "tue", "wed", "thu", "fri"] }]);
  assert.equal(notices.length, 2);
  assert.equal(await promptForScheduleWindows({ ui: { input: async () => undefined } }, "account"), undefined);
  assert.deepEqual(await promptForScheduleWindows({ ui: { input: async () => "  " } }, "account"), []);
});

test("canceling a schedule strategy edit preserves the existing pool and config", async () => {
  const pool = { name: "main", strategy: "custom", selectorScript: "select.js", members: ["account"] };
  const config = { pools: [pool] };
  const before = structuredClone(config);
  let saves = 0;
  const change = load(piece("async function changePoolStrategy(", "async function removePoolConfig("), {
    showWrappedSelect: async () => "scheduled",
    promptForScheduleWindows,
    saveGlobalConfig: () => { saves++; },
    reloadPoolManagerForCurrentProject: () => assert.fail("unexpected reload"),
  }, "changePoolStrategy");
  await change({ ui: { select: async () => "preferred", input: async () => undefined } }, {}, config, pool);
  assert.deepEqual(config, before);
  assert.equal(saves, 0);
});
function bounded(promise, ms = 300) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("regression check timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const poolCode = [
  piece("const RATE_LIMIT_PATTERNS", "function isTerminalOAuthRefreshError("),
  piece("const JS_DAY_TO_DOW:", "// ==========================================================================\n// Custom selector script loader"),
  piece("function classifyPoolMemberSkip(", "function formatChainEntryStatus("),
  piece("class PoolManager {", "// ==========================================================================\n// /subs command handlers"),
].join("\n");
const PoolManager = load(poolCode, {
  ...routingInsights,
  getAuthStorage: (ctx) => ctx.authStorage,
  getChainEntryIssue: () => null,
  summarizeTraceError: (error) => error,
  formatFailoverContinuation: () => "continuation",
  formatFailoverExhausted: () => "exhausted",
  formatFailoverStatus: () => "status",
  formatFailoverTransition: () => "transition",
  piWillRetryTurn: () => true,
  MAX_ROUTING_TRACE_ENTRIES: 100,
}, "PoolManager");

function poolFixture({ members = ["A", "B", "C"], strategy = "round-robin", missing = [], reject = [], throwing = [] } = {}) {
  const switches = [];
  const pool = { name: "main", baseProvider: "A", enabled: true, strategy, members };
  const models = new Map(["A", "B", "C", "D"].filter((name) => !missing.includes(name))
    .map((provider) => [provider, { provider, id: "model" }]));
  const manager = new PoolManager({
    async setModel(model) {
      switches.push(model.provider);
      if (throwing.includes(model.provider)) throw new Error("switch rejected");
      return !reject.includes(model.provider);
    },
  });
  manager.loadPools([pool]);
  const ctx = {
    authStorage: { hasAuth: () => true },
    modelRegistry: { find: (provider, id) => id === "model" ? models.get(provider) : undefined },
    ui: { notify() {}, setStatus() {} },
  };
  return {
    manager, pool, ctx, switches,
    config: { pools: [pool], chains: [] },
    fail() { return manager.handleError("429 rate limit", models.get("A"), ctx, "prompt", this.config, true); },
  };
}

for (const [name, options, expected] of [
  ["missing model", { missing: ["B"] }, ["C"]],
  ["rejected switch", { reject: ["B"] }, ["B", "C"]],
  ["throwing switch", { throwing: ["B"] }, ["B", "C"]],
]) {
  test(`failover continues after ${name}`, async () => {
    const fixture = poolFixture(options);
    assert.equal(await fixture.fail(), true);
    assert.deepEqual(fixture.switches, expected);
    assert.ok(fixture.manager.getCascadeStateSnapshot().attemptedProviders.includes("C"));
  });
}

test("failover reports exhaustion after all runtime candidates fail", async () => {
  const fixture = poolFixture({ reject: ["B"], throwing: ["C"] });
  assert.equal(await fixture.fail(), false);
  assert.deepEqual(fixture.switches, ["B", "C"]);
});

function inactiveSchedule(members) {
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const tomorrow = days[(new Date().getDay() + 1) % days.length];
  return Object.fromEntries(members.map((member) => [member, { role: "preferred", windows: [{ days: [tomorrow] }] }]));
}

for (const members of [["A", "B"], ["A", "B", "C"]]) {
  test(`scheduled failover excludes ${members.length - 1} inactive candidates`, async () => {
    const fixture = poolFixture({ members, strategy: "scheduled" });
    fixture.pool.memberSchedule = inactiveSchedule(members.slice(1));
    assert.equal(await fixture.fail(), false);
    assert.deepEqual(fixture.switches, []);
  });
}

test("an empty scheduled pool still reaches its fallback chain", async () => {
  const fixture = poolFixture({ members: ["A", "B"], strategy: "scheduled" });
  fixture.pool.memberSchedule = inactiveSchedule(["B"]);
  const backup = { name: "backup", baseProvider: "D", enabled: true, members: ["D"] };
  fixture.config.pools.push(backup);
  fixture.config.chains.push({ name: "chain", enabled: true, entries: [
    { pool: "main", model: "model", enabled: true },
    { pool: "backup", model: "model", enabled: true },
  ] });
  fixture.manager.loadPools(fixture.config.pools);
  assert.equal(await fixture.fail(), true);
  assert.deepEqual(fixture.switches, ["D"]);
});

test("keeper maintenance refreshes early without changing ordinary access skew", async () => {
  let refreshCalls = 0;
  const initial = { type: "oauth", access: "old", refresh: "refresh", expires: Date.now() + 10 * 60_000 };
  const stored = { anthropic: initial };
  const keeper = load(
    piece("function isOAuthEntry(", "/** Base provider") + piece("function keepFreshCredential(", "let tokenKeeperTimer"),
    {
      isOmp: false,
      ompAuth: undefined,
      refreshesInFlight: new Map(),
      withAuthFile: async (edit) => (await edit(stored)).value,
      AUTH_REFRESH_SKEW_MS: 60_000,
      TOKEN_REFRESH_TIMEOUT_MS: 25_000,
      getBuiltinOAuthFlow: () => ({ refresh: async () => {
        refreshCalls++;
        return { ...initial, access: "renewed", refresh: "rotated", expires: Date.now() + 3_600_000 };
      } }),
      asOAuthCredential: (value) => value,
    }, "keepFreshCredential",
  );
  assert.equal(await keeper("anthropic", "anthropic"), initial);
  assert.equal(refreshCalls, 0, "ordinary access reuses a usable credential");
  assert.equal((await keeper("anthropic", "anthropic", undefined, 15 * 60_000)).access, "renewed");
  assert.equal(stored.anthropic.refresh, "rotated", "rotated credentials are persisted");
  assert.equal(refreshCalls, 1);
  await keeper("anthropic", "anthropic", undefined, 15 * 60_000);
  assert.equal(refreshCalls, 1, "a second keeper reuses the newly stored credential");
});

test("the maintenance tick passes its early-refresh lead to the credential helper", async () => {
  const calls = [];
  const keeper = load(piece("let tokenKeeperTimer:", "interface QuotaAccount"), {
    isOmp: false,
    loadGlobalConfig: () => ({ tokenKeeper: true }),
    readAuthFile: () => ({ anthropic: { type: "oauth", access: "old", refresh: "refresh", expires: Date.now() + 10 * 60_000 } }),
    isOAuthEntry: (entry) => entry.type === "oauth",
    baseProviderForAccount: () => "anthropic",
    keepFreshCredential: async (...args) => { calls.push(args); },
    TOKEN_KEEPER_LEAD_MS: 15 * 60_000,
    TOKEN_KEEPER_INTERVAL_MS: 60_000,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
  }, "startTokenKeeper");
  keeper();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], 15 * 60_000);
});

test("expired Google quota credentials use host-owned persistent refresh", async () => {
  const calls = [];
  const resolve = load(piece("async function resolveGoogleQuotaAccess(", "async function fetchGoogleGeminiQuotaSnapshot("), {
    getGoogleProjectId: (_account, auth) => auth.projectId,
    asOAuthCredential: (value) => value,
    keepFreshCredential: async (...args) => {
      calls.push(args);
      return { access: "renewed", refresh: "rotated", expires: Date.now() + 3_600_000, projectId: "new-project" };
    },
    getBuiltinOAuthFlow() { throw new Error("Pi-only flow must not be used"); },
  }, "resolveGoogleQuotaAccess");
  const account = { providerName: "google-gemini-cli-2", baseProvider: "google-gemini-cli" };
  assert.deepEqual(await resolve(account, { type: "oauth", access: "expired", refresh: "refresh", expires: 0, projectId: "old-project" }), {
    accessToken: "renewed", projectId: "new-project",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], account.providerName);
  assert.equal(calls[0][1], account.baseProvider);
  assert.equal(calls[0][2].projectId, "old-project");
  const fresh = { type: "oauth", access: "fresh", refresh: "refresh", expires: Date.now() + 3_600_000, projectId: "fresh-project" };
  assert.deepEqual(await resolve(account, fresh), { accessToken: "fresh", projectId: "fresh-project" });
  assert.equal(calls.length, 1);
});

for (const allowedProviderNames of [undefined, ["openai-codex-2"]]) {
  test(`preset choices include native providers${allowedProviderNames ? " and respect project restrictions" : " without extras"}`, async () => {
    let offered;
    const subscriptions = allowedProviderNames ? [{ provider: "openai-codex", index: 2 }] : [];
    const effective = { subscriptions, pools: [], chains: [], presets: [], allowedProviderNames };
    const create = load(piece("async function handlePresetCreate(", "async function handlePresetList("), {
      isOmp: true,
      loadGlobalConfig: () => ({ subscriptions, presets: [] }),
      loadEffectiveConfig: () => effective,
      parseEnvConfig: () => [],
      normalizeEntries: (entries) => entries,
      mergeConfigs: (config) => config.subscriptions,
      builtinProviders: () => [],
      subProviderName: (entry) => `${entry.provider}-${entry.index}`,
      PROVIDER_TEMPLATES: { "openai-codex": { displayName: "Codex" } },
      subDisplayName: (entry) => `Codex #${entry.index}`,
      getAuthStorage: () => ({ hasAuth: () => true }),
    }, "handlePresetCreate");
    await create({
      cwd: "/test-project",
      modelRegistry: { getAll: () => [
        { provider: "openai-codex", id: "model" },
        { provider: "openai-codex", id: "other-model" },
        ...(subscriptions.length ? [{ provider: "openai-codex-2", id: "model" }] : []),
      ] },
      ui: { input: async () => "preset", select: async (_title, options) => { offered = options; return undefined; } },
    });
    const providers = offered.filter((option) => option.includes(" -- ")).map((option) => option.split(" -- ")[0]);
    assert.deepEqual(providers, allowedProviderNames || ["openai-codex"]);
  });
}

test("a native OMP provider can be selected and saved in a preset", async () => {
  const config = { subscriptions: [], presets: [] };
  const native = { provider: "openai-codex", id: "native-model" };
  let saved;
  let picks = 0;
  const create = load(piece("async function handlePresetCreate(", "async function handlePresetList("), {
    isOmp: true,
    loadGlobalConfig: () => config,
    loadEffectiveConfig: () => config,
    parseEnvConfig: () => [],
    normalizeEntries: (entries) => entries,
    mergeConfigs: (value) => value.subscriptions,
    builtinProviders: () => [],
    subProviderName: (entry) => `${entry.provider}-${entry.index}`,
    PROVIDER_TEMPLATES: {},
    subDisplayName: () => "unused",
    providerModelChoices: (ctx, provider) => ctx.modelRegistry.getAll().filter((model) => model.provider === provider),
    formatPresetEntryWith: (entry) => `${entry.provider}/${entry.model}`,
    saveGlobalConfig: (value) => { saved = value; },
    getBaseProvider() { throw new Error("preset selection should use the native registry"); },
  }, "handlePresetCreate");
  await create({
    cwd: "/test-project",
    modelRegistry: { getAll: () => [native] },
    ui: {
      input: async () => "native-preset",
      select: async (title, options) => title.startsWith("Model for")
        ? options[0]
        : picks++ === 0 ? options.find((option) => option.startsWith("openai-codex --")) : "[Done - save preset]",
      notify() {},
    },
  });
  assert.deepEqual(saved.presets[0], {
    name: "native-preset", enabled: true,
    entries: [{ provider: native.provider, model: native.id, enabled: true }],
  });
});

const quotaCode = piece("async function runQuotaChecks(", "async function loadQuotaResults(");
function quotaFixture(checkers) {
  return load(quotaCode, {
    PROVIDER_QUOTA_CHECKERS: checkers,
    QUOTA_CHECK_TIMEOUT_MS: 20,
    compareQuotaResults: (left, right) => right.score - left.score,
  }, "runQuotaChecks");
}
const quotaAccount = (name) => ({ providerName: name, baseProvider: name, displayName: name });
const quotaReady = (account) => ({ account, kind: "ready", summary: "ready", details: [], score: 50 });

test("quota deadlines retain ready accounts and isolate failed or stalled accounts", async () => {
  let observedSignal;
  let resolveLate;
  const run = quotaFixture([
    { baseProvider: "fast", check: async (account) => quotaReady(account) },
    { baseProvider: "stalled", check: (_account, signal) => {
      observedSignal = signal;
      return new Promise((resolve) => { resolveLate = resolve; });
    } },
    { baseProvider: "failed", check() { throw new Error("checker failed"); } },
  ]);
  const results = await bounded(run(["fast", "stalled", "failed"].map(quotaAccount)));
  assert.equal(results.find((result) => result.account.providerName === "fast").kind, "ready");
  for (const provider of ["stalled", "failed"]) {
    assert.equal(results.find((result) => result.account.providerName === provider).kind, "error");
  }
  assert.equal(observedSignal.aborted, true);
  resolveLate(quotaReady(quotaAccount("stalled")));
  await Promise.resolve();
  assert.equal(results.find((result) => result.account.providerName === "stalled").kind, "error", "a late checker cannot replace its timeout result");
});

test("caller cancellation bounds quota checkers that ignore signals", async () => {
  let calls = 0;
  const run = quotaFixture([{ baseProvider: "stalled", check: () => { calls++; return new Promise(() => {}); } }]);
  const controller = new AbortController();
  const pending = run([quotaAccount("stalled")], controller.signal);
  await Promise.resolve();
  controller.abort(new Error("cancelled"));
  assert.equal((await bounded(pending))[0].kind, "error");
  const before = calls;
  assert.equal((await bounded(run([quotaAccount("stalled")], controller.signal)))[0].kind, "error");
  assert.equal(calls, before, "already-cancelled checks do not start new work");
});

test("a timed-out widget refresh releases its lock and the next refresh recovers", async () => {
  let recovered = false;
  let calls = 0;
  const accounts = [quotaAccount("quota")];
  const code = `let statusBarRefreshInFlight; let statusBarAccounts = []; const statusBarQuota = new Map(); let statusBarQuotaFetchedAt = 0;\n${quotaCode}\n${piece("function sameQuotaAccounts(", "function updateStatusBarQuota(")}\n${piece("function refreshStatusBarQuota(", "function shortenPathForStatusBar(")}`;
  const widget = load(code, {
    statusBarAccountsFrom: () => [],
    collectStatusBarAccounts: () => [],
    collectQuotaAccounts: () => accounts,
    PROVIDER_QUOTA_CHECKERS: [{ baseProvider: "quota", check: async (account) => {
      calls++;
      return recovered ? quotaReady(account) : new Promise(() => {});
    } }],
    QUOTA_CHECK_TIMEOUT_MS: 20,
    compareQuotaResults: (left, right) => right.score - left.score,
  }, "({ refreshStatusBarQuota, snapshot: () => ({ inFlight: Boolean(statusBarRefreshInFlight), quota: [...statusBarQuota.values()] }) })");
  await bounded(new Promise((resolve) => widget.refreshStatusBarQuota({}, resolve)));
  assert.equal(widget.snapshot().inFlight, false);
  assert.equal(widget.snapshot().quota[0].kind, "error");
  recovered = true;
  await bounded(new Promise((resolve) => widget.refreshStatusBarQuota({}, resolve)));
  assert.equal(widget.snapshot().inFlight, false);
  assert.equal(widget.snapshot().quota[0].kind, "ready");
  assert.equal(calls, 2);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}
assert.equal(failures, 0, `${failures}/${tests.length} review regressions failed`);
console.log(`Review regressions passed: ${tests.length} checks against production source`);
