import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "multi-pass-omp-"));
const underTest = join(root, "tests", `.omp-under-test-${process.pid}.ts`);
const fixture = join(root, "tests", `.omp-probe-${process.pid}.ts`);
try {
  const agentDir = join(sandbox, "agent");
  const project = join(sandbox, "project");
  mkdirSync(agentDir);
  mkdirSync(join(project, ".omp"), { recursive: true });
  writeFileSync(join(project, ".omp", "multi-pass.json"), JSON.stringify({ allowedSubs: ["openai-codex-2", "openai-codex-3"] }));
  const providers = ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli", "google-antigravity", "minimax", "minimax-cn"];
  writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
    subscriptions: [...providers.map(provider => ({ provider, index: 2 })), { provider: "openai-codex", index: 3 }],
    pools: [{ name: "codex", baseProvider: "openai-codex", members: ["openai-codex-2", "openai-codex-3", "openai-codex"], enabled: true }],
    chains: [], presets: [], tokenKeeper: true,
  }));
  writeFileSync(underTest, readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8") + `\nexport { getAuthStorage, keepFreshCredential, importShareBundle, loadEffectiveConfig, createStatusBarComponent, createModelInterceptEditor };\n`);
  writeFileSync(fixture, `
import assert from "node:assert/strict";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import multiSub, { getAuthStorage, keepFreshCredential, importShareBundle, loadEffectiveConfig, createStatusBarComponent, createModelInterceptEditor } from ${JSON.stringify(`./.omp-under-test-${process.pid}.ts`)};
import { ompAuth, oauthProvider, getModels, isOmp } from "../lib/host.ts";
export default async function probe(pi) {
  globalThis.fetch = async () => { throw new Error("Network disabled in compatibility checks"); };
  assert.equal(isOmp, true);
  const token = { type: "oauth", access: "dummy-access", refresh: "dummy-refresh", expires: Date.now() + 86400000, accountId: "test-account", email: "test@example.invalid", projectId: "test-project" };
  for (const provider of ["openai-codex", "openai-codex-2", "openai-codex-3", "anthropic-2"]) await ompAuth.credentials.set(provider, token);
  await ompAuth.credentials.set("minimax-2", { type: "api_key", key: "dummy-minimax" });
  const registrations = new Map(), commands = new Map(), events = new Map(), switches = [], prompts = [], notices = [];
  const wrapped = new Proxy(pi, { get(target, key) {
    if (key === "registerProvider") return (name, config) => { registrations.set(name, config); pi.registerProvider(name, config); };
    if (key === "registerCommand") return (name, config) => { commands.set(name, config); pi.registerCommand(name, config); };
    if (key === "on") return (name, handler) => { const handlers = events.get(name) || []; handlers.push(handler); events.set(name, handlers); };
    if (key === "setModel") return async model => { switches.push(model); return true; };
    if (key === "sendUserMessage") return (...args) => prompts.push(args);
    return target[key];
  }});
  multiSub(wrapped);
  assert.equal(registrations.size, 8);
  for (const provider of ${JSON.stringify(providers)}) {
    const config = registrations.get(provider + "-2");
    assert.ok(config.models.length, provider + " has models");
    assert.ok(config.models.every(model => model.api), provider + " has API types");
    assert.equal(typeof config.fetchDynamicModels, "function");
    assert.equal(config.refreshModels, undefined);
    if (config.oauth) {
      assert.equal(config.oauth.login, getProviderDefinition(provider).login, "host login callback retained");

    }
  }
  assert.equal(registrations.get("minimax-2").apiKey, "MINIMAX_API_KEY");
  for (const provider of ["google-gemini-cli", "google-antigravity", "github-copilot"]) {
    const structured = JSON.parse(oauthProvider(provider).getApiKey(token));
    assert.equal(structured.token, token.access);
    assert.equal(structured.projectId, token.projectId);
  }
  pi.on("session_start", async (_event, realCtx) => {
    assert.equal(getOAuthProvider("openai-codex-2").login, registrations.get("openai-codex-2").oauth.login);
    const model = realCtx.modelRegistry.getAll().find(m => m.provider === "openai-codex-2");
    assert.ok(model, "subscription models entered native registry");
    const ui = { ...realCtx.ui, notify: message => notices.push(message), setStatus() {} };
    const ctx = new Proxy(realCtx, { get(target, key) { if (key === "model") return model; if (key === "hasUI") return false; if (key === "ui") return ui; return target[key]; } });
    const emit = async (event, data) => { for (const handler of events.get(event) || []) await handler(data, ctx); };
    await emit("session_start", {});
    const auth = getAuthStorage(ctx);
    assert.equal(auth.hasAuth("openai-codex-2"), true);
    assert.equal(auth.get("openai-codex-2").accountId, "test-account");
    assert.equal(auth.hasAuth("missing-provider"), false);
    assert.deepEqual(loadEffectiveConfig(ctx.cwd).allowedProviderNames, ["openai-codex-2", "openai-codex-3"]);
    const fresh = await keepFreshCredential("openai-codex-2", "openai-codex", token);
    assert.equal(fresh.access, token.access, "valid tokens reused through native refresh ownership");
    assert.equal(ompAuth.credentials.get("openai-codex-2").access, token.access);
    // Exercise a real expired-token write under OMP's durable refresh ownership.
    const definition = getProviderDefinition("openai-codex");
    const originalRefresh = definition.refreshToken;
    let refreshCount = 0;
    definition.refreshToken = async credential => { refreshCount++; return { ...credential, access: "rotated-test-access", refresh: "rotated-test-refresh", expires: Date.now() + 86400000 }; };
    try {
      await ompAuth.credentials.set("openai-codex-3", { ...token, expires: 1 });
      const refreshed = await Promise.all([keepFreshCredential("openai-codex-3", "openai-codex"), keepFreshCredential("openai-codex-3", "openai-codex")]);
      assert.ok(refreshed.every(credential => credential.access === "rotated-test-access"));
      assert.equal(refreshCount, 1);
      assert.equal(ompAuth.credentials.get("openai-codex-3").refresh, "rotated-test-refresh");
    } finally { definition.refreshToken = originalRefresh; }
    await realCtx.modelRegistry.authStorage.credentials.reload();
    await commands.get("subs").handler("keeper", ctx);
    assert.ok(notices.some(message => message.includes("OMP manages OAuth")));
    await emit("before_agent_start", { prompt: "dummy prompt" });
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }], willContinue: true });
    assert.equal(switches.at(-1).provider, "openai-codex-3");
    assert.equal(prompts.length, 0, "host retry must not receive a duplicate prompt");
    // A new cascade with no host continuation must explicitly replay the prompt.
    await emit("session_start", {});
    await emit("before_agent_start", { prompt: "another dummy prompt" });
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }], willContinue: false });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0][0], "another dummy prompt");
    assert.equal(prompts[0][1].deliverAs, "followUp");
    const imported = await importShareBundle({ schemaVersion: 2, accounts: [{ baseProvider: "anthropic", providerName: "anthropic", credential: { type: token.type, access: token.access, refresh: token.refresh, expires: token.expires } }] });
    assert.deepEqual(imported, ["anthropic-3"]);
    assert.equal(ompAuth.credentials.get("anthropic-3").access, token.access);
    assert.equal(ompAuth.credentials.get("anthropic-2").access, token.access);
    await auth.logout("anthropic-3");
    assert.equal(auth.get("anthropic-3"), undefined);
    // OMP footer callbacks provide two arguments; the optional Pi metadata must be harmless.
    const theme = { fg: (_color, text) => text, bold: text => text };
    const footer = createStatusBarComponent({ requestRender() {} }, theme, { getGitBranch() {}, onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() }, { cwd: ctx.cwd, model, modelRegistry: ctx.modelRegistry, getContextUsage: () => undefined });
    assert.ok(footer.render(100).length);
    footer.dispose();
    process.stdout.write(JSON.stringify({ type: "multi_pass_omp_test", success: true }) + "\\n");
  });
}
`);
  const result = spawnSync("omp", ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-session", "-e", fixture], {
    cwd: project,
    env: { ...process.env, PI_CONFIG_DIR: relative(homedir(), join(sandbox, "config")), PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", MULTI_SUB: "", OPENAI_API_KEY: "dummy-offline-key" },
    input: '{"id":"commands","type":"get_available_commands"}\n', encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Failed to load extension/, result.stderr);
  const output = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(!output.some(item => item.type === "extension_error"), JSON.stringify(output.filter(item => item.type === "extension_error")));
  assert.ok(output.some(item => item.type === "multi_pass_omp_test" && item.success), result.stdout + result.stderr);
  const commands = output.find(item => item.id === "commands").data.commands;
  for (const name of ["subs", "pool", "mp-preset"]) assert.ok(commands.some(item => item.name === name), name);
  assert.equal(existsSync(join(agentDir, "auth.json")), false, "OMP must not create an unused credential mirror");
  assert.equal(existsSync(join(agentDir, "agent.db")), true);
  console.log("OMP compatibility checks passed: registration, OAuth wiring, SQLite credentials, project restrictions, failover and sharing");
} finally {
  rmSync(underTest, { force: true });
  rmSync(fixture, { force: true });
  rmSync(sandbox, { recursive: true, force: true });
}
