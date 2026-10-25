import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headroom = resolve(process.env.MULTIPASS_HEADROOM_CHECKOUT || join(root, "..", "omp-headroom"));
const headroomEntry = join(headroom, "src", "index.ts");
if (!existsSync(headroomEntry)) {
  console.log("SKIP Headroom integration: sibling checkout unavailable; set MULTIPASS_HEADROOM_CHECKOUT to enable it.");
  process.exit(0);
}

const sandbox = mkdtempSync(join(tmpdir(), "multi-pass-headroom-"));
const fixture = join(root, "tests", `.headroom-integration-probe-${process.pid}.ts`);
try {
  const agentDir = join(sandbox, "agent");
  const project = join(sandbox, "project");
  const headroomBin = join(sandbox, "headroom", "venv", "bin", "headroom");
  mkdirSync(agentDir);
  mkdirSync(project);
  mkdirSync(dirname(headroomBin), { recursive: true });
  writeFileSync(headroomBin, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const members = ["openai-codex", "openai-codex-2"];
  writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
    subscriptions: [{ provider: "openai-codex", index: 2 }],
    pools: [{ name: "joint-codex", baseProvider: "openai-codex", members, enabled: true, strategy: "weighted", memberWeights: { [members[0]]: 1, [members[1]]: 2 } }],
    chains: [], presets: [], statusBar: true, tokenKeeper: false,
  }));
  writeFileSync(fixture, String.raw`
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import multiSub from "../extensions/multi-sub.ts";
import { ompAuth } from "../lib/host.ts";
import headroomExtension from ${JSON.stringify(headroomEntry)};

export default async function probe(pi) {
  const members = ${JSON.stringify(members)};
  const token = { type: "oauth", access: "dummy-joint-access", refresh: "dummy-joint-refresh", expires: Date.now() + 86400000 };
  for (const provider of members) await ompAuth.credentials.set(provider, token);
  const commands = new Map(), events = new Map(), tools = new Map();
  const widgets = [], switches = [], prompts = [], notices = [], fetches = [];
  const hash = "joint_smoke_original_001";
  let current;
  let compressedSource;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    fetches.push(path);
    if (path === "/livez") return Response.json({ alive: true, status: "healthy", version: "joint-smoke" });
    if (path.endsWith("/stats")) return Response.json({});
    if (path.endsWith("/wham/usage")) return Response.json({ rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    } });
    if (path.endsWith("/v1/compress")) {
      const body = JSON.parse(options.body);
      compressedSource = body.messages;
      return Response.json({
        messages: body.messages.map(message => message.role === "tool"
          ? { ...message, content: "Joint compressed records. Retrieve more: hash=" + hash }
          : message),
        tokens_before: 8000, tokens_after: 500, tokens_saved: 7500, ccr_hashes: [hash],
      });
    }
    if (path === "/v1/retrieve") throw new Error("Joint retrieval must use the durable local original");
    throw new Error("Unexpected network operation in offline joint check: " + path);
  };
  const wrapped = new Proxy(pi, { get(target, key) {
    if (key === "registerCommand") return (name, definition) => {
      commands.set(name, definition); return pi.registerCommand(name, definition);
    };
    if (key === "registerTool") return definition => {
      tools.set(definition.name, definition); return pi.registerTool(definition);
    };
    if (key === "on") return (name, handler) => {
      const list = events.get(name) ?? []; list.push(handler); events.set(name, list);
    };
    if (key === "setModel") return async model => { current = model; switches.push(model); return true; };
    if (key === "sendUserMessage") return (...args) => prompts.push(args);
    return Reflect.get(target, key, target);
  }});
  // Both extensions receive OMP's real schema/API surfaces. No zod shim.
  multiSub(wrapped);
  headroomExtension(wrapped);
  assert.ok(tools.has("headroom_retrieve"), "Headroom tools register against the native OMP API");
  assert.ok(commands.has("subs") && commands.has("pool") && commands.has("headroom"));
  pi.on("session_start", async (_event, realCtx) => {
    const model = realCtx.modelRegistry.getAll().find(candidate => candidate.provider === members[0]);
    assert.ok(model, "native OMP model catalog is available");
    current = model;
    const nativeColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 200 });
    const ui = { ...realCtx.ui,
      // RPC has no interactive theme; provide only the UI rendering boundary.
      theme: { fg: (_color, text) => text, bold: text => text },
      notify: (text, level) => notices.push({ text, level }),
      setStatus() {},
      setWidget: (key, content, options) => widgets.push({ key, content, options }),
    };
    const originalWidgetSetter = ui.setWidget;
    const ctx = new Proxy(realCtx, { get(target, key) {
      if (key === "model") return current;
      if (key === "ui") return ui;
      if (key === "hasUI") return true;
      return Reflect.get(target, key, target);
    } });
    const emit = async (name, event = {}) => {
      let result;
      for (const handler of events.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    };
    try {
      await emit("session_start");
      await emit("before_agent_start", { prompt: "joint task" });
      assert.equal(current.provider, members[1], "weighted new prompt selects an eligible extra account");
      assert.equal(current.id, model.id, "account rotation preserves the requested model");
      await emit("message_end", { message: { role: "assistant", provider: current.provider, usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 35 }, stopReason: "stop" } });
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }], willContinue: false });
      await emit("before_agent_start", { prompt: "joint task" });
      assert.equal(current.provider, members[0], "weighted routing advances to the lower-load account");
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit; Retry-After: 2" }], willContinue: false });
      assert.equal(current.provider, members[1], "rate-limit failover reaches the other account");
      assert.equal(current.id, model.id);
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0][0], "joint task");
      const beforeReplay = switches.length;
      await emit("before_agent_start", { prompt: "joint task" });
      assert.equal(switches.length, beforeReplay, "explicit failover replay stays on its selected account");

      const original = "joint-record JOINT-MATCH-FIELD key=value\n".repeat(700);
      const messages = [
        { role: "user", content: "Inspect these records without changing the visible transcript." },
        { role: "assistant", content: null, tool_calls: [{ id: "joint-read", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "joint-read", content: original },
      ];
      const payload = { model: model.id, tools: [{ type: "function", function: { name: "headroom_retrieve", parameters: { type: "object" } } }], messages };
      const projected = await emit("before_provider_request", { payload });
      assert.ok(projected?.messages, "Headroom transforms an eligible outbound provider request");
      assert.deepEqual(projected.messages[0], messages[0], "the user message stays verbatim");
      assert.equal(messages[2].content, original, "the visible transcript source stays intact");
      assert.ok(projected.messages[2].content.includes(hash));
      assert.ok(JSON.stringify(projected).length < JSON.stringify(payload).length);
      assert.ok(compressedSource, "the real Headroom compression transport was used");
      await new Promise(resolve => setImmediate(resolve));
      const joined = widgets.findLast(widget => widget.key === "multi-pass-quota" && Array.isArray(widget.content)
        && /Headroom.*Multi Pass/.test(stripVTControlCharacters(widget.content[0] ?? "")));
      assert.ok(joined, "actual Headroom and Multi Pass widgets share a row on a wide terminal");
      assert.equal(joined.options.placement, "aboveEditor");

      const retrieve = tools.get("headroom_retrieve");
      let offset = 0, recovered = "", pages = 0;
      const retrievalFetchesBefore = fetches.filter(path => path === "/v1/retrieve").length;
      while (true) {
        const result = await retrieve.execute("joint-retrieve", { hash, offset, limit: 4000 }, undefined, undefined, ctx);
        assert.equal(result.isError, false);
        assert.ok(result.details.original_content.length <= 4000);
        recovered += result.details.original_content;
        pages++;
        if (result.details.next_offset === undefined) break;
        assert.ok(result.details.next_offset > offset, "pagination makes forward progress");
        offset = result.details.next_offset;
        assert.ok(pages < 30, "retrieval is bounded by finite pages");
      }
      assert.ok(pages > 1, "large originals require multiple bounded pages");
      const restoredMessages = JSON.parse(recovered);
      assert.equal(restoredMessages[2].content, original, "local CCR reconstructs the complete original");
      const filtered = await retrieve.execute("joint-query", { hash, query: "JOINT-NONMATCHING-LITERAL", limit: 100 }, undefined, undefined, ctx);
      assert.equal(filtered.isError, false);
      assert.equal(filtered.details.matched_lines, 0);
      assert.equal(filtered.details.original_content, "");
      assert.equal(fetches.filter(path => path === "/v1/retrieve").length, retrievalFetchesBefore, "local retrieval never contacts the proxy");
      await commands.get("headroom").handler("telemetry", ctx);
      assert.ok(notices.at(-1).text.includes("1 accepted"));
      assert.ok(notices.at(-1).text.includes("net ≈"));
      await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }], willContinue: false });
      process.stdout.write(JSON.stringify({ type: "headroom_integration_test", success: true, pages }) + "\n");
    } finally {
      await emit("session_shutdown");
      assert.equal(ui.setWidget, originalWidgetSetter, "shutdown restores the shared widget API");
      if (nativeColumns) Object.defineProperty(process.stdout, "columns", nativeColumns);
      else delete process.stdout.columns;
    }
  });
}
`);
  const result = spawnSync("omp", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "-e", fixture], {
    cwd: project,
    env: {
      ...process.env,
      PI_CONFIG_DIR: relative(homedir(), join(sandbox, "config")), PI_CODING_AGENT_DIR: agentDir,
      OMP_PROFILE: "", MULTI_SUB: "", OPENAI_API_KEY: "dummy-offline-key",
      OMP_HEADROOM_BIN: headroomBin, OMP_HEADROOM_AUTOUPDATE: "0", OMP_HEADROOM_SYSTEMD_UNIT: "",
      OMP_HEADROOM_URL: "http://127.0.0.1:8787", OMP_HEADROOM_ADAPTIVE: "0",
      OMP_HEADROOM_SESSION_COMPACTION: "0", OMP_HEADROOM_MIN_TOOL_CHARS: "12000",
      OMP_HEADROOM_MIN_PROVIDER_CHARS: "1000", OMP_HEADROOM_STATS_INTERVAL_MS: "60000",
    },
    input: '{"id":"commands","type":"get_available_commands"}\n', encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Failed to load extension/, result.stderr);
  const output = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(!output.some(item => item.type === "extension_error"), JSON.stringify(output.filter(item => item.type === "extension_error")));
  assert.ok(output.some(item => item.type === "headroom_integration_test" && item.success), result.stdout + result.stderr);
  console.log("Joint OMP smoke passed: weighted routing, failover/replay, outbound compression, paginated CCR, shared widgets, shutdown");
} finally {
  rmSync(fixture, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
