import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
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
  writeFileSync(underTest, readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8") + `\nexport { getAuthStorage, keepFreshCredential, resolveGoogleQuotaAccess, knownQuotaResetAt, importShareBundle, loadEffectiveConfig, codexQuotaChecker, refreshStatusBarQuota, updateStatusBarQuota, renderOmpQuotaLines, visibleWidth, createStatusBarComponent, createModelInterceptEditor };\n`);
  writeFileSync(fixture, `
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { writeFileSync } from "node:fs";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import multiSub, { getAuthStorage, keepFreshCredential, resolveGoogleQuotaAccess, knownQuotaResetAt, importShareBundle, loadEffectiveConfig, codexQuotaChecker, refreshStatusBarQuota, updateStatusBarQuota, renderOmpQuotaLines, visibleWidth, createStatusBarComponent, createModelInterceptEditor } from ${JSON.stringify(`./.omp-under-test-${process.pid}.ts`)};
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
    // Google quota refresh uses the same native ownership and persists the
    // rotated credential; the Pi-only built-in lookup is unavailable in OMP.
    for (const provider of ["google-gemini-cli", "google-antigravity"]) {
      const google = getProviderDefinition(provider);
      const originalGoogleRefresh = google.refreshToken;
      const expired = { ...token, expires: 1 };
      let googleRefreshes = 0;
      google.refreshToken = async credential => {
        googleRefreshes++;
        return { ...credential, access: "dummy-refreshed-google", refresh: "dummy-rotated-google", expires: Date.now() + 86400000 };
      };
      try {
        await ompAuth.credentials.set(provider + "-2", expired);
        const account = { providerName: provider + "-2", baseProvider: provider };
        const accesses = await Promise.all([resolveGoogleQuotaAccess(account, expired), resolveGoogleQuotaAccess(account, expired)]);
        assert.ok(accesses.every(access => access.accessToken === "dummy-refreshed-google" && access.projectId === token.projectId));
        assert.equal(googleRefreshes, 1, provider + " refresh is shared");
        assert.equal(ompAuth.credentials.get(provider + "-2").refresh, "dummy-rotated-google");
      } finally { google.refreshToken = originalGoogleRefresh; }
    }
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
    // Free Codex returned this 30-day window successfully; it must not become an error.
    const quotaAccount = { providerName: "openai-codex", baseProvider: "openai-codex", displayName: "Test Free", auth: token };
    const checkUsage = async payload => {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
      return codexQuotaChecker.check(quotaAccount);
    };
    const freeQuota = await checkUsage({ plan_type: "free", rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 2592000, reset_at: 2000000000 }, secondary_window: null,
    } });
    assert.equal(freeQuota.kind, "ready", "a valid Free window is quota data, not an error");
    assert.equal(freeQuota.worstRemainingPercent, 100);
    assert.deepEqual(freeQuota.windows, [{ label: "30d", remainingPercent: 100, resetAt: 2000000000 }]);
    assert.match(freeQuota.summary, /30d 100%/);
    assert.doesNotMatch(freeQuota.summary, /\\b(?:5h|7d)\\b|error/);
    assert.ok(freeQuota.details.some(line => line.includes("30d window: 100% left")));
    const unusualQuota = await checkUsage({ rate_limit: {
      primary_window: { used_percent: 90, limit_window_seconds: 172800 },
      secondary_window: { used_percent: 20, limit_window_seconds: 18000 },
    } });
    assert.equal(unusualQuota.kind, "low");
    assert.equal(unusualQuota.worstRemainingPercent, 10, "all returned windows constrain routing");
    assert.deepEqual(unusualQuota.windows.map(window => window.label), ["5h", "2d"]);
    const missingQuota = await checkUsage({ plan_type: "free", rate_limit: { primary_window: null } });
    assert.equal(missingQuota.kind, "error", "absent usage must not become 100% remaining");
    const malformedQuota = await checkUsage({ rate_limit: { primary_window: { limit_window_seconds: 2592000 } } });
    assert.equal(malformedQuota.kind, "error", "missing usage percentage must not become 100% remaining");
    // OMP can keep several native logins under one provider. Its first entry
    // need not be the account pinned to this session.
    const originalBase = ompAuth.credentials.get("openai-codex");
    await ompAuth.credentials.set("openai-codex", [originalBase, { ...token, access: "dummy-selected-native-access", accountId: "selected-native-account", email: "selected@example.invalid" }]);
    const selectedBase = ompAuth.credentials.list("openai-codex").find(entry => entry.credential.accountId === "selected-native-account");
    const sessionId = ctx.sessionManager.getSessionId();
    assert.equal(ompAuth.sessions.pin("openai-codex", sessionId, selectedBase.id), true);
    await realCtx.modelRegistry.authStorage.credentials.reload();
    assert.equal(ompAuth.credentials.get("openai-codex").access, originalBase.access, "raw get still returns the older first login");
    assert.equal(getAuthStorage(ctx).get("openai-codex").access, "dummy-selected-native-access", "adapter must follow OMP's session-selected login");
    assert.equal(getAuthStorage(ctx).get("openai-codex-2").access, token.access, "a single-login provider is unchanged");
    // Exercise the command's real OMP adapter: setFooter is a silent no-op in OMP.
    const widgets = [];
    let footerCalls = 0;
    const widgetUI = { ...ui, theme: { fg: (_color, text) => text },
      setFooter() { footerCalls++; },
      setWidget(key, content, options) { widgets.push({ key, content, options }); realCtx.ui.setWidget(key, content, options); },
    };
    let widgetModel = model;
    const widgetCtx = new Proxy(ctx, { get(target, key) {
      if (key === "hasUI") return true;
      if (key === "ui") return widgetUI;
      if (key === "model") return widgetModel;
      return target[key];
    } });
    globalThis.fetch = async () => new Response(JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 },
      secondary_window: { used_percent: 35, limit_window_seconds: 604800 },
    } }), { headers: { "content-type": "application/json" } });
    const originalWidgetSetter = widgetUI.setWidget;
    const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    const setColumns = width => Object.defineProperty(process.stdout, "columns", { configurable: true, value: width });
    const headroomOptions = { placement: "rightEditor", priority: -1050 };
    const headroomRows = saved => ["╭─ Headroom ───╮", "│ saved " + saved + "    │", "╰─────────────╯"];
    await commands.get("subs").handler("statusbar", widgetCtx);
    try {
      assert.match(stripVTControlCharacters(widgets.at(-1).content.join(" ")), /Multi Pass.*quota left/);
      await new Promise(resolve => refreshStatusBarQuota(widgetCtx, resolve));
      const widget = widgets.at(-1);
      assert.equal(widget.key, "multi-pass-quota");
      assert.equal(widget.options.placement, "aboveEditor");
      assert.match(widget.content.join(" "), /● codex#2.*5h 90%.*reset.*7d 65%/);
      assert.ok(widget.content.some(line => line.includes("pool: codex")), "quota widget names the current provider's active pool");
      assert.doesNotMatch(widget.content.join(" "), /○ codex  /, "project-disallowed base account hidden");
      assert.equal(footerCalls, 0, "OMP must use its working widget API");
      const escape = String.fromCharCode(27);
      const colorTheme = { fg: (color, text) => escape + "[" + ({ accent: 36, success: 32, warning: 33, error: 31, dim: 90, muted: 37 }[color] || 37) + "m" + text + escape + "[0m" };
      const coloredCtx = new Proxy(widgetCtx, { get(target, key) { return key === "ui" ? { ...widgetUI, theme: colorTheme } : target[key]; } });
      for (const width of [80, 36, 12, 5]) {
        const boxed = renderOmpQuotaLines(coloredCtx, width);
        assert.ok(boxed[0].includes("╭") && boxed.at(-1).includes("╯"), "quota has a rounded frame");
        assert.ok(boxed[0].startsWith("╭") && boxed.at(-1).startsWith("╰"), "frame uses the same default foreground as Headroom");
        const widths = boxed.map(visibleWidth);
        assert.ok(widths.every(value => value <= width), "ANSI colors and wrapping respect terminal width");
        assert.equal(new Set(widths).size, 1, "all box edges align");
        if (width === 80) assert.ok(boxed.some(line => line.includes(escape + "[32m90%")), "remaining quota uses its severity color");
      }
      setColumns(120);
      widgetUI.setWidget("headroom", headroomRows(10), headroomOptions);
      assert.match(stripVTControlCharacters(widgets.at(-1).content[0]), /Headroom.*Multi Pass/, "boxes share a row on wide terminals");
      assert.match(widgets.at(-1).content.at(-1), /╰.*╯.*╰.*╯/, "both bottom borders line up when Headroom is shorter");
      widgetModel = { ...model, provider: "anthropic" };
      widgetUI.setWidget("headroom", headroomRows(10), headroomOptions);
      assert.ok(widgets.at(-1).content.some(line => line.includes("pool: none")), "an unpooled provider does not retain the previous pool name");
      widgetModel = model;
      const tallerHeadroom = [...headroomRows(10).slice(0, -1), "│ cache 0%    │", "│ req 0       │", "│ tool 0      │", headroomRows(10).at(-1)];
      widgetUI.setWidget("headroom", tallerHeadroom, headroomOptions);
      assert.match(widgets.at(-1).content.at(-1), /╰.*╯.*╰.*╯/, "both bottom borders line up when quota is shorter");
      assert.ok(widgets.some(widget => widget.key === "headroom" && widget.content === undefined), "standalone Headroom is hidden while grouped");
      widgetUI.setWidget("another-widget", ["untouched"], { placement: "belowEditor" });
      assert.equal(widgets.at(-1).key, "another-widget", "unrelated widgets pass through");
      widgetUI.setWidget("headroom", headroomRows(11), headroomOptions);
      assert.ok(widgets.at(-1).content.some(line => line.includes("saved 11")), "Headroom updates refresh the shared row");
      setColumns(55);
      widgetUI.setWidget("headroom", headroomRows(12), headroomOptions);
      assert.deepEqual(widgets.findLast(widget => widget.key === "headroom").content, headroomRows(12), "narrow terminals keep Headroom live in its own slot");
      assert.doesNotMatch(widgets.at(-1).content[0], /Headroom/, "quota stacks separately when the row cannot fit");
      setColumns(120);
      widgetUI.setWidget("headroom", undefined, headroomOptions);
      assert.doesNotMatch(widgets.at(-1).content[0], /Headroom/, "removing Headroom removes it from the group");
      widgetUI.setWidget("headroom", headroomRows(13), headroomOptions);
      assert.match(stripVTControlCharacters(widgets.at(-1).content[0]), /Headroom.*Multi Pass/);
    } finally {
      await commands.get("subs").handler("statusbar", widgetCtx);
      if (stdoutColumns) Object.defineProperty(process.stdout, "columns", stdoutColumns);
      else delete process.stdout.columns;
    }
    assert.equal(widgets.at(-1).content, undefined, "toggle off clears widget");
    assert.equal(widgetUI.setWidget, originalWidgetSetter, "toggle off restores the host widget API");
    assert.deepEqual(widgets.findLast(widget => widget.key === "headroom").content, headroomRows(13), "toggle off restores Headroom's latest content");
    await commands.get("subs").handler("statusbar", widgetCtx);
    for (const handler of events.get("session_shutdown") || []) await handler({}, widgetCtx);
    assert.equal(widgets.at(-1).content, undefined, "interactive shutdown clears widget and timer");
    // Restart race: no native pin yet, then selection appears within the
    // five-minute cache TTL, then changes while an old quota request is pending.
    writeFileSync(ctx.cwd + "/.omp/multi-pass.json", JSON.stringify({ allowedSubs: ["openai-codex"] }));
    const startupSession = "multi-pass-startup-quota-test";
    const nativeAuth = realCtx.modelRegistry.authStorage;
    const startupCtx = new Proxy(widgetCtx, { get(target, key) {
      if (key === "sessionManager") return { getSessionId: () => startupSession };
      if (key === "model") return { ...model, provider: "openai-codex" };
      return target[key];
    } });
    const quotaCalls = [];
    const plusPayload = { plan_type: "plus", rate_limit: {
      primary_window: { used_percent: 14, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 11, limit_window_seconds: 604800 },
    } };
    const freePayload = { plan_type: "free", rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 2592000 },
    } };
    let releaseOldRequest;
    let delayOldRequest = false;
    globalThis.fetch = async (_url, options) => {
      const access = new Headers(options.headers).get("Authorization");
      quotaCalls.push(access);
      if (delayOldRequest && access === "Bearer " + originalBase.access) {
        await new Promise(resolve => { releaseOldRequest = resolve; });
      }
      return new Response(JSON.stringify(access === "Bearer dummy-selected-native-access" ? plusPayload : freePayload), { headers: { "content-type": "application/json" } });
    };
    await new Promise(resolve => updateStatusBarQuota(startupCtx, resolve));
    assert.equal(quotaCalls.length, 0, "unselected multi-account provider must not query the first login");
    assert.match(renderOmpQuotaLines(startupCtx).join(" "), /waiting for OMP account selection/);
    assert.doesNotMatch(renderOmpQuotaLines(startupCtx).join(" "), /30d|not logged in/);
    assert.equal(nativeAuth.sessions.pin("openai-codex", startupSession, selectedBase.id), true);
    await new Promise(resolve => updateStatusBarQuota(startupCtx, resolve));
    assert.equal(quotaCalls.length, 1, "a newly selected login bypasses the fresh cache TTL");
    assert.match(renderOmpQuotaLines(startupCtx).join(" "), /5h 86%.*7d 89%/);
    const firstBase = ompAuth.credentials.list("openai-codex").find(entry => entry.id !== selectedBase.id);
    assert.equal(nativeAuth.sessions.pin("openai-codex", startupSession, firstBase.id), true);
    delayOldRequest = true;
    const oldRequestDone = new Promise(resolve => updateStatusBarQuota(startupCtx, resolve));
    assert.equal(typeof releaseOldRequest, "function");
    assert.equal(nativeAuth.sessions.pin("openai-codex", startupSession, selectedBase.id), true);
    releaseOldRequest();
    await oldRequestDone;
    assert.equal(quotaCalls.length, 3, "late response triggers a fresh lookup for the current account");
    assert.match(renderOmpQuotaLines(startupCtx).join(" "), /5h 86%.*7d 89%/);
    assert.doesNotMatch(renderOmpQuotaLines(startupCtx).join(" "), /30d/, "a late response cannot overwrite the current account's quota");
    // A reset belongs to the login that produced it, even while the widget is off.
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    plusPayload.rate_limit.primary_window = { ...plusPayload.rate_limit.primary_window, used_percent: 100, reset_at: resetAt };
    await new Promise(resolve => refreshStatusBarQuota(startupCtx, resolve));
    assert.equal(knownQuotaResetAt(startupCtx, "openai-codex"), resetAt);
    assert.equal(nativeAuth.sessions.pin("openai-codex", startupSession, firstBase.id), true);
    assert.equal(knownQuotaResetAt(startupCtx, "openai-codex"), undefined, "another saved login cannot inherit the previous account's reset");
    assert.equal(nativeAuth.sessions.pin("openai-codex", startupSession, selectedBase.id), true);
    writeFileSync(ctx.cwd + "/.omp/multi-pass.json", JSON.stringify({ allowedSubs: ["openai-codex-2", "openai-codex-3"] }));
    // OMP footer callbacks provide two arguments; the optional Pi metadata must be harmless.
    const theme = { fg: (_color, text) => text, bold: text => text };
    const footer = createStatusBarComponent({ requestRender() {} }, theme, { getGitBranch() {}, onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() }, { cwd: ctx.cwd, model, modelRegistry: ctx.modelRegistry, getContextUsage: () => undefined });
    assert.ok(footer.render(100).length);
    footer.dispose();
    process.stdout.write(JSON.stringify({ type: "multi_pass_omp_test", success: true }) + "\\n");
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
  assert.ok(output.some(item => item.type === "extension_ui_request" && item.method === "setWidget" && item.widgetKey === "multi-pass-quota" && item.widgetLines?.some(line => /5h 90%.*7d 65%/.test(line))), "quota reaches OMP's native widget channel");
  assert.ok(output.some(item => item.type === "extension_ui_request" && item.widgetKey === "multi-pass-quota" && /Headroom.*Multi Pass/.test(stripVTControlCharacters(item.widgetLines?.[0] ?? ""))), "the shared row reaches OMP's native widget channel");
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
