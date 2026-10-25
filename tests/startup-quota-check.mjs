import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "multi-pass-startup-quota-"));
const underTest = join(root, "tests", `.startup-quota-source-${process.pid}.ts`);
const fixture = join(root, "tests", `.startup-quota-probe-${process.pid}.ts`);
try {
  const agentDir = join(sandbox, "agent");
  const project = join(sandbox, "project");
  mkdirSync(agentDir); mkdirSync(join(project, ".omp"), { recursive: true });
  writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
    subscriptions: [{ provider: "openai-codex", index: 2 }, { provider: "openai-codex", index: 3 }],
    pools: [{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2", "openai-codex-3"], enabled: true, strategy: "quota-first" }],
    chains: [], presets: [], tokenKeeper: false,
  }));
  writeFileSync(underTest, readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8") + "\nexport { PoolManager };\n");
  writeFileSync(fixture, `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import multiSub, { PoolManager } from ${JSON.stringify(`./.startup-quota-source-${process.pid}.ts`)};
import { ompAuth } from "../lib/host.ts";
export default async function probe(pi) {
  const members = ["openai-codex", "openai-codex-2", "openai-codex-3"];
  const credential = provider => ({ type: "oauth", access: "dummy-" + provider, refresh: "dummy-refresh", expires: Date.now() + 86400000 });
  for (const provider of members.slice(0, 2)) await ompAuth.credentials.set(provider, credential(provider));
  let current, rejectSwitch = false;
  const events = new Map(), calls = [], switches = [];
  let remaining = new Map([[members[0], [50, 90]], [members[1], [100, 100]], [members[2], [100, 100]]]);
  const quotaFetch = async (url, options) => {
    assert.ok(String(url).endsWith("/wham/usage"));
    const provider = new Headers(options.headers).get("Authorization").replace("Bearer dummy-", "");
    calls.push(provider);
    const values = remaining.get(provider);
    return new Response(JSON.stringify({ rate_limit: {
      primary_window: values ? { used_percent: 100 - values[0], limit_window_seconds: 18000 } : null,
      secondary_window: values ? { used_percent: 100 - values[1], limit_window_seconds: 604800 } : null,
    } }), { headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = quotaFetch;
  const wrapped = new Proxy(pi, { get(target, key) {
    if (key === "on") return (event, handler) => { const handlers = events.get(event) || []; handlers.push(handler); events.set(event, handlers); };
    if (key === "setModel") return async model => { await Promise.resolve(); if (rejectSwitch) return false; current = model; switches.push(model); return true; };
    if (key === "sendUserMessage") return () => { throw new Error("startup must not replay a prompt"); };
    return target[key];
  }});
  multiSub(wrapped);
  pi.on("session_start", async (_event, realCtx) => {
    const base = realCtx.modelRegistry.getAll().find(model => model.provider === members[0]);
    assert.ok(base);
    current = base;
    const ui = { ...realCtx.ui, notify() {}, setStatus() {} };
    const ctx = new Proxy(realCtx, { get(target, key) {
      if (key === "model") return current;
      if (key === "hasUI") return false;
      if (key === "ui") return ui;
      return target[key];
    } });
    const emit = async (event, data = {}) => { for (const handler of events.get(event) || []) await handler(data, ctx); };
    const fresh = (strategy = "quota-first", enabled = true) => {
      current = base; calls.length = 0;
      const manager = new PoolManager(wrapped);
      manager.loadPools([{ name: "codex", baseProvider: members[0], members, enabled, strategy }]);
      return manager;
    };
    // Actual extension startup hook, with two authenticated accounts.
    await emit("session_start");
    assert.equal(current.provider, members[1], "startup chooses 100% over the current account's 50%");
    assert.equal(current.id, base.id, "startup preserves the model ID");
    assert.deepEqual(calls.sort(), members.slice(0, 2));
    remaining.set(members[0], [100, 100]); remaining.set(members[1], [10, 10]);
    await emit("before_agent_start", { prompt: "first prompt" });
    await emit("before_agent_start", { prompt: "second prompt" });
    assert.equal(current.provider, members[1], "startup selection stays sticky across prompts");
    assert.equal(calls.length, 2, "no new quota calls before each prompt");
    await emit("session_start");
    assert.equal(current.provider, members[0], "a new session checks quotas again");
    // Compare all windows; ties and failed lookups retain the current account.
    remaining.set(members[0], [50, 90]); remaining.set(members[1], [100, 20]);
    await fresh().selectStartupMember(ctx);
    assert.equal(current.provider, members[0], "the weekly bottleneck matters alongside the 5h window");
    remaining.set(members[0], [80, 80]); remaining.set(members[1], [80, 80]);
    await fresh().selectStartupMember(ctx);
    assert.equal(current.provider, members[0], "ties retain the current account");
    remaining.set(members[0], [0, 0]); remaining.set(members[1], [0, 0]);
    await fresh().selectStartupMember(ctx);
    assert.equal(current.provider, members[0], "zero quota is not a reason to switch accounts at startup");
    remaining.clear();
    await fresh().selectStartupMember(ctx);
    assert.equal(current.provider, members[0], "missing quota data retains the current account");
    for (const strategy of ["round-robin", "per-turn", "scheduled", "custom"]) {
      await fresh(strategy).selectStartupMember(ctx);
      assert.equal(calls.length, 0, strategy + " does not run the startup quota check");
    }
    await fresh("quota-first", false).selectStartupMember(ctx);
    assert.equal(calls.length, 0, "disabled pools do not check quota");
    remaining.set(members[0], [50, 90]); remaining.set(members[1], [100, 100]);
    const missingModel = fresh();
    const registry = new Proxy(realCtx.modelRegistry, { get(target, key) {
      if (key === "find") return (provider, id) => provider === members[1] ? undefined : target.find(provider, id);
      return Reflect.get(target, key, target);
    } });
    const missingCtx = new Proxy(ctx, { get(target, key) { return key === "modelRegistry" ? registry : target[key]; } });
    await missingModel.selectStartupMember(missingCtx);
    assert.equal(current.provider, members[0]);
    assert.deepEqual(calls, [members[0]], "accounts missing the selected model are not queried");
    const rejected = fresh(); rejectSwitch = true;
    try { await rejected.selectStartupMember(ctx); } finally { rejectSwitch = false; }
    assert.equal(current.provider, members[0], "a rejected model switch leaves the current account active");
    const cooling = fresh(); cooling.markExhausted(members[1]);
    await cooling.selectStartupMember(ctx);
    assert.equal(current.provider, members[0]);
    assert.deepEqual(calls, [members[0]], "accounts in rate-limit cooldown are not queried");
    const deferred = fresh(); current = undefined;
    await deferred.selectStartupMember(ctx);
    assert.equal(calls.length, 0);
    current = base;
    await deferred.selectStartupMember(ctx);
    assert.equal(current.provider, members[1], "startup defers until the host supplies a model");
    // A user model change during the check must not be overwritten by stale results.
    const stale = fresh(); let release;
    // Both requests need the same release gate.
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async (...args) => { await gate; return quotaFetch(...args); };
    const selecting = stale.selectStartupMember(ctx);
    current = { ...base, id: "user-selected-another-model" };
    release(); await selecting;
    assert.equal(current.id, "user-selected-another-model");
    globalThis.fetch = quotaFetch;
    // Startup is bounded even when a quota endpoint stalls.
    const stalled = fresh(); const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ms => { assert.equal(ms, 3000); return realTimeout.call(AbortSignal, 1); };
    // Intentionally ignore the signal, as a nested OAuth refresh may do.
    globalThis.fetch = async () => new Promise(() => {});
    try { await stalled.selectStartupMember(ctx); }
    finally { AbortSignal.timeout = realTimeout; globalThis.fetch = quotaFetch; }
    assert.equal(current.provider, members[0], "timeout keeps the current account usable");
    // Project restrictions are applied before startup selection.
    current = base; calls.length = 0;
    writeFileSync(ctx.cwd + "/.omp/multi-pass.json", JSON.stringify({ allowedSubs: [members[0]] }));
    await emit("session_start");
    assert.equal(current.provider, members[0]);
    assert.deepEqual(calls, [members[0]]);
    process.stdout.write(JSON.stringify({ type: "startup_quota_test", success: true }) + "\\n");
  });
}
`);
  const result = spawnSync("omp", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "-e", fixture], {
    cwd: project,
    env: { ...process.env, PI_CONFIG_DIR: relative(homedir(), join(sandbox, "config")), PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", MULTI_SUB: "", OPENAI_API_KEY: "dummy-offline-key" },
    input: '{"id":"commands","type":"get_available_commands"}\n', encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Failed to load extension/, result.stderr);
  const output = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(!output.some(event => event.type === "extension_error"), JSON.stringify(output.filter(event => event.type === "extension_error")));
  assert.ok(output.some(event => event.type === "startup_quota_test" && event.success), result.stdout + result.stderr);
  // Exercise real host setModel during actual startup, using isolated dummy
  // credentials and mocked usage endpoints. No prompt/model request is sent.
  const realAgentDir = join(sandbox, "real-agent"); mkdirSync(realAgentDir);
  writeFileSync(join(realAgentDir, "multi-pass.json"), readFileSync(join(agentDir, "multi-pass.json")));
  writeFileSync(join(project, ".omp", "multi-pass.json"), "{}");
  writeFileSync(fixture, `
import assert from "node:assert/strict";
import multiSub from ${JSON.stringify(`./.startup-quota-source-${process.pid}.ts`)};
import { ompAuth } from "../lib/host.ts";
export default async function probe(pi) {
  const checked = [];
  for (const provider of ["openai-codex", "openai-codex-2"]) {
    await ompAuth.credentials.set(provider, { type: "oauth", access: "dummy-" + provider, refresh: "dummy-refresh", expires: Date.now() + 86400000 });
  }
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith("/wham/usage"), "only usage requests are permitted");
    const provider = new Headers(options.headers).get("Authorization").replace("Bearer dummy-", ""); checked.push(provider);
    return new Response(JSON.stringify({ rate_limit: {
      primary_window: { used_percent: provider === "openai-codex" ? 50 : 0, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
    } }), { headers: { "content-type": "application/json" } });
  };
  multiSub(pi);
  pi.on("session_start", async (_event, ctx) => {
    assert.equal(ctx.model?.provider, "openai-codex-2", "actual OMP startup selects the healthier account");
    assert.equal(ctx.model?.id, "gpt-6.1-sol");
    assert.deepEqual(checked.sort(), ["openai-codex", "openai-codex-2"]);
    process.stdout.write(JSON.stringify({ type: "native_startup_quota_test", success: true }) + "\\n");
  });
}
`);
  const native = spawnSync("omp", ["--mode", "rpc", "--provider", "openai-codex", "--model", "gpt-6.1-sol", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "-e", fixture], {
    cwd: project,
    env: { ...process.env, PI_CONFIG_DIR: relative(homedir(), join(sandbox, "real-config")), PI_CODING_AGENT_DIR: realAgentDir, OMP_PROFILE: "", MULTI_SUB: "", OPENAI_API_KEY: "dummy-offline-key" },
    input: '{"id":"commands","type":"get_available_commands"}\n', encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(native.error, undefined, native.error?.message);
  assert.equal(native.status, 0, native.stderr);
  const nativeOutput = native.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(!nativeOutput.some(event => event.type === "extension_error"), JSON.stringify(nativeOutput.filter(event => event.type === "extension_error")));
  assert.ok(nativeOutput.some(event => event.type === "native_startup_quota_test" && event.success), native.stdout + native.stderr);
  console.log("Startup quota checks passed: current-inclusive ranking, one check per session, ties, all windows, model preservation, restrictions, missing data, stale results and timeout");
} finally {
  rmSync(underTest, { force: true }); rmSync(fixture, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
