import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "multi-pass-per-turn-requests-"));
const fixture = join(root, "tests", `.per-turn-requests-${process.pid}.ts`);
let child;
try {
  const agentDir = join(sandbox, "agent");
  const project = join(sandbox, "project");
  mkdirSync(agentDir); mkdirSync(project);
  writeFileSync(join(agentDir, "config.yml"), "retry:\n  enabled: true\n  maxRetries: 2\n  baseDelayMs: 2000\n");
  writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
    subscriptions: [], pools: [{ name: "test", baseProvider: "per-turn-a", members: ["per-turn-a", "per-turn-b"], enabled: true, strategy: "per-turn" }],
    chains: [], presets: [], tokenKeeper: false,
  }));
  writeFileSync(fixture, `
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { Flag, create as createErrorId } from "@oh-my-pi/pi-ai/error";
import multiSub from "../extensions/multi-sub.ts";
import { ompAuth } from "../lib/host.ts";
export default async function probe(pi) {
  globalThis.fetch = async () => { throw new Error("Network disabled in request checks"); };
  for (const provider of ["per-turn-a", "per-turn-b"]) {
    await ompAuth.credentials.set(provider, { type: "api_key", key: "dummy-offline-key" });
    pi.registerProvider(provider, {
      baseUrl: "https://example.invalid", apiKey: "dummy-offline-key", api: "per-turn-test",
      models: [{ id: "test-model", name: "Test model", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        process.stdout.write(JSON.stringify({ type: "per_turn_request", provider: model.provider, model: model.id, lastMessage: context.messages.at(-1) }) + "\\n");
        const stream = createAssistantMessageEventStream();
        const fail = context.messages.at(-1)?.content?.some(part => part.type === "text" && part.text === "fail for abort");
        const message = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        if (fail) { message.content = []; message.stopReason = "error"; message.errorMessage = "500 temporary server error"; message.errorStatus = 500; message.errorId = createErrorId(Flag.Transient); }
        (async () => {
          stream.push({ type: "start", partial: message });
          await new Promise(resolve => setTimeout(resolve, 150));
          stream.push(fail ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }); stream.end();
        })();
        return stream;
      },
    });
  }
  multiSub(pi);
  pi.on("before_agent_start", async (event, ctx) => {
    process.stdout.write(JSON.stringify({ type: "per_turn_start", prompt: event.prompt, provider: ctx.model?.provider }) + "\\n");
  });
  pi.on("session_start", async (_event, ctx) => {
    await pi.setModel(ctx.modelRegistry.find("per-turn-a", "test-model"));
    process.stdout.write(JSON.stringify({ type: "per_turn_ready" }) + "\\n");
  });
}
`);
  const output = [], requests = [];
  let stderr = "", completed = 0, followUpQueued = false, phase = "normal";
  child = spawn("omp", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "-e", fixture], {
    cwd: project,
    env: { ...process.env, PI_CONFIG_DIR: relative(homedir(), join(sandbox, "config")), PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", MULTI_SUB: "", OPENAI_API_KEY: "dummy-offline-key" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = command => child.stdin.write(JSON.stringify(command) + "\n");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const event = JSON.parse(line); output.push(event);
    if (event.type === "per_turn_ready") send({ type: "prompt", message: "same user prompt" });
    if (event.type === "per_turn_request") {
      requests.push(event);
      if (!followUpQueued) {
        followUpQueued = true;
        send({ type: "follow_up", message: "same user prompt" });
        send({ id: "queued-state", type: "get_state" });
      }
    }
    if (event.type === "agent_end" && phase === "normal") send({ id: "settled", type: "get_state" });
    if (event.type === "auto_retry_start" && phase === "await-retry") {
      phase = "aborting";
      send({ id: "abort-retry", type: "abort" });
    }
    if (event.id === "abort-retry" && event.success) {
      phase = "after-abort";
      send({ type: "prompt", message: "same user prompt" });
    }
    if (event.type === "agent_end" && phase === "after-abort") send({ id: "final-state", type: "get_state" });
    if (event.id === "final-state" && event.success) child.stdin.end();
    if (event.id === "settled" && event.success) {
      assert.equal(event.data.isStreaming, false);
      completed++;
      if (completed < 3) send({ type: "prompt", message: "same user prompt" });
      else {
        phase = "await-retry";
        send({ type: "prompt", message: "fail for abort" });
      }
    }
  });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("OMP request checks timed out: " + JSON.stringify({ phase, completed, events: output.filter(e => e.type.startsWith("per_turn_") || e.type.startsWith("auto_retry_") || e.type === "session_settled" || e.type === "agent_end" || e.type === "response").map(e => ({ type: e.type, id: e.id, command: e.command, success: e.success, provider: e.provider, prompt: e.prompt, isStreaming: e.data?.isStreaming, isSettled: e.data?.isSettled })) }) + stderr)); }, 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exit, 0, stderr);
  assert.doesNotMatch(stderr, /Failed to load extension/);
  assert.ok(!output.some(event => event.type === "extension_error" || event.type === "error" || (event.type === "response" && !event.success)), JSON.stringify(output) + stderr);
  assert.equal(output.find(event => event.id === "queued-state")?.data.isStreaming, true, "follow-up was queued while the first request was running");
  assert.deepEqual(requests.map(request => request.provider), ["per-turn-b", "per-turn-a", "per-turn-b", "per-turn-a", "per-turn-b", "per-turn-a"], "native requests: " + JSON.stringify(output.filter(event => event.type.startsWith("per_turn_"))));
  assert.deepEqual(output.filter(event => event.type === "per_turn_start").map(event => event.prompt), ["same user prompt", "same user prompt", "same user prompt", "same user prompt", "fail for abort", "same user prompt"]);
  assert.ok(output.some(event => event.type === "auto_retry_end" && event.success === false), "native retry cancellation was exercised");
  assert.ok(requests.every(request => request.model === "test-model"));
  console.log("Native OMP request checks passed: fresh and queued prompts alternate; retry cancellation; model ID preserved; no network calls");
} finally {
  child?.kill();
  rmSync(fixture, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
