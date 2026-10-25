import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "multi-pass-features-"));
const underTest = join(root, "tests", `.features-source-${process.pid}.ts`);
const fixture = join(root, "tests", `.features-probe-${process.pid}.ts`);
try {
  writeFileSync(underTest, readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8") + "\nexport { PoolManager, getAuthStorage, formatPoolStatusLines };\n");
  for (const nativeOnly of [true, false]) {
    const agentDir = join(sandbox, nativeOnly ? "native-agent" : "full-agent");
    const project = join(sandbox, nativeOnly ? "native-project" : "full-project");
    mkdirSync(agentDir);
    mkdirSync(join(project, ".omp"), { recursive: true });
    const members = ["openai-codex", "openai-codex-2", "openai-codex-3"];
    const initial = {
      subscriptions: nativeOnly ? [] : [{ provider: "openai-codex", index: 2 }, { provider: "openai-codex", index: 3 }],
      pools: nativeOnly ? [] : [{ name: "codex", baseProvider: "openai-codex", members, enabled: true, strategy: "weighted", memberWeights: { "openai-codex": 1, "openai-codex-2": 2, "openai-codex-3": 1 } }],
      chains: [], presets: [], tokenKeeper: false,
    };
    writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify(initial));
    writeFileSync(fixture, `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import multiSub, { PoolManager, getAuthStorage, formatPoolStatusLines } from ${JSON.stringify(`./.features-source-${process.pid}.ts`)};
import { ompAuth } from "../lib/host.ts";
export default async function probe(pi) {
  const nativeOnly = ${nativeOnly};
  const initial = ${JSON.stringify(initial)};
  const members = ${JSON.stringify(members)};
  const globalPath = ${JSON.stringify(join(agentDir, "multi-pass.json"))};
  const projectPath = ${JSON.stringify(join(project, ".omp", "multi-pass.json"))};
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("Network disabled in feature checks"); };
  const secret = "dummy-feature-access-never-report";
  const token = { type: "oauth", access: secret, refresh: "dummy-feature-refresh-never-report", expires: Date.now() + 86400000 };
  for (const member of nativeOnly ? members.slice(0, 1) : members) await ompAuth.credentials.set(member, token);
  const commands = new Map(), events = new Map(), notices = [], switches = [], prompts = [], selections = [], inputs = [];
  let current;
  const wrapped = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name, definition) => { commands.set(name, definition); return pi.registerCommand(name, definition); };
    if (key === "on") return (name, handler) => { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); };
    if (key === "setModel") return async model => { current = model; switches.push(model.provider); return true; };
    if (key === "sendUserMessage") return (...args) => prompts.push(args);
    return Reflect.get(target, key, target);
  }});
  multiSub(wrapped);
  pi.on("session_start", async (_event, realCtx) => {
    const base = realCtx.modelRegistry.getAll().find(model => model.provider === members[0]);
    assert.ok(base, "native OMP Codex catalog is available");
    current = base;
    const ui = { ...realCtx.ui,
      notify: (text, level) => notices.push({ text, level }),
      select: async (title, options) => { const next = selections.shift(); return typeof next === "function" ? next(title, options) : next; },
      input: async () => inputs.shift(), setStatus() {},
    };
    const ctx = new Proxy(realCtx, { get(target, key) {
      if (key === "model") return current;
      if (key === "ui") return ui;
      if (key === "hasUI") return false;
      return Reflect.get(target, key, target);
    } });
    const emit = async (event, data = {}) => { for (const handler of events.get(event) ?? []) await handler(data, ctx); };
    const run = (command, args) => commands.get(command).handler(args, ctx);
    const lastNotice = () => notices.at(-1)?.text ?? "";
    await emit("session_start");
    assert.ok(commands.get("subs").getArgumentCompletions("doc").some(item => item.value === "doctor"));
    assert.ok(commands.get("pool").getArgumentCompletions("prev").some(item => item.value === "preview"));
    await run("subs", "doctor");
    assert.match(lastNotice(), /Multi-pass doctor.*OMP/);
    assert.match(lastNotice(), /openai-codex: credential available/);
    assert.match(lastNotice(), /github-copilot: no credential/);
    assert.match(lastNotice(), /minimax: no credential/);
    assert.doesNotMatch(lastNotice(), /dummy-feature-access|dummy-feature-refresh/);
    const baseline = { switches: switches.length, prompts: prompts.length, fetch: fetchCalls, global: readFileSync(globalPath, "utf8") };
    await run("pool", "preview");
    assert.match(lastNotice(), /Routing preview/);
    assert.equal(switches.length, baseline.switches);
    assert.equal(prompts.length, baseline.prompts);
    assert.equal(fetchCalls, baseline.fetch);
    assert.equal(readFileSync(globalPath, "utf8"), baseline.global);

    const message = { role: "assistant", provider: members[nativeOnly ? 0 : 2], usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 5, totalTokens: 40 }, stopReason: "stop" };
    await emit("message_end", { message });
    await emit("message_end", { message });
    await emit("message_end", { message: { role: "user", provider: members[0], usage: { input: 999 } } });
    await run("subs", "stats");
    assert.match(lastNotice(), new RegExp(message.provider + ": 1 requests.*input 35.*output 5.*total 40"));
    assert.doesNotMatch(lastNotice(), /2 requests|999/);
    await emit("message_end", { message: { role: "assistant", usage: { input: 1, output: 1 } } });
    await run("subs", "stats");
    assert.match(lastNotice(), new RegExp(members[0] + ": " + (nativeOnly ? 2 : 1) + " requests"), "missing provider metadata falls back to the active account");
    if (!nativeOnly) {
      writeFileSync(globalPath, JSON.stringify({ ...initial, pools: ["malformed-pool"], access: secret }));
      await run("subs", "doctor");
      assert.match(lastNotice(), /ERROR.*pools\\[0\\].*Expected an object/);
      assert.doesNotMatch(lastNotice(), /dummy-feature-access|dummy-feature-refresh/);
      writeFileSync(globalPath, JSON.stringify(initial));
      writeFileSync(projectPath, "{");
      await run("subs", "doctor");
      assert.match(lastNotice(), /unreadable or invalid JSON/);
      writeFileSync(projectPath, "{}");

      // The actual menu persists global weights, then a project override.
      selections.push("codex"); inputs.push("1", "3", "2");
      await run("pool", "weights");
      const globalSaved = JSON.parse(readFileSync(globalPath, "utf8"));
      assert.equal(globalSaved.pools[0].strategy, "weighted");
      assert.deepEqual(globalSaved.pools[0].memberWeights, { [members[0]]: 1, [members[1]]: 3, [members[2]]: 2 });
      const projectConfig = { allowedSubs: members.slice(0, 2), pools: [{ ...initial.pools[0], members: members.slice(0, 2) }] };
      writeFileSync(projectPath, JSON.stringify(projectConfig));
      selections.push("codex"); inputs.push("2", "5");
      await run("pool", "weights");
      assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")).pools[0].memberWeights, { [members[0]]: 2, [members[1]]: 5 });
      assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), globalSaved, "project weights do not rewrite global weights");
      const beforeBad = readFileSync(projectPath, "utf8");
      selections.push("codex"); inputs.push("0");
      await run("pool", "weights");
      assert.match(lastNotice(), /Nothing was saved/);
      assert.equal(readFileSync(projectPath, "utf8"), beforeBad);
      writeFileSync(projectPath, "{}");

      const make = (poolMembers = members, memberWeights = {}) => {
        const manager = new PoolManager(wrapped);
        const pool = { name: "weighted", baseProvider: members[0], members: poolMembers, enabled: true, strategy: "weighted", memberWeights };
        manager.loadPools([pool]); current = base;
        return { manager, pool, config: { subscriptions: initial.subscriptions, pools: [pool], chains: [], presets: [] } };
      };
      const balanced = make(members.slice(0, 2), { [members[0]]: 1, [members[1]]: 2 });
      for (let index = 0; index < 60; index++) {
        await balanced.manager.startTurn("prompt " + index, current, ctx);
        balanced.manager.recordUsage(current.provider, { usage: { input: 10, output: 1 } });
        balanced.manager.clearCascadeState();
      }
      assert.equal(balanced.manager.getUsage()[members[0]].requests, 20);
      assert.equal(balanced.manager.getUsage()[members[1]].requests, 40);
      const duringRetry = switches.length;
      await balanced.manager.startTurn("new task", current, ctx);
      const selected = current.provider;
      const afterNew = switches.length;
      balanced.manager.continueTurn();
      assert.equal(await balanced.manager.startTurn("host retry with changed text", current, ctx), false);
      assert.equal(current.provider, selected);
      assert.equal(switches.length, afterNew);
      assert.ok(afterNew >= duringRetry);
      const missingAuth = make();
      missingAuth.manager.recordUsage(members[0], { usage: {} });
      await ompAuth.credentials.remove(members[1]);
      await realCtx.modelRegistry.authStorage.credentials.reload();
      await missingAuth.manager.startTurn("skip no login", current, ctx);
      assert.equal(current.provider, members[2]);
      await ompAuth.credentials.set(members[1], token);
      await realCtx.modelRegistry.authStorage.credentials.reload();
      const missingModel = make();
      missingModel.manager.recordUsage(members[0], { usage: {} });
      const registry = new Proxy(realCtx.modelRegistry, { get(target, key) {
        if (key === "find") return (provider, id) => provider === members[1] ? undefined : target.find(provider, id);
        return Reflect.get(target, key, target);
      } });
      const missingCtx = new Proxy(ctx, { get(target, key) { return key === "modelRegistry" ? registry : Reflect.get(target, key, target); } });
      await missingModel.manager.startTurn("skip unsupported model", current, missingCtx);
      assert.equal(current.provider, members[2]);

      const realNow = Date.now;
      try {
        let clock = realNow(); Date.now = () => clock;
        const cooling = make();
        cooling.manager.recordUsage(members[0], { usage: {} });
        cooling.manager.markExhausted(members[1], "429 rate limit\\nRetry-After: 3600");
        const beforePreview = JSON.stringify({ pools: [...cooling.manager.poolStates].map(([name, state]) => [name, { ...state, exhausted: [...state.exhausted], retryAt: [...state.retryAt] }]), usage: cooling.manager.getUsage(), cascade: cooling.manager.getCascadeStateSnapshot(), trace: cooling.manager.getRoutingTrace() });
        const callsBefore = { switches: switches.length, prompts: prompts.length, fetch: fetchCalls };
        const preview = await cooling.manager.preview(current, cooling.config, ctx);
        assert.ok(preview.some(line => line.includes(members[1]) && line.includes("3600s remaining")));
        assert.equal(JSON.stringify({ pools: [...cooling.manager.poolStates].map(([name, state]) => [name, { ...state, exhausted: [...state.exhausted], retryAt: [...state.retryAt] }]), usage: cooling.manager.getUsage(), cascade: cooling.manager.getCascadeStateSnapshot(), trace: cooling.manager.getRoutingTrace() }), beforePreview);
        assert.deepEqual({ switches: switches.length, prompts: prompts.length, fetch: fetchCalls }, callsBefore);
        cooling.manager.markExhausted(members[2], "429 rate limit\\nRetry-After: 2");
        clock += 2001;
        const expiredBefore = JSON.stringify([...cooling.manager.poolStates].map(([name, state]) => [name, [...state.exhausted], [...state.retryAt]]));
        await cooling.manager.preview(current, cooling.config, ctx);
        assert.equal(JSON.stringify([...cooling.manager.poolStates].map(([name, state]) => [name, [...state.exhausted], [...state.retryAt]])), expiredBefore, "preview does not expire entries in live routing state");
        await cooling.manager.startTurn("skip cooling account", current, ctx);
        assert.equal(current.provider, members[2]);
        clock += 5 * 60000 + 1;
        assert.equal(cooling.manager.isMemberExhausted(cooling.pool, members[1]), true, "provider delay survives the old five-minute cooldown");
        assert.match(formatPoolStatusLines(cooling.pool, getAuthStorage(ctx), cooling.manager).join("\\n"), /openai-codex-2.*cooling down/);
        clock += 55 * 60000;
        assert.equal(cooling.manager.isMemberExhausted(cooling.pool, members[1]), false);
        cooling.manager.markExhausted(members[1], "429 rate limit\\nRetry-After: 2");
        assert.equal(cooling.manager.getCooldownRemainingMs(members[1]), 2000);
        clock += 2001;
        assert.equal(cooling.manager.isMemberExhausted(cooling.pool, members[1]), false, "short provider delay replaces the old five-minute fallback");
      } finally { Date.now = realNow; }
    }
    await emit("session_start");
    await run("subs", "stats");
    assert.match(lastNotice(), /No finalized assistant requests yet/, "usage totals reset at the next session");
    assert.equal(fetchCalls, 0, "all feature checks stay offline");
    await emit("session_shutdown");
    process.stdout.write(JSON.stringify({ type: "features_test", nativeOnly, success: true }) + "\\n");
  });
}
`);
    const result = spawnSync("omp", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "-e", fixture], {
      cwd: project,
      env: { ...process.env, PI_CONFIG_DIR: relative(homedir(), join(agentDir, "config")), PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", MULTI_SUB: "", OPENAI_API_KEY: "dummy-offline-key" },
      input: '{"id":"commands","type":"get_available_commands"}\n', encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Failed to load extension/, result.stderr);
    const output = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.ok(!output.some(item => item.type === "extension_error"), JSON.stringify(output.filter(item => item.type === "extension_error")));
    assert.ok(output.some(item => item.type === "features_test" && item.nativeOnly === nativeOnly && item.success), result.stdout + result.stderr);
  }
  console.log("Feature checks passed: native OMP, doctor privacy, dry-run purity, usage attribution, weighted routing, weight persistence, reset-aware cooldowns");
} finally {
  rmSync(underTest, { force: true });
  rmSync(fixture, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
