import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "multi-pass-per-turn-"));
const underTest = join(root, "tests", `.per-turn-source-${process.pid}.ts`);
const fixture = join(root, "tests", `.per-turn-probe-${process.pid}.ts`);
try {
  const agentDir = join(sandbox, "agent");
  const project = join(sandbox, "project");
  mkdirSync(agentDir);
  mkdirSync(join(project, ".omp"), { recursive: true });
  const members = ["openai-codex", "openai-codex-2", "openai-codex-3"];
  writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
    subscriptions: [{ provider: "openai-codex", index: 2 }, { provider: "openai-codex", index: 3 }],
    pools: [{ name: "codex", baseProvider: "openai-codex", members, enabled: true, strategy: "per-turn" }],
    chains: [], presets: [], tokenKeeper: false,
  }));
  writeFileSync(underTest, readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8") + "\nexport { PoolManager };\n");
  writeFileSync(fixture, `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import multiSub, { PoolManager } from ${JSON.stringify(`./.per-turn-source-${process.pid}.ts`)};
import { ompAuth } from "../lib/host.ts";
export default async function probe(pi) {
  globalThis.fetch = async () => { throw new Error("Network disabled in per-turn checks"); };
  const members = ${JSON.stringify(members)};
  const token = { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 86400000 };
  for (const provider of members) await ompAuth.credentials.set(provider, token);
  const events = new Map(), switches = [], prompts = [];
  let current, rejectSwitch = false;
  const wrapped = new Proxy(pi, { get(target, key) {
    if (key === "on") return (event, handler) => {
      const handlers = events.get(event) || [];
      handlers.push(handler); events.set(event, handlers);
    };
    if (key === "setModel") return async model => {
      // Deliberately asynchronous: before_agent_start must await the switch.
      await Promise.resolve();
      if (rejectSwitch) return false;
      current = model; switches.push(model); return true;
    };
    if (key === "sendUserMessage") return (...args) => prompts.push(args);
    return target[key];
  }});
  multiSub(wrapped);
  pi.on("session_start", async (_event, realCtx) => {
    const base = realCtx.modelRegistry.getAll().find(model => model.provider === "openai-codex-2");
    assert.ok(base, "native registry includes the subscription models");
    current = { ...base, provider: members[0] };
    const ui = { ...realCtx.ui, notify() {}, setStatus() {} };
    const ctx = new Proxy(realCtx, { get(target, key) {
      if (key === "model") return current;
      if (key === "hasUI") return false;
      if (key === "ui") return ui;
      return target[key];
    } });
    const emit = async (event, data) => {
      for (const handler of events.get(event) || []) await handler(data, ctx);
    };
    const done = (willContinue = false) => emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }], willContinue,
    });
    await emit("session_start", {});
    // Two-account rotation, including identical consecutive user prompts.
    writeFileSync(ctx.cwd + "/.omp/multi-pass.json", JSON.stringify({ allowedSubs: members.slice(0, 2) }));
    await emit("session_start", {});
    await emit("before_agent_start", { prompt: "same prompt" });
    assert.equal(current.provider, members[1], "first new prompt advances to account two");
    assert.equal(current.id, base.id, "rotation preserves the selected model ID");
    assert.equal(switches.length, 1);
    await done(true);
    await emit("before_agent_start", { prompt: "same prompt" });
    assert.equal(switches.length, 1, "a retry does not rotate again");
    await done(true);
    await emit("before_agent_start", { prompt: "synthetic developer continuation after compaction" });
    assert.equal(switches.length, 1, "changed-text host continuation stays on the selected account");
    await done();
    await emit("before_agent_start", { prompt: "same prompt" });
    assert.equal(current.provider, members[0], "identical new prompt advances back to account one");
    await done();
    await emit("before_agent_start", { prompt: "third prompt" });
    assert.equal(current.provider, members[1], "subsequent prompts continue alternating");
    await done();
    await emit("before_agent_start", { prompt: "cancelled retry" });
    await done(true);
    await emit("auto_retry_end", { success: false, attempt: 1 });
    await emit("before_agent_start", { prompt: "cancelled retry" });
    assert.equal(current.provider, members[1], "cancelling a pending retry allows the next new prompt to rotate");
    await done();
    // Non-rate-limit failures also close a turn, so an identical retry by the user rotates.
    await emit("before_agent_start", { prompt: "bad request" });
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "400 invalid request" }], willContinue: false });
    await emit("before_agent_start", { prompt: "bad request" });
    assert.equal(current.provider, members[1]);
    await done();
    // Restore all three accounts for failover and eligibility checks.
    writeFileSync(ctx.cwd + "/.omp/multi-pass.json", JSON.stringify({}));
    await emit("session_start", {});
    current = { ...base, provider: members[0] };
    await emit("before_agent_start", { prompt: "rate limited" });
    assert.equal(current.provider, members[1]);
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }], willContinue: true });
    assert.equal(current.provider, members[2], "rate limits still fail over within the turn");
    const afterFailover = switches.length;
    await emit("before_agent_start", { prompt: "rate limited" });
    assert.equal(switches.length, afterFailover, "host retry preserves its failover account");
    assert.equal(prompts.length, 0, "host retry does not receive a duplicate prompt");
    await done();
    current = { ...base, provider: members[0] };
    await emit("before_agent_start", { prompt: "skip cooldown" });
    assert.equal(current.provider, members[2], "new turns skip the rate-limited account");
    await done();
    await emit("before_agent_start", { prompt: "explicit replay" });
    assert.equal(current.provider, members[0]);
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }], willContinue: false });
    assert.equal(current.provider, members[2]);
    assert.equal(prompts.length, 1);
    const afterReplay = switches.length;
    await emit("before_agent_start", { prompt: "explicit replay" });
    assert.equal(switches.length, afterReplay, "plugin replay does not rotate again");
    await done();
    // Test eligibility and failure handling against the actual PoolManager implementation.
    const fresh = (strategy = "per-turn", enabled = true) => {
      current = { ...base, provider: members[0] };
      const manager = new PoolManager(wrapped);
      manager.loadPools([{ name: "codex", baseProvider: "openai-codex", members, enabled, strategy }]);
      return manager;
    };
    // Continuation text must not reset the failover cascade or replace its user prompt.
    const continued = fresh();
    await continued.startTurn("original user prompt", current, ctx);
    continued.continueTurn();
    const beforeSynthetic = switches.length;
    assert.equal(await continued.startTurn("synthetic continuation", current, ctx), false);
    assert.equal(switches.length, beforeSynthetic);
    assert.equal(continued.getCascadeStateSnapshot().prompt, "original user prompt");
    for (const strategy of ["round-robin", "quota-first", "scheduled", "custom"]) {
      await fresh(strategy).startTurn("legacy strategy", current, ctx);
      assert.equal(current.provider, members[0], strategy + " remains failover-only");
    }
    await fresh("per-turn", false).startTurn("disabled pool", current, ctx);
    assert.equal(current.provider, members[0]);
    const unauthenticated = fresh();
    await ompAuth.credentials.remove(members[1]);
    await realCtx.modelRegistry.authStorage.credentials.reload();
    await unauthenticated.startTurn("skip missing auth", current, ctx);
    assert.equal(current.provider, members[2]);
    await ompAuth.credentials.set(members[1], token);
    await realCtx.modelRegistry.authStorage.credentials.reload();
    const missingModel = fresh();
    const registry = new Proxy(realCtx.modelRegistry, { get(target, key) {
      if (key === "find") return (provider, id) => provider === members[1] ? undefined : target.find(provider, id);
      return Reflect.get(target, key, target);
    } });
    const missingCtx = new Proxy(ctx, { get(target, key) { return key === "modelRegistry" ? registry : target[key]; } });
    await missingModel.startTurn("skip missing model", current, missingCtx);
    assert.equal(current.provider, members[2]);
    const exhausted = fresh();
    exhausted.markExhausted(members[1]); exhausted.markExhausted(members[2]);
    await exhausted.startTurn("no alternative", current, ctx);
    assert.equal(current.provider, members[0], "no usable alternative retains the current account");
    const unavailable = fresh();
    rejectSwitch = true;
    try { await unavailable.startTurn("switch rejected", current, ctx); }
    finally { rejectSwitch = false; }
    assert.equal(current.provider, members[0], "failed switches keep the current account");
    assert.deepEqual(unavailable.getCascadeStateSnapshot().attemptedProviders, [members[0]], "failover starts from the account actually selected");
    // Every strategy separates completed user turns from host continuations,
    // even when a new user prompt repeats the exact previous text.
    const realNow = Date.now;
    try {
      let clock = realNow();
      Date.now = () => clock;
      for (const strategy of ["round-robin", "quota-first", "scheduled", "custom", "per-turn"]) {
        clock += 5 * 60_000 + 1;
        writeFileSync(${JSON.stringify(join(agentDir, "multi-pass.json"))}, JSON.stringify({
          subscriptions: [{ provider: "openai-codex", index: 2 }, { provider: "openai-codex", index: 3 }],
          pools: [{ name: "codex", baseProvider: "openai-codex", members: members.slice(0, 2), enabled: true, strategy }],
          chains: [], presets: [], tokenKeeper: false,
        }));
        current = { ...base, provider: members[0] };
        await emit("session_start", {});
        await emit("before_agent_start", { prompt: "repeat completed prompt" });
        const selected = current.provider;
        await done(true);
        await emit("before_agent_start", { prompt: "synthetic host continuation" });
        assert.equal(current.provider, selected, strategy + " preserves the continuation account");
        const beforeError = prompts.length;
        await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }], willContinue: false });
        assert.notEqual(current.provider, selected, strategy + " rotates after the continuation fails");
        assert.equal(prompts.length, beforeError + 1);
        assert.equal(prompts.at(-1)[0], "repeat completed prompt", strategy + " replays the original user prompt");
        await emit("before_agent_start", { prompt: "repeat completed prompt" });
        await done();
        clock += 5 * 60_000 + 1;
        await emit("before_agent_start", { prompt: "repeat completed prompt" });
        const nextSelected = current.provider;
        await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }], willContinue: false });
        assert.notEqual(current.provider, nextSelected, strategy + " gives an identical later prompt a fresh cascade");
        await emit("before_agent_start", { prompt: "repeat completed prompt" });
        await done();
      }
    } finally { Date.now = realNow; }
    process.stdout.write(JSON.stringify({ type: "per_turn_test", success: true }) + "\\n");
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
  assert.ok(!output.some(item => item.type === "extension_error"), JSON.stringify(output.filter(item => item.type === "extension_error")));
  assert.ok(output.some(item => item.type === "per_turn_test" && item.success), result.stdout + result.stderr);
  console.log("Per-turn checks passed: alternation, identical prompts, continuations, cooldown, auth, model preservation, switch failure and failover");
} finally {
  rmSync(underTest, { force: true });
  rmSync(fixture, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
