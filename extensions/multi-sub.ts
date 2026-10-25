/**
 * Multi-Subscription extension for Pi and OMP.
 *
 * Register additional OAuth subscription accounts for any supported provider.
 * Each extra account gets its own provider name, /login entry, and cloned models.
 *
 * Features:
 *   - /subs: manage subscriptions (add, remove, login, logout, status)
 *   - /pool: define provider pools with auto-rotation on rate limit errors
 *   - Project-level pool config: .pi/multi-pass.json overrides global pools
 *   - MULTI_SUB env var for scripting
 *
 * Pool auto-rotation: group subscriptions into pools. When the active sub
 * hits a rate limit or error, automatically switch to the next available
 * sub in the pool and retry. Keeps the same model ID, just rotates the
 * provider/account.
 *
 * Config files:
 *   Global:  ~/.pi/agent/multi-pass.json  (subscriptions + default pools)
 *   Project: .pi/multi-pass.json          (pool overrides + subscription filtering)
 *
 * Project-level config can:
 *   - Define project-specific pools (override global pools)
 *   - Restrict which subscriptions are usable via "allowedSubs"
 *   - Leave pools empty to inherit global pools
 *
 * Supported providers:
 *   - anthropic          (Claude Pro/Max)
 *   - openai-codex       (ChatGPT Plus/Pro Codex)
 *   - github-copilot     (GitHub Copilot)
 *   - google-gemini-cli  (Google Cloud Code Assist)
 *   - google-antigravity (Antigravity)
 *   - minimax             (MiniMax global API key)
 *   - minimax-cn          (MiniMax China API key)
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import lockfile from "proper-lockfile";
import { decodeShareText, encodeShareFrames, encodeShareText, ShareFrameCollector, validateBundle, type ShareBundle, type SharedAccount } from "../lib/share.ts";
import { configuredModelOverride, matchesCatalogModel, mergeCatalog, minimaxBase, minimaxChoiceRank, ordinaryModelChoices, type CatalogEntry } from "../lib/model-choices.ts";
import { addUsage, parseCooldownMs, validateRoutingConfig, weightedNextMember, type AccountUsage } from "../lib/routing-insights.ts";
import { dirname, isAbsolute, join } from "path";
import { pathToFileURL } from "url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	AgentEndEvent,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	isOmp,
	projectConfigDir,
	setModelRegistry,
	ompAuth,
	oauthProvider,
	builtinProviders,
	getModels,
	BorderedLoader,
	CustomEditor,
	DynamicBorder,
	getAgentDir,
	keyHint,
	readStoredCredential,
} from "../lib/host.ts";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	Container,
	Input,
	Key,
	SelectList,
	Spacer,
	Text,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";

// ==========================================================================
// Provider templates
// ==========================================================================

type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };
type GeminiCredentials = OAuthCredentials & { projectId?: string };

// pi-ai >= 0.84 turned `@earendil-works/pi-ai/oauth` into a type-only entry:
// the runtime login/refresh helpers this extension used to import are gone.
// Resolve each built-in provider's OAuth flow from the provider catalog and
// adapt it to the legacy callback interface `pi.registerProvider()` expects.

/** Legacy extension OAuth provider shape accepted by `pi.registerProvider()`. */
interface OAuthProviderInterface {
	id?: string;
	name: string;
	isSubscription?: boolean;
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/** New pi-ai OAuth flow surface (`OAuthAuth`), resolved from the built-in catalog. */
interface BuiltinOAuthFlow {
	name: string;
	isSubscription?: boolean;
	login(interaction: {
		signal: AbortSignal;
		notify(event: AuthEventLike): void;
		prompt(prompt: AuthPromptLike): Promise<string>;
	}): Promise<OAuthCredentials>;
	refresh(credential: OAuthCredentials & { type: "oauth" }, signal: AbortSignal): Promise<OAuthCredentials>;
}

interface AuthPromptLike {
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: readonly { id: string; label: string }[];
}

interface AuthEventLike {
	type: "info" | "auth_url" | "device_code" | "progress";
	url?: string;
	instructions?: string;
	message?: string;
	userCode?: string;
	verificationUri?: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

const builtinOAuthFlows = new Map<string, BuiltinOAuthFlow>();

function getBuiltinOAuthFlow(providerId: string): BuiltinOAuthFlow {
	const cached = builtinOAuthFlows.get(providerId);
	if (cached) return cached;
	const flow = builtinProviders().find((p) => p.id === providerId)?.auth?.oauth as
		| BuiltinOAuthFlow
		| undefined;
	if (!flow || typeof flow.login !== "function" || typeof flow.refresh !== "function") {
		throw new Error(`No built-in OAuth flow available for provider "${providerId}"`);
	}
	builtinOAuthFlows.set(providerId, flow);
	return flow;
}

/** Adapt legacy OAuthLoginCallbacks to the new pi-ai AuthInteraction surface. */
function toAuthInteraction(callbacks: OAuthLoginCallbacks) {
	return {
		signal: callbacks.signal ?? new AbortController().signal,
		notify(event: AuthEventLike): void {
			if (event.type === "auth_url" && event.url) {
				callbacks.onAuth({ url: event.url, instructions: event.instructions });
			} else if (event.type === "device_code" && event.userCode && event.verificationUri) {
				callbacks.onDeviceCode({
					userCode: event.userCode,
					verificationUri: event.verificationUri,
					intervalSeconds: event.intervalSeconds,
					expiresInSeconds: event.expiresInSeconds,
					});
			} else if (event.type === "progress" && typeof event.message === "string") {
				callbacks.onProgress?.(event.message);
			}
		},
		prompt(prompt: AuthPromptLike): Promise<string> {
			if (prompt.type === "select") {
				return callbacks
					.onSelect({
						message: prompt.message,
						options: (prompt.options ?? []).map((o) => ({ id: o.id, label: o.label })),
					})
					.then((selected) => selected ?? "");
			}
			if (prompt.type === "manual_code" && callbacks.onManualCodeInput) {
				return callbacks.onManualCodeInput();
			}
			return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
		},
	};
}

function asOAuthCredential(credentials: OAuthCredentials): OAuthCredentials & { type: "oauth" } {
	const type = (credentials as { type?: string }).type;
	return type === "oauth"
		? (credentials as OAuthCredentials & { type: "oauth" })
		: { ...credentials, type: "oauth" };
}

/** Build a legacy OAuth provider config backed by a built-in provider flow. */
function flowBackedOAuth(
	providerId: string,
	name: string,
	options?: { usesCallbackServer?: boolean },
): Omit<OAuthProviderInterface, "id"> {
	if (isOmp) return { name, ...oauthProvider(providerId) };
	// Mirror the built-in flow's subscription flag so extra accounts light up
	// pi's subscription handling (e.g. the footer indicator via
	// modelRuntime.isUsingSubscription). Guarded: providers without a flow in
	// the installed pi-ai version must not break registration.
	let isSubscription: boolean | undefined;
	try {
		isSubscription = getBuiltinOAuthFlow(providerId).isSubscription;
	} catch {
		// no built-in flow available; leave the flag unset
	}
	return {
		name,
		isSubscription,
		usesCallbackServer: options?.usesCallbackServer,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			return getBuiltinOAuthFlow(providerId).login(toAuthInteraction(callbacks));
		},
		async refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
			return getBuiltinOAuthFlow(providerId).refresh(
				asOAuthCredential(credentials),
				signal ?? new AbortController().signal,
			);
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}

// GitHub Copilot base URL derivation, ported from the pi-ai OAuth flow
// (no longer part of the public pi-ai surface).

function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getBaseUrlFromCopilotToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	// Convert proxy.xxx to api.xxx
	return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

function getGitHubCopilotBaseUrl(token: string | undefined, enterpriseUrl: string | undefined): string {
	if (token) {
		const fromToken = getBaseUrlFromCopilotToken(token);
		if (fromToken) return fromToken;
	}
	const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : null;
	if (domain) return `https://copilot-api.${domain}`;
	return "https://api.individual.githubcopilot.com";
}

interface ProviderTemplate {
	displayName: string;
	apiKey?: string;
	usesCallbackServer?: boolean;
	buildOAuth?(index: number): Omit<OAuthProviderInterface, "id">;
	buildModifyModels?(providerName: string): OAuthProviderInterface["modifyModels"];
}

const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		buildOAuth(index: number) {
			return flowBackedOAuth("anthropic", `Anthropic #${index}`);
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return flowBackedOAuth("openai-codex", `ChatGPT Codex #${index}`, {
				usesCallbackServer: true,
			});
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		buildOAuth(index: number) {
			return flowBackedOAuth("github-copilot", `GitHub Copilot #${index}`);
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, creds.enterpriseUrl);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

	"google-gemini-cli": {
		displayName: "Google Cloud Code Assist",
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return flowBackedOAuth("google-gemini-cli", `Google Cloud Code Assist #${index}`, {
				usesCallbackServer: true,
			});
		},
	},

	"google-antigravity": {
		displayName: "Antigravity",
		usesCallbackServer: true,
		buildOAuth(index: number) {
			return flowBackedOAuth("google-antigravity", `Antigravity #${index}`, {
				usesCallbackServer: true,
			});
		},
	},

	minimax: {
		displayName: "MiniMax (Global)",
		apiKey: "$MINIMAX_API_KEY",
	},

	"minimax-cn": {
		displayName: "MiniMax (China)",
		apiKey: "$MINIMAX_CN_API_KEY",
	},
};

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

// ==========================================================================
// Built-in quota checking
// ==========================================================================

const DEFAULT_CODEX_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const GOOGLE_GEMINI_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GOOGLE_ANTIGRAVITY_QUOTA_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
	"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
] as const;
const GOOGLE_GEMINI_HEADERS = {
	"User-Agent": "google-api-nodejs-client/9.15.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
};
const GOOGLE_ANTIGRAVITY_HEADERS = {
	"User-Agent": "antigravity/1.11.9 windows/amd64",
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};
const GOOGLE_ANTIGRAVITY_HIDDEN_MODELS = new Set(["tab_flash_lite_preview"]);
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

type QuotaStatusKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth" | "pending-selection";

interface AuthStorageEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	projectId?: string;
	[key: string]: unknown;
}

interface AuthStorageCompat {
	hasAuth(provider: string): boolean;
	get(provider: string): AuthStorageEntry | undefined;
	logout(provider: string): Promise<void>;
}

function getAuthStorage(ctx: ExtensionContext | ExtensionCommandContext): AuthStorageCompat {
	const registry = ctx.modelRegistry as unknown as {
		authStorage?: AuthStorageCompat;
		runtime?: { logout(provider: string): Promise<void> };
		getProviderAuthStatus(provider: string): { configured: boolean };
	};
	if (isOmp) {
		const auth = (registry.authStorage ?? ompAuth) as any;
		return {
			hasAuth: (provider) => auth.keys.source(provider) !== undefined || auth.keys.keyless(provider),
			get: (provider) => {
				// OMP's raw get() returns the first saved credential, while model
				// requests use the account pinned to this session.
				const sessionId = ctx.sessionManager?.getSessionId();
				const selected = sessionId ? auth.sessions.get(provider, sessionId) : undefined;
				if (selected?.credentialId !== undefined) {
					const entry = auth.credentials.list(provider).find(
						(candidate: { id: number }) => candidate.id === selected.credentialId,
					);
					if (entry) return entry.credential;
				}
				return auth.credentials.get(provider);
			},
			logout: (provider) => auth.credentials.remove(provider),
		};
	}
	if (registry.authStorage) return registry.authStorage;

	return {
		hasAuth: (provider) => registry.getProviderAuthStatus(provider).configured,
		get: (provider) => readStoredCredential(provider) as AuthStorageEntry | undefined,
		logout: async (provider) => {
			if (!registry.runtime) {
				throw new Error("This pi version does not expose credential logout");
			}
			await registry.runtime.logout(provider);
		},
	};
}

// ==========================================================================
// Shared auth.json access and OAuth token keeper
// ==========================================================================

type AuthFile = Record<string, AuthStorageEntry>;

/** Treat a stored token as usable while it has at least this much validity. */
const AUTH_REFRESH_SKEW_MS = 60_000;
/** Refresh this far ahead of expiry, before pi's own five-minute window. */
const TOKEN_KEEPER_LEAD_MS = 15 * 60_000;
const TOKEN_KEEPER_INTERVAL_MS = 60_000;
const TOKEN_REFRESH_TIMEOUT_MS = 25_000;

function getAuthFilePath(): string {
	return join(getAgentDir(), "auth.json");
}

function readAuthFile(path = getAuthFilePath()): AuthFile {
	if (isOmp) return Object.fromEntries(Object.entries(ompAuth.credentials.all())
		.map(([provider, credential]) => [provider, Array.isArray(credential) ? credential[0] : credential]));
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf-8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	return parsed as AuthFile;
}

/**
 * Run `edit` while holding the same lock pi takes for auth.json, writing the
 * map back only when the edit reports a change.
 */
async function withAuthFile<T>(
	edit: (stored: AuthFile) => Promise<{ value: T; changed?: boolean }> | { value: T; changed?: boolean },
): Promise<T> {
	const path = isOmp ? join(getAgentDir(), "multi-pass-auth") : getAuthFilePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	if (!existsSync(path)) writeFileSync(path, "{}", { mode: 0o600 });
	const release = await lockfile.lock(path, { realpath: false, retries: { retries: 10, minTimeout: 50 } });
	try {
		if (isOmp) await ompAuth.credentials.reload();
		const stored = readAuthFile(path);
		const previous = { ...stored };
		const { value, changed } = await edit(stored);
		if (changed && isOmp) {
			for (const [provider, credential] of Object.entries(stored)) {
				if (credential !== previous[provider]) await ompAuth.credentials.set(provider, credential);
			}
			// Deletions must propagate too: an edit that removed a provider
			// would otherwise survive in the OMP credential store forever.
			for (const provider of Object.keys(previous)) {
				if (!(provider in stored)) await ompAuth.credentials.remove(provider);
			}
		} else if (changed) writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
		return value;
	} finally {
		await release();
	}
}

function isOAuthEntry(
	entry: AuthStorageEntry | undefined,
): entry is AuthStorageEntry & { type: "oauth"; refresh: string; expires: number } {
	return entry?.type === "oauth"
		&& typeof entry.refresh === "string"
		&& entry.refresh.length > 0
		&& typeof entry.expires === "number";
}

/** Base provider of a stored account name, e.g. `anthropic-2` -> `anthropic`. */
function baseProviderForAccount(account: string): string | undefined {
	if (PROVIDER_TEMPLATES[account]?.buildOAuth) return account;
	const base = account.match(/^(.+)-\d+$/)?.[1];
	return base && PROVIDER_TEMPLATES[base]?.buildOAuth ? base : undefined;
}

const refreshesInFlight = new Map<string, Promise<OAuthCredentials>>();

/**
 * Refresh `account` and store the rotated credential in the same locked
 * transaction. Anthropic and OpenAI invalidate the old refresh token the
 * moment they answer, so a rotation that is not written costs the login:
 * pi drops it whenever its 15s refresh deadline or its auth.json lock runs
 * out first, which is routine with many concurrent sessions.
 */
function keepFreshCredential(
	account: string,
	baseProvider: string,
	hint?: OAuthCredentials,
	refreshSkewMs = AUTH_REFRESH_SKEW_MS,
): Promise<OAuthCredentials> {
	if (isOmp) {
		return ompAuth.oauth.refreshStored(account, {
			observedCredential: hint && asOAuthCredential(hint),
			credentialFromRow: (credential: AuthStorageEntry) => isOAuthEntry(credential) ? credential : undefined,
			refreshSkewMs,
			refreshTimeoutMs: TOKEN_REFRESH_TIMEOUT_MS,
			refresh: oauthProvider(baseProvider)!.refreshToken,
		}).then(({ credential }: any) => {
			if (!credential) throw new Error(`No refresh token stored for ${account}`);
			return credential;
		});
	}
	const inFlight = refreshesInFlight.get(account);
	if (inFlight) return inFlight;

	const run = withAuthFile(async (stored) => {
		const current = stored[account];
		if (isOAuthEntry(current) && current.expires > Date.now() + refreshSkewMs) {
			return { value: current as unknown as OAuthCredentials };
		}
		const credential = isOAuthEntry(current) ? current : hint;
		if (!credential || typeof credential.refresh !== "string" || credential.refresh.length === 0) {
			throw new Error(`No refresh token stored for ${account}`);
		}
		const refreshed = await getBuiltinOAuthFlow(baseProvider).refresh(
			asOAuthCredential(credential as OAuthCredentials),
			AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
		);
		stored[account] = { ...current, ...refreshed, type: "oauth" };
		return { value: refreshed, changed: true };
	}).finally(() => refreshesInFlight.delete(account));

	refreshesInFlight.set(account, run);
	return run;
}

let tokenKeeperTimer: ReturnType<typeof setInterval> | undefined;

/** Opt-in: `"tokenKeeper": true` in ~/.pi/agent/multi-pass.json, or /subs keeper. */
function isTokenKeeperEnabled(): boolean {
	return !isOmp && loadGlobalConfig().tokenKeeper === true;
}

/**
 * Renew every stored subscription token ahead of pi's own refresh window so
 * the rotation happens once per machine instead of racing in each session.
 * Covers built-in logins too, which pi otherwise refreshes per process.
 */
function startTokenKeeper(): void {
	if (isOmp || tokenKeeperTimer || !isTokenKeeperEnabled()) return;

	const tick = async (): Promise<void> => {
		let stored: AuthFile;
		try {
			stored = readAuthFile();
		} catch {
			return;
		}
		for (const [account, credential] of Object.entries(stored)) {
			if (!isOAuthEntry(credential)) continue;
			if (credential.expires > Date.now() + TOKEN_KEEPER_LEAD_MS) continue;
			const baseProvider = baseProviderForAccount(account);
			if (!baseProvider) continue;
			await keepFreshCredential(account, baseProvider, undefined, TOKEN_KEEPER_LEAD_MS).catch(() => {});
		}
	};

	tokenKeeperTimer = setInterval(() => void tick(), TOKEN_KEEPER_INTERVAL_MS);
	tokenKeeperTimer.unref?.();
	void tick();
}

function stopTokenKeeper(): void {
	if (!tokenKeeperTimer) return;
	clearInterval(tokenKeeperTimer);
	tokenKeeperTimer = undefined;
}

interface QuotaAccount {
	providerName: string;
	baseProvider: string;
	displayName: string;
	auth?: AuthStorageEntry;
	pendingSelection?: boolean;
}

/** Structured quota window used by the card renderer. */
interface QuotaDisplayWindow {
	/** Short label, e.g. "5h", "7d", "7d Opus", or a Google model name. */
	label: string;
	remainingPercent?: number;
	resetAt?: number;
}

/** Codex-only: stored rate-limit reset credits summary. */
interface QuotaResetCredits {
	available: number;
	/** Credits applicable to the current rate-limit window right now. */
	applicable: number;
}

interface QuotaCheckResult {
	account: QuotaAccount;
	kind: QuotaStatusKind;
	summary: string;
	details: string[];
	score: number;
	/** Structured fields consumed by the TUI card renderer. The flat
	 * `details` array is kept for text drilldown and non-UI fallback. */
	planType?: string;
	email?: string;
	windows?: QuotaDisplayWindow[];
	models?: QuotaDisplayWindow[];
	worstRemainingPercent?: number;
	resetCredits?: QuotaResetCredits;
	extraUsage?: boolean;
	projectId?: string;
}

interface ProviderQuotaChecker {
	baseProvider: string;
	check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult>;
}

interface CodexUsageWindow {
	usedPercent: number;
	windowSeconds: number;
	resetAt?: number;
}

interface AnthropicUsageWindow {
	/** Window label, e.g. "5h", "7d", or "7d Opus" for model-scoped limits */
	label: string;
	remainingPercent: number;
	resetAt?: number;
}

interface AnthropicUsageSnapshot {
	planType: string;
	email: string;
	windows: AnthropicUsageWindow[];
}

interface CodexUsageSnapshot {
	planType: string;
	email: string;
	windows: CodexUsageWindow[];
}

interface GoogleGeminiQuotaResponse {
	buckets?: Array<{
		modelId?: string;
		remainingFraction?: number;
		resetTime?: string;
	}>;
}

interface GoogleAntigravityQuotaResponse {
	models?: Record<
		string,
		{
			displayName?: string;
			model?: string;
			isInternal?: boolean;
			quotaInfo?: {
				remainingFraction?: number;
				resetTime?: string;
			};
		}
	>;
}

interface GoogleQuotaModelSnapshot {
	model: string;
	remainingPercent?: number;
	resetAt?: number;
}

interface GoogleQuotaAccountSnapshot {
	endpoint: string;
	projectId?: string;
	models: GoogleQuotaModelSnapshot[];
	worstRemainingPercent?: number;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function getCodexTokenMetadata(accessToken: string): {
	accountId?: string;
	planType?: string;
	email?: string;
} {
	const payload = decodeJwtPayload(accessToken);
	const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
	const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	const email = typeof profile?.email === "string" ? profile.email : undefined;
	return { accountId, planType, email };
}

function normalizeCodexUsageWindow(window: unknown): CodexUsageWindow | undefined {
	const raw = getRecord(window);
	if (!raw) return undefined;
	const usedPercent = raw.used_percent;
	const windowSeconds = raw.limit_window_seconds;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)
		|| typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return undefined;
	const resetAt = typeof raw.reset_at === "number" ? raw.reset_at : undefined;
	return {
		usedPercent,
		windowSeconds,
		resetAt,
	};
}

function matchesUsageWindow(window: CodexUsageWindow | undefined, expectedSeconds: number): boolean {
	if (!window) return false;
	return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function codexWindowLabel(window: CodexUsageWindow): string {
	if (matchesUsageWindow(window, 5 * 60 * 60)) return "5h";
	if (matchesUsageWindow(window, 7 * 24 * 60 * 60)) return "7d";
	const seconds = window.windowSeconds;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function parseCodexUsageSnapshot(data: unknown): CodexUsageSnapshot {
	const raw = getRecord(data);
	const rateLimit = getRecord(raw?.rate_limit);
	const windows = [
		normalizeCodexUsageWindow(rateLimit?.primary_window),
		normalizeCodexUsageWindow(rateLimit?.secondary_window),
	].filter((window): window is CodexUsageWindow => Boolean(window))
		.sort((a, b) => a.windowSeconds - b.windowSeconds);
	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : "unknown",
		email: typeof raw?.email === "string" ? raw.email : "",
		windows,
	};
}

function getCodexWindowRemaining(window: CodexUsageWindow | undefined): number | undefined {
	if (!window) return undefined;
	return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

/** Parse `rate_limit_reset_credits` from the Codex usage payload. These
 * are stored resets that reduce the Codex rate limit when applied; the
 * `applicable_available_count` subset is usable against the current
 * window right now. */
function parseCodexResetCredits(data: unknown): QuotaResetCredits | undefined {
	const raw = getRecord(getRecord(data)?.rate_limit_reset_credits);
	if (!raw) return undefined;
	const available = typeof raw.available_count === "number" ? raw.available_count : 0;
	if (available <= 0) return undefined;
	const applicable = typeof raw.applicable_available_count === "number"
		? raw.applicable_available_count
		: 0;
	return { available, applicable };
}

function formatResetShort(resetAt?: number): string {
	if (!resetAt) return "--";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `~${days}d`;
	if (hours > 0) return `~${hours}h`;
	return `~${minutes}m`;
}

function formatResetLong(resetAt?: number): string {
	if (!resetAt) return "unknown";
	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${minutes}m`;
	return `in ${minutes}m`;
}

function formatRemainingPercent(value: number | undefined): string {
	if (value === undefined) return "--";
	return `${Math.round(value)}%`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function parseIsoTimestampSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.floor(parsed / 1000);
}

async function readResponseError(response: Response): Promise<string> {
	const raw = await response.text();
	if (response.status === 401) {
		return "Unauthorized - log in again";
	}
	if (!raw) {
		return `HTTP ${response.status}`;
	}
	try {
		const parsed = JSON.parse(raw) as {
			error?: { message?: string };
			message?: string;
		};
		const message = parsed.error?.message || parsed.message;
		if (message) return `HTTP ${response.status}: ${message}`;
	} catch {
		// ignore JSON parse errors and fall back to raw text
	}
	return `HTTP ${response.status}: ${raw}`;
}

function classifyCodexQuotaKind(snapshot: CodexUsageSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const values = snapshot.windows.map(getCodexWindowRemaining).filter((value): value is number => value !== undefined);
	if (values.length === 0) {
		return { kind: "error", score: 0 };
	}
	const bottleneck = Math.min(...values);
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

function formatQuotaKind(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "ready";
		case "watch":
			return "watch";
		case "low":
			return "low";
		case "blocked":
			return "blocked";
		case "missing-auth":
			return "not logged in";
		case "pending-selection":
			return "waiting for account";
		default:
			return "error";
	}
}

function compareQuotaResults(left: QuotaCheckResult, right: QuotaCheckResult): number {
	const rank = (kind: QuotaStatusKind): number => {
		switch (kind) {
			case "ready":
				return 0;
			case "watch":
				return 1;
			case "low":
				return 2;
			case "blocked":
				return 3;
			case "error":
				return 4;
			case "missing-auth":
				return 5;
			case "pending-selection":
				return 6;
		}
	};
	return rank(left.kind) - rank(right.kind)
		|| right.score - left.score
		|| left.account.displayName.localeCompare(right.account.displayName);
}

function getQuotaStatusGlyph(kind: QuotaStatusKind): string {
	switch (kind) {
		case "ready":
			return "✓";
		case "watch":
			return "◔";
		case "low":
			return "!";
		case "blocked":
			return "✕";
		case "missing-auth":
			return "○";
		case "pending-selection":
			return "…";
		default:
			return "?";
	}
}

function formatQuotaOverview(results: QuotaCheckResult[]): string {
	const counts = {
		ready: 0,
		watch: 0,
		low: 0,
		blocked: 0,
		error: 0,
		missingAuth: 0,
		pending: 0,
	};

	for (const result of results) {
		switch (result.kind) {
			case "ready":
				counts.ready++;
				break;
			case "watch":
				counts.watch++;
				break;
			case "low":
				counts.low++;
				break;
			case "blocked":
				counts.blocked++;
				break;
			case "missing-auth":
				counts.missingAuth++;
				break;
			case "pending-selection":
				counts.pending++;
				break;
			default:
				counts.error++;
		}
	}

	const parts = [`${results.length} ${results.length === 1 ? "account" : "accounts"}`];
	if (counts.ready > 0) parts.push(`${counts.ready} ready`);
	if (counts.watch > 0) parts.push(`${counts.watch} watch`);
	if (counts.low > 0) parts.push(`${counts.low} low`);
	if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
	if (counts.error > 0) parts.push(`${counts.error} error`);
	if (counts.missingAuth > 0) parts.push(`${counts.missingAuth} not logged in`);
	if (counts.pending > 0) parts.push(`${counts.pending} waiting for account`);

	const best = results[0];
	if (best) {
		parts.push(`best now: ${best.account.displayName}`);
	}

	return parts.join(" • ");
}

function formatQuotaCurrentHint(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
): string | undefined {
	if (!currentProviderName) return undefined;

	const current = results.find((result) => result.account.providerName === currentProviderName);
	if (!current) return undefined;

	let hint = `Current: ${current.account.displayName} is ${formatQuotaKind(current.kind)}`;
	const best = results[0];
	if (best && best.account.providerName !== current.account.providerName) {
		hint += ` • best available: ${best.account.displayName}`;
	}
	if (current.kind !== "ready") {
		hint += " • snapshot only: auto-switch happens after a runtime rate-limit error";
	}
	return hint;
}

function buildQuotaSelectItems(
	results: QuotaCheckResult[],
	currentProviderName: string | undefined,
): SelectItem[] {
	const bestProviderName = results[0]?.account.providerName;
	return results.map((result) => {
		const badges: string[] = [];
		if (result.account.providerName === currentProviderName) badges.push("current");
		if (result.account.providerName === bestProviderName) badges.push("best now");
		const badgeSuffix = badges.length > 0 ? ` • ${badges.join(" • ")}` : "";

		return {
			value: result.account.providerName,
			label: `${getQuotaStatusGlyph(result.kind)} ${result.account.displayName}`,
			description: `${result.summary}${badgeSuffix}`,
		};
	});
}

function getWrappedSelectIndex(items: SelectItem[], value: string | undefined): number {
	if (!value) return 0;
	const index = items.findIndex((item) => item.value === value);
	return index >= 0 ? index : 0;
}

async function showWrappedSelect(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		items: SelectItem[];
		subtitle?: string;
		initialValue?: string;
		confirmHint?: string;
		cancelHint?: string;
	},
): Promise<string | undefined> {
	if (options.items.length === 0) return undefined;

	if (!ctx.hasUI) {
		const renderedItems = options.items.map((item) =>
			item.description ? `${item.label} — ${item.description}` : item.label,
		);
		const selected = await ctx.ui.select(options.title, renderedItems);
		if (!selected) return undefined;
		const index = renderedItems.indexOf(selected);
		return index >= 0 ? options.items[index]?.value : undefined;
	}

	const confirmHint = options.confirmHint || "select";
	const cancelHint = options.cancelHint || "close";

	const selectedValue = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		const footer = [
			keyHint("tui.select.confirm", confirmHint),
			keyHint("tui.select.cancel", cancelHint),
		].join(" • ");

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));
		if (options.subtitle) {
			container.addChild(new Text(theme.fg("dim", options.subtitle)));
		}

		const selectList = new SelectList(options.items, Math.min(options.items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.setSelectedIndex(getWrappedSelectIndex(options.items, options.initialValue));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", footer)));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				const current = selectList.getSelectedItem();
				const currentIndex = current
					? options.items.findIndex((item) => item.value === current.value)
					: 0;

				if (matchesKey(data, Key.up) && options.items.length > 1 && currentIndex === 0) {
					selectList.setSelectedIndex(options.items.length - 1);
					tui.requestRender();
					return;
				}

				if (
					matchesKey(data, Key.down)
					&& options.items.length > 1
					&& currentIndex === options.items.length - 1
				) {
					selectList.setSelectedIndex(0);
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedValue ?? undefined;
}

const QUOTA_CHECK_TIMEOUT_MS = 10_000;

async function runQuotaChecks(
	accounts: QuotaAccount[],
	signal?: AbortSignal,
): Promise<QuotaCheckResult[]> {
	const deadline = AbortSignal.timeout(QUOTA_CHECK_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const results = await Promise.all(accounts.map(async (account) => {
		if (account.pendingSelection) return {
			account,
			kind: "pending-selection" as const,
			summary: "waiting for OMP account selection",
			details: ["OMP has multiple saved logins for this provider and has not selected one for this session yet."],
			score: 0,
		};
		const checker = PROVIDER_QUOTA_CHECKERS.find(
			(candidate) => candidate.baseProvider === account.baseProvider,
		);
		if (!checker) return undefined;
		let onAbort: (() => void) | undefined;
		try {
			requestSignal.throwIfAborted();
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(requestSignal.reason);
				requestSignal.addEventListener("abort", onAbort, { once: true });
			});
			// Bound the entire checker, including refresh implementations that do
			// not observe cancellation. Late completions cannot replace this result.
			return await Promise.race([
				new Promise<QuotaCheckResult>((resolve) => resolve(checker.check(account, requestSignal))),
				aborted,
			]);
		} catch (error) {
			return {
				account,
				kind: "error" as const,
				summary: requestSignal.aborted ? "quota check cancelled or timed out" : "quota check failed",
				details: [error instanceof Error ? error.message : String(error)],
				score: 0,
			};
		} finally {
			if (onAbort) requestSignal.removeEventListener("abort", onAbort);
		}
	}));

	return results
		.filter((result): result is QuotaCheckResult => Boolean(result))
		.sort(compareQuotaResults);
}

async function loadQuotaResults(
	ctx: ExtensionCommandContext,
	accounts: QuotaAccount[],
): Promise<QuotaCheckResult[] | null> {
	if (!ctx.hasUI) {
		return runQuotaChecks(accounts);
	}

	return ctx.ui.custom<QuotaCheckResult[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(
			tui,
			theme,
			`Checking limits across ${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}...`,
		);
		loader.onAbort = () => done(null);

		runQuotaChecks(accounts, loader.signal)
			.then(done)
			.catch((error) => {
				if (loader.signal.aborted) {
					done(null);
					return;
				}
				console.error("Failed to load quota checks", error);
				done(null);
			});

		return loader;
	});
}

async function selectQuotaResult(
	ctx: ExtensionCommandContext,
	results: QuotaCheckResult[],
	preferredProviderName?: string,
): Promise<QuotaCheckResult | undefined> {
	const currentProviderName = preferredProviderName || ctx.model?.provider;
	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Subscription Limits",
		subtitle: [
			"Select an account to inspect its full quota windows.",
			formatQuotaOverview(results),
			formatQuotaCurrentHint(results, currentProviderName),
		].filter(Boolean).join("\n"),
		items: buildQuotaSelectItems(results, currentProviderName),
		initialValue: currentProviderName,
		confirmHint: "inspect",
		cancelHint: "close",
	});
	if (!selectedProviderName) return undefined;
	return results.find((result) => result.account.providerName === selectedProviderName);
}

function normalizeGoogleRemainingPercent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function getGoogleProjectId(account: QuotaAccount, auth: AuthStorageEntry): string | undefined {
	if (typeof auth.projectId === "string" && auth.projectId.length > 0) {
		return auth.projectId;
	}

	if (account.baseProvider === "google-antigravity") {
		const projectId = process.env.GOOGLE_ANTIGRAVITY_PROJECT_ID || process.env.GOOGLE_ANTIGRAVITY_PROJECT;
		if (projectId) return projectId;
	}

	const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	return projectId || undefined;
}

function updateGoogleQuotaModel(
	modelsByName: Map<string, GoogleQuotaModelSnapshot>,
	model: string,
	remainingPercent: number | undefined,
	resetAt: number | undefined,
): void {
	const existing = modelsByName.get(model);
	if (!existing) {
		modelsByName.set(model, { model, remainingPercent, resetAt });
		return;
	}

	let next = existing;
	if (remainingPercent !== undefined) {
		if (existing.remainingPercent === undefined || remainingPercent < existing.remainingPercent) {
			next = { ...next, remainingPercent };
		}
	}
	if (resetAt !== undefined) {
		if (next.resetAt === undefined || resetAt < next.resetAt) {
			next = { ...next, resetAt };
		}
	}
	if (next !== existing) {
		modelsByName.set(model, next);
	}
}

function buildGoogleQuotaSnapshot(
	endpoint: string,
	projectId: string | undefined,
	modelsByName: Map<string, GoogleQuotaModelSnapshot>,
): GoogleQuotaAccountSnapshot {
	const models = [...modelsByName.values()];
	const remainingPercents = models
		.map((model) => model.remainingPercent)
		.filter((value): value is number => value !== undefined);
	const worstRemainingPercent = remainingPercents.length > 0
		? Math.min(...remainingPercents)
		: undefined;

	return {
		endpoint,
		projectId,
		models,
		worstRemainingPercent,
	};
}

function getGoogleGeminiModelLabel(modelId: string | undefined): string {
	if (!modelId) return "unknown";
	const normalized = modelId.toLowerCase();
	if (normalized.includes("pro")) return "Pro";
	if (normalized.includes("flash")) return "Flash";
	return modelId;
}

function parseGoogleGeminiQuotaSnapshot(
	data: unknown,
	projectId: string | undefined,
): GoogleQuotaAccountSnapshot {
	const raw = getRecord(data) as GoogleGeminiQuotaResponse | undefined;
	const buckets = Array.isArray(raw?.buckets) ? raw.buckets : [];
	const modelsByName = new Map<string, GoogleQuotaModelSnapshot>();

	for (const bucketValue of buckets) {
		const bucket = getRecord(bucketValue);
		const model = getGoogleGeminiModelLabel(
			typeof bucket?.modelId === "string" ? bucket.modelId : undefined,
		);
		const remainingPercent = normalizeGoogleRemainingPercent(bucket?.remainingFraction);
		const resetAt = typeof bucket?.resetTime === "string"
			? parseIsoTimestampSeconds(bucket.resetTime)
			: undefined;
		if (remainingPercent === undefined && resetAt === undefined) continue;
		updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt);
	}

	return buildGoogleQuotaSnapshot(GOOGLE_GEMINI_QUOTA_ENDPOINT, projectId, modelsByName);
}

function parseGoogleAntigravityQuotaSnapshot(
	data: unknown,
	endpoint: string,
	projectId: string | undefined,
): GoogleQuotaAccountSnapshot {
	const raw = getRecord(data) as GoogleAntigravityQuotaResponse | undefined;
	const rawModels = getRecord(raw?.models);
	const modelsByName = new Map<string, GoogleQuotaModelSnapshot>();

	if (rawModels) {
		for (const [modelKey, modelValue] of Object.entries(rawModels)) {
			const model = getRecord(modelValue);
			if (model?.isInternal === true) continue;
			if (GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(modelKey.toLowerCase())) continue;
			const displayName = typeof model?.displayName === "string" && model.displayName.length > 0
				? model.displayName
				: typeof model?.model === "string" && model.model.length > 0
					? model.model
					: modelKey;
			if (GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(displayName.toLowerCase())) continue;
			const quotaInfo = getRecord(model?.quotaInfo);
			const remainingPercent = normalizeGoogleRemainingPercent(quotaInfo?.remainingFraction);
			const resetAt = typeof quotaInfo?.resetTime === "string"
				? parseIsoTimestampSeconds(quotaInfo.resetTime)
				: undefined;
			if (remainingPercent === undefined && resetAt === undefined) continue;
			updateGoogleQuotaModel(modelsByName, displayName, remainingPercent, resetAt);
		}
	}

	return buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName);
}

function classifyGoogleQuotaKind(snapshot: GoogleQuotaAccountSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	const bottleneck = snapshot.worstRemainingPercent;
	if (bottleneck === undefined) {
		return { kind: "error", score: 0 };
	}
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

async function resolveGoogleQuotaAccess(
	account: QuotaAccount,
	auth: AuthStorageEntry,
): Promise<{ accessToken: string; projectId?: string }> {
	const projectId = getGoogleProjectId(account, auth);
	const hasFreshAccess = typeof auth.access === "string"
		&& auth.access.length > 0
		&& (typeof auth.expires !== "number" || auth.expires > Date.now() + 60_000);
	if (hasFreshAccess) {
		return { accessToken: auth.access!, projectId };
	}

	if (typeof auth.refresh === "string" && auth.refresh.length > 0) {
		const credentials = await keepFreshCredential(
			account.providerName,
			account.baseProvider,
			asOAuthCredential({
				...auth,
				access: auth.access ?? "",
				refresh: auth.refresh,
				expires: auth.expires ?? 0,
				projectId,
			}),
		) as GeminiCredentials;
		return {
			accessToken: credentials.access,
			projectId: typeof credentials.projectId === "string" && credentials.projectId.length > 0
				? credentials.projectId
				: projectId,
		};
	}

	if (typeof auth.access === "string" && auth.access.length > 0) {
		return { accessToken: auth.access, projectId };
	}

	throw new Error("Missing Google access token. Log in again.");
}

async function fetchGoogleGeminiQuotaSnapshot(
	accessToken: string,
	projectId: string | undefined,
	signal?: AbortSignal,
): Promise<GoogleQuotaAccountSnapshot> {
	const response = await fetch(GOOGLE_GEMINI_QUOTA_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			...GOOGLE_GEMINI_HEADERS,
		},
		body: "{}",
		signal,
	});
	if (!response.ok) {
		throw new Error(await readResponseError(response));
	}
	return parseGoogleGeminiQuotaSnapshot(await response.json(), projectId);
}

async function fetchGoogleAntigravityQuotaSnapshot(
	accessToken: string,
	projectId: string | undefined,
	signal?: AbortSignal,
): Promise<GoogleQuotaAccountSnapshot> {
	let lastError = "Google quota lookup failed";

	for (const endpoint of GOOGLE_ANTIGRAVITY_QUOTA_ENDPOINTS) {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				...GOOGLE_ANTIGRAVITY_HEADERS,
			},
			body: JSON.stringify(projectId ? { project: projectId } : {}),
			signal,
		});
		if (response.ok) {
			return parseGoogleAntigravityQuotaSnapshot(await response.json(), endpoint, projectId);
		}
		lastError = await readResponseError(response);
	}

	throw new Error(lastError);
}

function getGoogleQuotaBucketLabel(account: QuotaAccount, count: number): string {
	if (account.baseProvider === "google-gemini-cli") {
		return `${count} ${count === 1 ? "family" : "families"}`;
	}
	return `${count} ${count === 1 ? "model" : "models"}`;
}

function buildGoogleQuotaErrorDetails(
	account: QuotaAccount,
	message: string,
	projectId?: string,
): string[] {
	const details = [
		`account: ${account.displayName}`,
		`provider: ${account.providerName}`,
		"status: error",
	];
	if (projectId) {
		details.push(`project: ${projectId}`);
	}
	details.push(`details: ${message}`);

	if (/401|unauthorized/i.test(message)) {
		details.push("login: use /subs login or /login to authenticate this account again");
		return details;
	}

	if (/403|permission/i.test(message)) {
		if (account.baseProvider === "google-gemini-cli") {
			details.push(
				"hint: Google Cloud Code Assist rejected quota access for this account; try /subs login again and verify this account still has Gemini quota access",
			);
		} else {
			details.push(
				"hint: Google rejected this Antigravity quota request; verify the saved project/account pairing is still valid and try /subs login again",
			);
		}
	}

	return details;
}

function formatGoogleQuotaDetails(
	account: QuotaAccount,
	snapshot: GoogleQuotaAccountSnapshot,
	kind: QuotaStatusKind,
): string[] {
	const details = [
		`account: ${account.displayName}`,
		`provider: ${account.providerName}`,
		`status: ${formatQuotaKind(kind)}`,
	];
	if (snapshot.projectId) {
		details.push(`project: ${snapshot.projectId}`);
	}
	if (snapshot.worstRemainingPercent !== undefined) {
		details.push(`bottleneck: ${formatRemainingPercent(snapshot.worstRemainingPercent)} left`);
	}
	for (const model of [...snapshot.models].sort((left, right) => {
		const leftPercent = left.remainingPercent ?? 101;
		const rightPercent = right.remainingPercent ?? 101;
		return leftPercent - rightPercent || left.model.localeCompare(right.model);
	})) {
		details.push(
			`${model.model}: ${formatRemainingPercent(model.remainingPercent)} left, resets ${formatResetLong(model.resetAt)}`,
		);
	}
	details.push(`endpoint: ${snapshot.endpoint}`);
	return details;
}

async function checkGoogleQuotaAccount(
	account: QuotaAccount,
	fetchSnapshot: (
		accessToken: string,
		projectId: string | undefined,
		signal?: AbortSignal,
	) => Promise<GoogleQuotaAccountSnapshot>,
	signal?: AbortSignal,
): Promise<QuotaCheckResult> {
	const auth = account.auth;
	if (!auth || auth.type !== "oauth") {
		return {
			account,
			kind: "missing-auth",
			summary: "not logged in",
			details: [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				"status: not logged in",
				"login: use /subs login or /login to authenticate this account",
			],
			score: 0,
		};
	}
	if ((typeof auth.access !== "string" || auth.access.length === 0)
		&& (typeof auth.refresh !== "string" || auth.refresh.length === 0)) {
		return {
			account,
			kind: "missing-auth",
			summary: "missing Google tokens",
			details: [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				"status: not logged in",
				"details: saved Google credentials are missing both access and refresh tokens",
				"login: use /subs login or /login to authenticate this account again",
			],
			score: 0,
		};
	}

	let projectId: string | undefined;

	try {
		const credentials = await resolveGoogleQuotaAccess(account, auth);
		projectId = credentials.projectId;
		const snapshot = await fetchSnapshot(credentials.accessToken, credentials.projectId, signal);
		if (snapshot.models.length === 0 || snapshot.worstRemainingPercent === undefined) {
			return {
				account,
				kind: "error",
				summary: "no model quota data returned",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					...(projectId ? [`project: ${projectId}`] : []),
					"details: Google returned no usable model quota data",
					`endpoint: ${snapshot.endpoint}`,
				],
				score: 0,
			};
		}

		const classification = classifyGoogleQuotaKind(snapshot);
		const sortedModels = [...snapshot.models]
			.sort((left, right) => {
				const leftPercent = left.remainingPercent ?? 101;
				const rightPercent = right.remainingPercent ?? 101;
				return leftPercent - rightPercent || left.model.localeCompare(right.model);
			})
			.map((model): QuotaDisplayWindow => ({
				label: model.model,
				remainingPercent: model.remainingPercent,
				resetAt: model.resetAt,
			}));
		return {
			account,
			kind: classification.kind,
			summary: `${getGoogleQuotaBucketLabel(account, snapshot.models.length)} | bottleneck ${formatRemainingPercent(snapshot.worstRemainingPercent)} | ${formatQuotaKind(classification.kind)}`,
			details: formatGoogleQuotaDetails(account, snapshot, classification.kind),
			score: classification.score,
			models: sortedModels.length > 0 ? sortedModels : undefined,
			worstRemainingPercent: snapshot.worstRemainingPercent,
			projectId: snapshot.projectId,
		};
	} catch (error: unknown) {
		if (signal?.aborted || isAbortError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		return {
			account,
			kind: "error",
			summary: message,
			details: buildGoogleQuotaErrorDetails(account, message, projectId),
			score: 0,
		};
	}
}

function normalizeQuotaAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function collectQuotaAccounts(ctx: ExtensionContext): QuotaAccount[] {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeQuotaAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const seen = new Set<string>();
	const accounts: QuotaAccount[] = [];
	const pushAccount = (providerName: string, displayName: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		let auth = getAuthStorage(ctx).get(providerName);
		let pendingSelection = false;
		if (isOmp) {
			const native = (ctx.modelRegistry as any).authStorage ?? ompAuth;
			const sessionId = ctx.sessionManager?.getSessionId();
			const selected = sessionId ? native.sessions.get(providerName, sessionId) : undefined;
			pendingSelection = !selected && native.credentials.list(providerName)
				.filter((entry: { credential: AuthStorageEntry }) => entry.credential.type === "oauth").length > 1;
			if (pendingSelection) auth = undefined;
		}
		accounts.push({
			providerName,
			baseProvider: getBaseProvider(providerName) || providerName,
			displayName,
			auth,
			pendingSelection,
		});
	};

	for (const checker of PROVIDER_QUOTA_CHECKERS) {
		if (getAuthStorage(ctx).hasAuth(checker.baseProvider)) {
			pushAccount(
				checker.baseProvider,
				PROVIDER_TEMPLATES[checker.baseProvider]?.displayName || checker.baseProvider,
			);
		}
		for (const entry of allSubs) {
			if (entry.provider !== checker.baseProvider) continue;
			pushAccount(subProviderName(entry), subDisplayName(entry));
		}
	}

	return accounts;
}

function normalizeAnthropicUsageWindow(label: string, raw: unknown): AnthropicUsageWindow | undefined {
	const record = getRecord(raw);
	if (!record || typeof record.utilization !== "number") return undefined;
	return {
		label,
		remainingPercent: Math.max(0, Math.min(100, 100 - record.utilization)),
		resetAt: typeof record.resets_at === "string"
			? parseIsoTimestampSeconds(record.resets_at)
			: undefined,
	};
}

function parseAnthropicUsageSnapshot(data: unknown): AnthropicUsageSnapshot {
	const raw = getRecord(data);
	const windows = [
		normalizeAnthropicUsageWindow("5h", raw?.five_hour),
		normalizeAnthropicUsageWindow("7d", raw?.seven_day),
	].filter((window): window is AnthropicUsageWindow => Boolean(window));

	// Model-scoped weekly limits (e.g. Opus) ride along in `limits` with
	// kind "weekly_scoped"; the flat five_hour/seven_day fields do not
	// include them.
	for (const limitValue of Array.isArray(raw?.limits) ? raw.limits : []) {
		const limit = getRecord(limitValue);
		if (limit?.kind !== "weekly_scoped" || typeof limit.percent !== "number") continue;
		const scopeModel = getRecord(getRecord(limit.scope)?.model);
		const name = typeof scopeModel?.display_name === "string" && scopeModel.display_name.length > 0
			? scopeModel.display_name
			: "scoped";
		windows.push({
			label: `7d ${name}`,
			remainingPercent: Math.max(0, Math.min(100, 100 - limit.percent)),
			resetAt: typeof limit.resets_at === "string"
				? parseIsoTimestampSeconds(limit.resets_at)
				: undefined,
		});
	}

	return { planType: "unknown", email: "", windows };
}

/** Anthropic enables "extra usage" (pay-as-you-go overflow) via a top-
 * level `extra_usage` block. The toggle is server-side; `user_disabled`
 * means the account has opted out even though the plan allows it. */
function parseAnthropicExtraUsage(data: unknown): boolean | undefined {
	const raw = getRecord(getRecord(data)?.extra_usage);
	if (!raw) return undefined;
	return raw.is_enabled === true && raw.user_disabled !== true ? true : undefined;
}

function classifyAnthropicQuotaKind(snapshot: AnthropicUsageSnapshot): {
	kind: QuotaStatusKind;
	score: number;
} {
	if (snapshot.windows.length === 0) {
		return { kind: "error", score: 0 };
	}
	const bottleneck = Math.min(...snapshot.windows.map((window) => window.remainingPercent));
	if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
	if (bottleneck <= 15) return { kind: "low", score: bottleneck };
	if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
	return { kind: "ready", score: bottleneck };
}

async function fetchAnthropicProfile(
	headers: Headers,
	signal?: AbortSignal,
): Promise<{ planType: string; email: string }> {
	try {
		const response = await fetch(ANTHROPIC_PROFILE_ENDPOINT, { headers, signal });
		if (!response.ok) return { planType: "unknown", email: "" };
		const raw = getRecord(await response.json());
		const account = getRecord(raw?.account);
		return {
			planType: account?.has_claude_max === true
				? "max"
				: account?.has_claude_pro === true ? "pro" : "unknown",
			email: typeof account?.email === "string" ? account.email : "",
		};
	} catch (error) {
		if (isAbortError(error)) throw error;
		return { planType: "unknown", email: "" };
	}
}

const anthropicQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "anthropic",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		const auth = account.auth;
		if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
			return {
				account,
				kind: "missing-auth",
				summary: "not logged in",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: not logged in",
					"login: use /subs login or /login to authenticate this account",
				],
				score: 0,
			};
		}

		const headers = new Headers({
			Authorization: `Bearer ${auth.access}`,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
			Accept: "application/json",
		});

		try {
			// The profile request is independent of the usage payload: run both
			// round-trips concurrently instead of paying two sequential RTTs.
			// fetchAnthropicProfile only rejects on abort; swallow that here so
			// an aborted profile call cannot outlive this checker as an
			// unhandled rejection when the usage fetch fails first.
			const profilePromise = fetchAnthropicProfile(headers, signal).catch(
				() => ({ planType: "unknown", email: "" }),
			);
			const response = await fetch(ANTHROPIC_USAGE_ENDPOINT, {
				method: "GET",
				headers,
				signal,
			});
			if (!response.ok) {
				const error = await readResponseError(response);
				return {
					account,
					kind: "error",
					summary: error,
					details: [
						`account: ${account.displayName}`,
						`provider: ${account.providerName}`,
						"status: error",
						`details: ${error}`,
					],
					score: 0,
				};
			}

			const rawData = await response.json();
			const snapshot = parseAnthropicUsageSnapshot(rawData);
			const profile = await profilePromise;
			snapshot.planType = profile.planType;
			snapshot.email = profile.email;

			const classification = classifyAnthropicQuotaKind(snapshot);
			const extraUsage = parseAnthropicExtraUsage(rawData);
			const summary = [
				snapshot.planType !== "unknown" ? snapshot.planType : "plan unknown",
				...snapshot.windows.map((window) =>
					`${window.label} ${formatRemainingPercent(window.remainingPercent)} (${formatResetShort(window.resetAt)})`),
				formatQuotaKind(classification.kind),
			].join(" | ");
			const details = [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				`status: ${formatQuotaKind(classification.kind)}`,
				`plan: ${snapshot.planType}`,
			];
			if (snapshot.email) {
				details.push(`email: ${snapshot.email}`);
			}
			for (const window of snapshot.windows) {
				details.push(
					`${window.label} window: ${formatRemainingPercent(window.remainingPercent)} left, resets ${formatResetLong(window.resetAt)}`,
				);
			}
			if (extraUsage) {
				details.push("extra usage: enabled");
			}
			details.push(`endpoint: ${ANTHROPIC_USAGE_ENDPOINT}`);
			const windows: QuotaDisplayWindow[] = snapshot.windows.map((w) => ({
				label: w.label,
				remainingPercent: w.remainingPercent,
				resetAt: w.resetAt,
			}));
			return {
				account,
				kind: classification.kind,
				summary,
				details,
				score: classification.score,
				planType: snapshot.planType,
				email: snapshot.email || undefined,
				windows: windows.length > 0 ? windows : undefined,
				worstRemainingPercent: windows.length > 0
					? Math.min(...windows.map((w) => w.remainingPercent).filter((v): v is number => v !== undefined))
					: undefined,
				extraUsage,
			};
		} catch (error: unknown) {
			if (signal?.aborted || isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return {
				account,
				kind: "error",
				summary: message,
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					`details: ${message}`,
				],
				score: 0,
			};
		}
	},
};

const codexQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "openai-codex",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		const auth = account.auth;
		if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
			return {
				account,
				kind: "missing-auth",
				summary: "not logged in",
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: not logged in",
					"login: use /subs login or /login to authenticate this account",
				],
				score: 0,
			};
		}

		const tokenMetadata = getCodexTokenMetadata(auth.access);
		const accountId = typeof auth.accountId === "string" && auth.accountId.length > 0
			? auth.accountId
			: tokenMetadata.accountId;
		const baseUrl = (process.env.CHATGPT_BASE_URL || DEFAULT_CODEX_USAGE_BASE_URL).replace(/\/+$/, "");
		const headers = new Headers({
			Authorization: `Bearer ${auth.access}`,
			Accept: "application/json",
			"User-Agent": "pi-multi-pass",
		});
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}

		try {
			const response = await fetch(`${baseUrl}/wham/usage`, {
				method: "GET",
				headers,
				signal,
			});
			if (!response.ok) {
				const error = await readResponseError(response);
				return {
					account,
					kind: "error",
					summary: error,
					details: [
						`account: ${account.displayName}`,
						`provider: ${account.providerName}`,
						`status: error`,
						`details: ${error}`,
					],
					score: 0,
				};
			}

			const rawData = await response.json();
			const snapshot = parseCodexUsageSnapshot(rawData);
			if (!snapshot.email && tokenMetadata.email) snapshot.email = tokenMetadata.email;
			if ((!snapshot.planType || snapshot.planType === "unknown") && tokenMetadata.planType) {
				snapshot.planType = tokenMetadata.planType;
			}
			const windows: QuotaDisplayWindow[] = snapshot.windows.map((window) => ({
				label: codexWindowLabel(window),
				remainingPercent: getCodexWindowRemaining(window),
				resetAt: window.resetAt,
			}));
			const classification = classifyCodexQuotaKind(snapshot);
			const resetCredits = parseCodexResetCredits(rawData);
			const summary = [
				snapshot.planType !== "unknown" ? snapshot.planType : "plan unknown",
				...(windows.length > 0
					? windows.map((window) => `${window.label} ${formatRemainingPercent(window.remainingPercent)} (${formatResetShort(window.resetAt)})`)
					: ["no quota windows returned"]),
				formatQuotaKind(classification.kind),
			].join(" | ");
			const details = [
				`account: ${account.displayName}`,
				`provider: ${account.providerName}`,
				`status: ${formatQuotaKind(classification.kind)}`,
				`plan: ${snapshot.planType}`,
			];
			if (snapshot.email) {
				details.push(`email: ${snapshot.email}`);
			}
			details.push(...windows.map((window) =>
				`${window.label} window: ${formatRemainingPercent(window.remainingPercent)} left, resets ${formatResetLong(window.resetAt)}`));
			if (resetCredits) {
				const base = `${resetCredits.available} stored reset${resetCredits.available === 1 ? "" : "s"}`;
				details.push(resetCredits.applicable > 0
					? `reset credits: ${base} - usable now (${resetCredits.applicable} applicable)`
					: `reset credits: ${base}`);
			}
			details.push(`endpoint: ${baseUrl}/wham/usage`);
			const remainingValues = windows
				.map((w) => w.remainingPercent)
				.filter((v): v is number => v !== undefined);
			return {
				account,
				kind: classification.kind,
				summary,
				details,
				score: classification.score,
				planType: snapshot.planType,
				email: snapshot.email || undefined,
				windows: windows.length > 0 ? windows : undefined,
				worstRemainingPercent: remainingValues.length > 0 ? Math.min(...remainingValues) : undefined,
				resetCredits,
			};
		} catch (error: unknown) {
			if (signal?.aborted || isAbortError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			return {
				account,
				kind: "error",
				summary: message,
				details: [
					`account: ${account.displayName}`,
					`provider: ${account.providerName}`,
					"status: error",
					`details: ${message}`,
				],
				score: 0,
			};
		}
	},
};

const googleGeminiCliQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "google-gemini-cli",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		return checkGoogleQuotaAccount(account, fetchGoogleGeminiQuotaSnapshot, signal);
	},
};

const googleAntigravityQuotaChecker: ProviderQuotaChecker = {
	baseProvider: "google-antigravity",
	async check(account: QuotaAccount, signal?: AbortSignal): Promise<QuotaCheckResult> {
		return checkGoogleQuotaAccount(account, fetchGoogleAntigravityQuotaSnapshot, signal);
	},
};

const PROVIDER_QUOTA_CHECKERS: ProviderQuotaChecker[] = [
	anthropicQuotaChecker,
	codexQuotaChecker,
	googleGeminiCliQuotaChecker,
	googleAntigravityQuotaChecker,
];

async function showQuotaDetails(
	ctx: ExtensionCommandContext,
	result: QuotaCheckResult,
): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Limit Details: ${result.account.displayName}`,
		subtitle: "Press Enter or Escape to go back to the limits list.",
		items: result.details.map((detail, index) => ({ value: `${index}:${detail}`, label: detail })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

// ==========================================================================
// Card view for /subs limits (TUI)
// ==========================================================================

const QUOTA_BAR_WIDTH = 20;

/** Map a remaining-percent value to the theme colour used for its bar
 * and status badge. Mirrors the bands in `classifyCodexQuotaKind` and
 * the omarchy bar widget. */
function quotaBarColor(remainingPercent: number | undefined): "success" | "warning" | "error" | "dim" {
	if (remainingPercent === undefined) return "dim";
	if (remainingPercent <= 15) return "error";
	if (remainingPercent <= 30) return "warning";
	return "success";
}

/** Render a progress-bar row: `label  ███████░░░░░░  58% left · resets ~2h`.
 * Colour-coded fill tracks the severity band so cards communicate at a
 * glance even without reading the number. */
function renderQuotaBar(
	theme: Theme,
	label: string,
	window: QuotaDisplayWindow,
): string {
	const percent = window.remainingPercent;
	const colorKey = quotaBarColor(percent);
	const filled = percent !== undefined
		? Math.max(0, Math.min(QUOTA_BAR_WIDTH, Math.round((percent / 100) * QUOTA_BAR_WIDTH)))
		: 0;
	const bar = "\u2588".repeat(filled) + "\u2591".repeat(QUOTA_BAR_WIDTH - filled);
	const coloredBar = theme.fg(colorKey, bar);
	const percentText = percent === undefined
		? "--"
		: `${Math.round(percent)}% left`;
	const coloredPercent = theme.fg(colorKey, theme.bold(percentText));
	const resetText = window.resetAt
		? theme.fg("dim", `  resets ${formatResetShort(window.resetAt)}`)
		: "";
	const paddedLabel = theme.fg("muted", label.padEnd(14));
	return `${paddedLabel}  ${coloredBar}  ${coloredPercent}${resetText}`;
}

function renderQuotaStatusBadge(theme: Theme, kind: QuotaStatusKind): string {
	const glyph = getQuotaStatusGlyph(kind);
	const label = formatQuotaKind(kind);
	switch (kind) {
		case "ready":
			return theme.fg("success", theme.bold(`${glyph} ${label}`));
		case "watch":
			return theme.fg("warning", theme.bold(`${glyph} ${label}`));
		case "low":
		case "blocked":
			return theme.fg("error", theme.bold(`${glyph} ${label}`));
		case "missing-auth":
			return theme.fg("warning", `${glyph} ${label}`);
		default:
			return theme.fg("dim", `${glyph} ${label}`);
	}
}

/** Build one card's text lines (styled, ready to drop into Text
 * components). Each card is a vertical stack: title row, optional
 * meta row, progress bars, optional badges. */
function renderQuotaCardLines(
	theme: Theme,
	result: QuotaCheckResult,
	options: { selected: boolean; isCurrent: boolean; isBest: boolean },
): string[] {
	const { account } = result;
	const prefix = options.selected ? theme.fg("accent", theme.bold("\u2192 ")) : "  ";
	const nameStyle = options.selected ? theme.fg("accent", theme.bold(account.displayName)) : theme.bold(account.displayName);

	const metaParts: string[] = [];
	if (result.planType && result.planType !== "unknown") metaParts.push(result.planType);
	if (result.email) metaParts.push(result.email);
	if (result.projectId) metaParts.push(`project ${result.projectId}`);
	const meta = metaParts.length > 0 ? theme.fg("dim", `  ${metaParts.join(" \u00b7 ")}`) : "";

	const badges: string[] = [];
	if (options.isCurrent) badges.push(theme.fg("accent", theme.bold("active")));
	if (options.isBest && !options.isCurrent) badges.push(theme.fg("success", "best now"));
	const badgeText = badges.length > 0 ? ` ${badges.join(" \u00b7 ")}` : "";

	const lines: string[] = [];
	lines.push(`${prefix}${nameStyle}${badgeText}  ${renderQuotaStatusBadge(theme, result.kind)}`);
	if (meta) lines.push(meta);

	const windows = result.windows || [];
	const models = result.models || [];
	for (const window of windows) {
		lines.push(`    ${renderQuotaBar(theme, formatWindowLabel(window.label), window)}`);
	}
	for (const model of models) {
		lines.push(`    ${renderQuotaBar(theme, model.label, model)}`);
	}

	if (windows.length === 0 && models.length === 0) {
		lines.push(theme.fg("muted", `    ${result.summary}`));
	}

	if (result.resetCredits) {
		const rc = result.resetCredits;
		const base = `${rc.available} stored reset${rc.available === 1 ? "" : "s"}`;
		if (rc.applicable > 0) {
			lines.push(`    ${theme.fg("success", theme.bold(`\u21ba ${base} \u00b7 usable now!`))}`);
		} else {
			lines.push(`    ${theme.fg("accent", `\u21ba ${base}`)}`);
		}
	}
	if (result.extraUsage) {
		lines.push(`    ${theme.fg("dim", "extra usage enabled")}`);
	}
	return lines;
}

/** Translate internal window labels ("5h", "7d", "7d Opus") into the
 * same human text used by the Panel.qml card. */
function formatWindowLabel(id: string): string {
	if (id === "5h") return "5-hour window";
	if (id === "7d") return "weekly";
	if (id.startsWith("7d ")) return `weekly \u00b7 ${id.slice(3)}`;
	return id;
}

/** Scrollable card view for `/subs limits`. Replaces the single-line
 * SelectList with per-account tiles: progress bars, reset times,
 * reset-credit badges, and an active-session marker. Enter opens the
 * raw text details for the highlighted account; Esc closes. */
async function selectQuotaResultCards(
	ctx: ExtensionCommandContext,
	results: QuotaCheckResult[],
	preferredProviderName?: string,
): Promise<QuotaCheckResult | undefined> {
	if (!ctx.hasUI) {
		return selectQuotaResult(ctx, results, preferredProviderName);
	}

	const currentProviderName = preferredProviderName || ctx.model?.provider;
	const bestProviderName = results[0]?.account.providerName;
	const initialIndex = Math.max(
		0,
		results.findIndex((r) => r.account.providerName === currentProviderName),
	);

	const picked = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		let selectedIndex = initialIndex >= 0 ? initialIndex : 0;

		const header = new Text(theme.fg("accent", theme.bold("Subscription Limits")));
		const overview = new Text(theme.fg("dim", formatQuotaOverview(results)));
		const cardsContainer = new Container();
		const footer = new Text(theme.fg("dim", [
			keyHint("tui.select.up", "up"),
			keyHint("tui.select.down", "down"),
			keyHint("tui.select.confirm", "details"),
			keyHint("tui.select.cancel", "close"),
		].join(" \u2022 ")));

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(header);
		container.addChild(overview);
		container.addChild(new Spacer(1));
		container.addChild(cardsContainer);
		container.addChild(footer);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const rebuildCards = () => {
			cardsContainer.clear();
			results.forEach((result, index) => {
				const lines = renderQuotaCardLines(theme, result, {
					selected: index === selectedIndex,
					isCurrent: result.account.providerName === currentProviderName,
					isBest: result.account.providerName === bestProviderName,
				});
				for (const line of lines) cardsContainer.addChild(new Text(line));
				if (index < results.length - 1) cardsContainer.addChild(new Spacer(1));
			});
		};
		rebuildCards();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					selectedIndex = selectedIndex === 0 ? results.length - 1 : selectedIndex - 1;
					rebuildCards();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					selectedIndex = selectedIndex === results.length - 1 ? 0 : selectedIndex + 1;
					rebuildCards();
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(results[selectedIndex]?.account.providerName || null);
					return;
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(null);
				}
			},
		};
	});

	if (!picked) return undefined;
	return results.find((r) => r.account.providerName === picked);
}

async function handleSubsLimits(ctx: ExtensionCommandContext): Promise<void> {
	const allowedProviderNames = normalizeQuotaAllowedProviderNames(ctx.cwd);
	const accounts = collectQuotaAccounts(ctx);
	if (accounts.length === 0) {
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(
			`No supported subscription limits are available yet${suffix}. Login to a supported provider first.`,
			"info",
		);
		return;
	}

	const results = await loadQuotaResults(ctx, accounts);
	if (!results) {
		ctx.ui.notify("Cancelled subscription limit check.", "info");
		return;
	}
	if (results.length === 0) {
		ctx.ui.notify("No supported quota checks matched the configured subscriptions.", "info");
		return;
	}

	let preferredProviderName = ctx.model?.provider;
	while (true) {
		const selected = await selectQuotaResultCards(ctx, results, preferredProviderName);
		if (!selected) return;
		preferredProviderName = selected.account.providerName;
		await showQuotaDetails(ctx, selected);
	}
}

// ==========================================================================
// Config persistence (~/.pi/agent/multi-pass.json)
// ==========================================================================

interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

/** Pool member selection strategy.
 *  - "round-robin": rotate sequentially on failover (default).
 *  - "per-turn": advance to the next usable member before each new prompt;
 *    retries retain their selected account, with round-robin failover.
 *  - "quota-first": check all eligible members at session startup, then
 *    query built-in quota checkers on failover and prefer the member
 *    with the most remaining quota. Falls back to round-robin when no
 *    quota data is available.
 *  - "scheduled": use per-member time-window schedules to pick the best
 *    member. Preferred members in their active window go first (shortest
 *    remaining window first), then default members, then overflow.
 *  - "custom": delegate selection to a user-provided JS script. */
type PoolStrategy = "round-robin" | "per-turn" | "weighted" | "quota-first" | "scheduled" | "custom";

type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const ALL_DAYS: readonly DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** A time window during which a pool member is considered "preferred". */
interface ScheduleWindow {
	/** Hour range [start, end) in 24-hour local time. Wraps midnight
	 *  when start > end (e.g. [22, 6] = 22:00-05:59). */
	hours?: [number, number];
	/** Days of week this window is active. Omit for every day. */
	days?: DayOfWeek[];
	/** Optional date range (ISO date strings YYYY-MM-DD, inclusive). */
	dateRange?: { from?: string; to?: string };
}

/** Per-member schedule configuration. */
interface MemberSchedule {
	/** Time windows when this member is preferred. */
	windows?: ScheduleWindow[];
	/** Role controls ordering priority:
	 *  - "preferred": used during its active windows, skipped otherwise
	 *  - "overflow": last resort, used when no preferred/default member is available
	 *  - undefined (default): always available, used after preferred members */
	role?: "preferred" | "overflow";
}

/** Context passed to a custom pool selector script. */
interface PoolSelectorContext {
	/** Available (non-exhausted, authenticated) member provider names */
	members: string[];
	/** Provider that just hit the rate limit */
	currentProvider: string;
	/** Model ID being used */
	modelId: string;
	/** Pool metadata */
	pool: { name: string; baseProvider: string; members: string[] };
	/** Current Unix timestamp (ms) */
	timestamp: number;
	/** Current hour (0-23, local time) */
	hour: number;
	/** Current day of week */
	day: DayOfWeek;
	/** Last user prompt, if available */
	prompt?: string;
}

/** Function signature a custom selector script must export (default export). */
type PoolSelectorFn =
	(ctx: PoolSelectorContext) => string | string[] | undefined | Promise<string | string[] | undefined>;

/** A named routing preset that maps to an ordered list of provider+model entries. */
interface PresetEntry {
	/** Provider name (e.g. "openai-codex", "anthropic-2") */
	provider: string;
	/** Model ID to use */
	model: string;
	/** Whether this entry is active */
	enabled: boolean;
}

interface PresetConfig {
	/** Preset name (e.g. "coding-premium", "coding-budget") */
	name: string;
	/** Ordered provider+model entries to try */
	entries: PresetEntry[];
	/** Whether this preset is available */
	enabled: boolean;
}

interface PoolConfig {
	/** Pool name (user-defined) */
	name: string;
	/** Base provider type, e.g. "openai-codex" */
	baseProvider: string;
	/** Provider names in rotation order. Includes the original (e.g. "openai-codex")
	 *  and extras (e.g. "openai-codex-2", "openai-codex-3") */
	members: string[];
	/** Whether auto-rotation is enabled */
	enabled: boolean;
	/** Selection strategy for failover, or each new prompt with "per-turn".
	 *  Defaults to "round-robin" when omitted. */
	strategy?: PoolStrategy;
	/** Relative request shares for the opt-in weighted strategy. Defaults to 1. */
	memberWeights?: Record<string, number>;
	/** Per-member schedule rules (keyed by provider name).
	 *  Only used when strategy is "scheduled". */
	memberSchedule?: Record<string, MemberSchedule>;
	/** Path to a JS module exporting a selector function.
	 *  Only used when strategy is "custom". Resolved relative to the
	 *  global config directory (~/.pi/agent/). */
	selectorScript?: string;
}

interface ChainEntryConfig {
	/** Target pool name to enter when traversing the chain */
	pool: string;
	/** Model to select when entering the target pool */
	model: string;
	/** Whether this chain entry participates in traversal */
	enabled: boolean;
}

interface ChainConfig {
	/** Chain name (user-defined) */
	name: string;
	/** Ordered chain traversal entries */
	entries: ChainEntryConfig[];
	/** Whether chain traversal is enabled */
	enabled: boolean;
}

interface MultiPassConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
	presets: PresetConfig[];
	/** Omarchy-style footer status bar. Off by default; toggled with /subs statusbar. */
	statusBar?: boolean;
	/** Re-route pi's hardcoded /model to our labelled picker. Off by default;
	 * replaces the TUI editor so other extensions can't own it concurrently. */
	interceptModel?: boolean;
	/** Renew OAuth tokens ahead of pi and persist every rotation. Off by
	 * default; takes over refreshes pi would otherwise do itself. */
	tokenKeeper?: boolean;
}

/** Project-level config (.pi/multi-pass.json) */
interface ProjectConfig {
	/** Override pools for this project. If set, replaces global pools. */
	pools?: PoolConfig[];
	/** Override chains for this project. If set, replaces global chains. */
	chains?: ChainConfig[];
	/** Restrict which provider names can be used in this project (for example
	 *  "openai-codex" or "openai-codex-2"). If set, only these exact providers
	 *  are available in this project. If not set, all global providers are available. */
	allowedSubs?: string[];
}

/** Effective config after merging global + project */
interface EffectiveConfig {
	subscriptions: SubEntry[];
	pools: PoolConfig[];
	chains: ChainConfig[];
	presets: PresetConfig[];
	/** Exact provider names allowed in this project, if restricted. */
	allowedProviderNames?: string[];
	/** Which project config was loaded from, if any */
	projectConfigPath?: string;
}

function globalConfigPath(): string {
	return join(getAgentDir(), "multi-pass.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, projectConfigDir, "multi-pass.json");
}

function emptyMultiPassConfig(): MultiPassConfig {
	return { subscriptions: [], pools: [], chains: [], presets: [] };
}

function usablePool(raw: unknown): raw is PoolConfig {
	const pool = getRecord(raw);
	return !!pool && typeof pool.name === "string" && typeof pool.baseProvider === "string"
		&& Array.isArray(pool.members) && pool.members.every(member => typeof member === "string");
}

function usableChain(raw: unknown): raw is ChainConfig {
	const chain = getRecord(raw);
	return !!chain && typeof chain.name === "string" && Array.isArray(chain.entries)
		&& chain.entries.every(entry => !!getRecord(entry) && typeof entry.pool === "string" && typeof entry.model === "string");
}

function normalizeMultiPassConfig(raw: unknown): MultiPassConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<MultiPassConfig>) : {};
	return {
		subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions.filter(entry => entry && typeof entry.provider === "string") : [],
		pools: Array.isArray(parsed.pools) ? parsed.pools.filter(usablePool) : [],
		chains: Array.isArray(parsed.chains) ? parsed.chains.filter(usableChain) : [],
		presets: Array.isArray(parsed.presets) ? parsed.presets.filter(preset => preset && typeof preset.name === "string" && Array.isArray(preset.entries)) : [],
		statusBar: parsed.statusBar === true,
		interceptModel: parsed.interceptModel === true,
		tokenKeeper: parsed.tokenKeeper === true,
	};
}

function normalizeProjectConfig(raw: unknown): ProjectConfig {
	const parsed = raw && typeof raw === "object" ? (raw as Partial<ProjectConfig>) : {};
	const config: ProjectConfig = {};
	if (Array.isArray(parsed.pools)) config.pools = parsed.pools.filter(usablePool);
	if (Array.isArray(parsed.chains)) config.chains = parsed.chains.filter(usableChain);
	if (Array.isArray(parsed.allowedSubs)) config.allowedSubs = parsed.allowedSubs.filter(value => typeof value === "string");
	return config;
}

function loadGlobalConfig(): MultiPassConfig {
	const path = globalConfigPath();
	if (!existsSync(path)) return emptyMultiPassConfig();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return normalizeMultiPassConfig(raw);
	} catch {
		return emptyMultiPassConfig();
	}
}

function loadProjectConfig(cwd: string): ProjectConfig | undefined {
	const path = projectConfigPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeProjectConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}

function normalizeAllowedProviderNames(allowedSubs: string[] | undefined): string[] | undefined {
	if (!allowedSubs || allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function filterPoolsByAllowedProviders(
	pools: PoolConfig[],
	allowedProviderNames: string[] | undefined,
): PoolConfig[] {
	if (!allowedProviderNames || allowedProviderNames.length === 0) {
		return pools;
	}
	const allowed = new Set(allowedProviderNames);
	return pools
		.map((pool) => ({
			...pool,
			members: pool.members.filter((member) => allowed.has(member)),
		}))
		.filter((pool) => pool.members.length > 0);
}

function filterChainsByAvailablePools(chains: ChainConfig[], pools: PoolConfig[]): ChainConfig[] {
	const poolNames = new Set(pools.map((pool) => pool.name));
	return chains
		.map((chain) => ({
			...chain,
			entries: chain.entries.filter((entry) => poolNames.has(entry.pool)),
		}))
		.filter((chain) => chain.entries.length > 0);
}

function loadEffectiveConfig(cwd: string): EffectiveConfig {
	const global = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const mergedSubscriptions = normalizeEntries(mergeConfigs(global, envEntries));
	const project = loadProjectConfig(cwd);

	if (!project) {
		return {
			subscriptions: mergedSubscriptions,
			pools: global.pools,
			chains: global.chains,
			presets: global.presets,
		};
	}

	const allowedProviderNames = normalizeAllowedProviderNames(project.allowedSubs);
	let subs = mergedSubscriptions;
	if (allowedProviderNames) {
		const allowed = new Set(allowedProviderNames);
		subs = mergedSubscriptions.filter((s) => allowed.has(subProviderName(s)));
	}

	let pools = project.pools !== undefined ? project.pools : global.pools;
	let chains = project.chains !== undefined ? project.chains : global.chains;
	if (allowedProviderNames) {
		pools = filterPoolsByAllowedProviders(pools, allowedProviderNames);
		chains = filterChainsByAvailablePools(chains, pools);
	}

	return {
		subscriptions: subs,
		pools,
		chains,
		presets: global.presets,
		allowedProviderNames,
		projectConfigPath: projectConfigPath(cwd),
	};
}

function saveJsonConfig(path: string, config: unknown): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	let backupPath: string | undefined;
	if (existsSync(path)) {
		try {
			JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			backupPath = `${path}.invalid-${Date.now()}-${process.pid}.bak`;
			copyFileSync(path, backupPath);
		}
	}

	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(config, null, 2), "utf-8");
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {}
		throw error;
	}

	if (backupPath) {
		console.warn(`[pi-multi-pass] Backed up malformed config to ${backupPath}`);
	}
}

function saveGlobalConfig(config: MultiPassConfig): void {
	saveJsonConfig(globalConfigPath(), config);
}

function saveProjectConfig(cwd: string, config: ProjectConfig): void {
	saveJsonConfig(projectConfigPath(cwd), config);
}

function getProviderDisplayName(providerName: string, subscriptions: SubEntry[]): string {
	const subEntry = subscriptions.find((entry) => subProviderName(entry) === providerName);
	if (subEntry) {
		return subDisplayName(subEntry);
	}
	return PROVIDER_TEMPLATES[providerName]?.displayName || providerName;
}

function getProjectScopedProviderNames(
	ctx: ExtensionContext | ExtensionCommandContext,
	effective: EffectiveConfig,
): string[] {
	const seen = new Set<string>();
	const providerNames: string[] = [];
	const push = (providerName: string) => {
		if (!providerName || seen.has(providerName)) return;
		seen.add(providerName);
		providerNames.push(providerName);
	};

	if (effective.allowedProviderNames && effective.allowedProviderNames.length > 0) {
		for (const providerName of effective.allowedProviderNames) {
			const isExtraSubscription = effective.subscriptions.some(
				(entry) => subProviderName(entry) === providerName,
			);
			const isSupportedBaseProvider = SUPPORTED_PROVIDERS.includes(providerName);
			if (!isExtraSubscription && !isSupportedBaseProvider) continue;
			push(providerName);
		}
		return providerNames;
	}

	for (const providerName of SUPPORTED_PROVIDERS) {
		if (getAuthStorage(ctx).hasAuth(providerName)) {
			push(providerName);
		}
	}
	for (const entry of effective.subscriptions) {
		push(subProviderName(entry));
	}
	return providerNames;
}

function findSelectableModelForProvider(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!getAuthStorage(ctx).hasAuth(providerName)) {
		return undefined;
	}
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) {
			return preferred as Model<Api>;
		}
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) {
		return undefined;
	}
	for (const baseModel of minimaxBase(providerName)
		? providerModelChoices(ctx, providerName)
		: getModels(baseProvider as any) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) {
			return candidate as Model<Api>;
		}
	}
	return undefined;
}

function formatAllowedProviderSummary(effective: EffectiveConfig): string | undefined {
	return effective.allowedProviderNames && effective.allowedProviderNames.length > 0
		? effective.allowedProviderNames.join(", ")
		: undefined;
}

// ==========================================================================
// Merge env var into config
// ==========================================================================

function parseEnvConfig(): SubEntry[] {
	const raw = process.env.MULTI_SUB;
	if (!raw) return [];
	const entries: SubEntry[] = [];
	for (const part of raw.split(",")) {
		const [provider, countStr] = part.trim().split(":");
		if (!provider || !PROVIDER_TEMPLATES[provider]) continue;
		const count = parseInt(countStr || "1", 10);
		if (isNaN(count) || count < 1) continue;
		for (let i = 0; i < count; i++) {
			entries.push({ provider, index: 0 });
		}
	}
	return entries;
}

function mergeConfigs(fileConfig: MultiPassConfig, envEntries: SubEntry[]): SubEntry[] {
	const merged = [...fileConfig.subscriptions];
	for (const envEntry of envEntries) {
		const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
		const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
		if (existingCount < envCountForProvider) {
			const usedIndices = merged
				.filter((s) => s.provider === envEntry.provider)
				.map((s) => s.index);
			let nextIndex = 2;
			while (usedIndices.includes(nextIndex)) nextIndex++;
			merged.push({ provider: envEntry.provider, index: nextIndex });
		}
	}
	return merged;
}

function normalizeEntries(entries: SubEntry[]): SubEntry[] {
	const byProvider = new Map<string, SubEntry[]>();
	for (const entry of entries) {
		const list = byProvider.get(entry.provider) || [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}
	const result: SubEntry[] = [];
	for (const [, list] of byProvider) {
		const usedIndices = new Set(list.filter((e) => e.index > 0).map((e) => e.index));
		let nextIndex = 2;
		for (const entry of list) {
			if (entry.index > 0) {
				result.push(entry);
			} else {
				while (usedIndices.has(nextIndex)) nextIndex++;
				result.push({ ...entry, index: nextIndex });
				usedIndices.add(nextIndex);
				nextIndex++;
			}
		}
	}
	return result;
}

// ==========================================================================
// Provider name helpers
// ==========================================================================

function subProviderName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}

function subDisplayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const providerName = `${template?.displayName || entry.provider} #${entry.index}`;
	if (!entry.label) return providerName;
	return `${entry.label} — ${providerName}`;
}

function subscriptionLoginName(entry: SubEntry): string {
	if (!PROVIDER_TEMPLATES[entry.provider]?.buildOAuth) return subProviderName(entry);
	return subDisplayName(entry);
}

/** Get the base provider type from a provider name, e.g. "openai-codex-2" -> "openai-codex" */
function getBaseProvider(providerName: string): string | undefined {
	// Direct match
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	// Strip trailing -N
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

// ==========================================================================
// Model cloning
// ==========================================================================

/** Build a model.name that surfaces the subscription label and email in
 * pi's /model picker. The picker's inline list only shows `id [provider]`,
 * but model.name is fuzzy-searched and rendered on the "Model Name:" row
 * when the model is highlighted, so this is how users spot which account
 * each extra sub represents. */
function subModelName(entry: SubEntry, originalName: string): string {
	const parts: string[] = [originalName];
	if (entry.label) parts.push(entry.label);
	else parts.push(`#${entry.index}`);
	// Cache first: this runs once per model on every refreshModels cycle, so a
	// warm cache must not touch the credential store at all.
	const providerName = subProviderName(entry);
	let email = accountEmailCache.get(providerName);
	if (!email) {
		try {
			const credential = readStoredCredential(providerName) as
				| AuthStorageEntry
				| undefined;
			email =
				(typeof credential?.email === "string" ? credential.email : undefined) ??
				extractEmailFromJwt(
					typeof credential?.access === "string" ? credential.access : undefined,
				);
		} catch {
			// best effort; just omit the email
		}
	}
	if (email) parts.push(email);
	return parts.join(" \u00b7 ");
}

function cloneModels(originalProvider: string, index: number, entry?: SubEntry) {
	const models = getModels(originalProvider as any) as Model<Api>[];
	return models.map((m) => ({
		id: m.id,
		name: entry ? subModelName(entry, m.name) : `${m.name} (#${index})`,
		api: m.api,
		reasoning: m.reasoning,
		...(isOmp ? { thinking: (m as any).thinking, preferWebsockets: (m as any).preferWebsockets } : {}),
		thinkingLevelMap: m.thinkingLevelMap ? { ...m.thinkingLevelMap } : undefined,
		input: m.input as ("text" | "image")[],
		cost: { ...m.cost },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		headers: m.headers ? { ...m.headers } : undefined,
		compat: m.compat,
	}));
}

/**
 * Read the base provider's persisted remote-catalog overlay
 * (~/.pi/agent/models-store.json). pi refreshes this file for builtin
 * providers (pi.dev catalog, `pi update --models`, periodic re-checks);
 * extension-registered providers never receive that overlay, so
 * subscriptions mirror it from here.
 */
function storedOverlayModels(baseProvider: string): Model<Api>[] {
	try {
		const storePath = join(getAgentDir(), "models-store.json");
		if (!existsSync(storePath)) return [];
		const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<
			string,
			{ models?: unknown }
		>;
		const entry = raw[baseProvider];
		if (!entry || !Array.isArray(entry.models)) return [];
		return entry.models.filter(
			(m): m is Model<Api> =>
				!!m && typeof m === "object" && typeof (m as Model<Api>).id === "string",
		);
	} catch {
		return [];
	}
}

/**
 * Live model list for a subscription provider: the static builtin catalog
 * merged with the base provider's persisted remote-catalog overlay (overlay
 * entries win, mirroring pi's own catalog merge). Returned from
 * `refreshModels` so catalog additions (e.g. gpt-6-astra) and metadata
 * updates reach extra accounts on every model refresh cycle without a
 * pi-multi-pass release.
 */
function liveSubscriptionModels(entry: SubEntry, name: string): Model<Api>[] {
	const catalog = subscriptionCatalog(entry.provider);
	const models = catalog.map(({ model }) => ({
		...model,
		provider: name,
		name: subModelName(entry, model.name),
	}));
	mirroredCatalogs.set(name, catalog.map((item, index) => ({ ...item, model: models[index] })));
	return models;
}

// Ordinary choices are a projection; registration and saved-ID lookup keep the full catalog.
const mirroredCatalogs = new Map<string, CatalogEntry[]>();
const subscriptionRegistrations = new Map<string, unknown>();

function subscriptionCatalog(provider: string): CatalogEntry[] {
	return mergeCatalog(getModels(provider as any) as Model<Api>[], storedOverlayModels(provider));
}

function ordinaryChoices(
	ctx: ExtensionContext | ExtensionCommandContext,
	models: Model<Api>[],
	current?: Model<Api>,
): Model<Api>[] {
	let config: unknown;
	try {
		const path = join(getAgentDir(), "models.json");
		config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
	} catch {
		// An unreadable override file must not hide a potentially custom model.
		return models;
	}
	const catalogs = new Map<string, CatalogEntry[]>();
	return ordinaryModelChoices(models, (model) => {
		const base = minimaxBase(model.provider);
		if (!base || configuredModelOverride(config, model.provider, model.id)) return false;
		const registry = ctx.modelRegistry;
		if (typeof registry.getRegisteredProviderConfig !== "function"
			|| typeof registry.getRegisteredNativeProvider !== "function") return false;
		const registered = registry.getRegisteredProviderConfig(model.provider);
		const native = registry.getRegisteredNativeProvider?.(model.provider);
		const own = subscriptionRegistrations.get(model.provider) as Record<string, unknown> | undefined;
		// Pi shallow-copies registrations. Compare the actual layer (including model
		// array and refresh callback identity), not a tag on flattened models.
		if (native || (registered && (!own || Object.entries(registered).some(([key, value]) => own[key] !== value)))) return false;
		let catalog = mirroredCatalogs.get(model.provider);
		if (!catalog) {
			if (model.provider !== base) return false;
			catalog = catalogs.get(base) ?? subscriptionCatalog(base);
			catalogs.set(base, catalog);
		}
		const expected = catalog.find((item) => item.model.id === model.id);
		return !!expected && matchesCatalogModel(model, model.provider === base
			? expected.model : { ...expected.model, headers: undefined });
	}, current);
}

function providerModelChoices(ctx: ExtensionContext | ExtensionCommandContext, provider: string): Model<Api>[] {
	return ordinaryChoices(ctx, ctx.modelRegistry.getAll().filter((model) => model.provider === provider));
}

// ==========================================================================
// Register a single subscription as a provider
// ==========================================================================

function registerSub(pi: ExtensionAPI, entry: SubEntry): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;

	const name = subProviderName(entry);
	const oauth = template.buildOAuth
		? { ...template.buildOAuth(entry.index), name: subDisplayName(entry) }
		: undefined;
	if (oauth) {
		const defaultRefresh = oauth.refreshToken;
		oauth.refreshToken = (credentials: OAuthCredentials, signal?: AbortSignal) =>
			isTokenKeeperEnabled()
				? keepFreshCredential(name, entry.provider, credentials)
				: defaultRefresh(credentials, signal);
	}
	const modifyModels = oauth ? template.buildModifyModels?.(name) : undefined;
	const builtinModels = getModels(entry.provider as any) as Model<Api>[];
	const baseUrl = builtinModels[0]?.baseUrl || "";
	const models = cloneModels(entry.provider, entry.index, entry);

	mirroredCatalogs.set(name, builtinModels.map((model, index) => ({
		origin: "builtin",
		model: { ...model, ...models[index], provider: name },
	})));
	// Static `models` is only the startup baseline; refreshModels swaps in the
	// live merged catalog (builtin + remote overlay) on every refresh cycle.
	const registration = {
		// Display name pi exposes on the composed provider; used by /login and
		// available for future UI (e.g. an upstream /model badge fix).
		name: subDisplayName(entry),
		baseUrl,
		api: builtinModels[0]?.api,
		apiKey: isOmp ? template.apiKey?.replace(/^\$/, "") : template.apiKey,
		oauth: oauth && modifyModels ? { ...oauth, modifyModels } : oauth,
		models,
		...(isOmp
			? { fetchDynamicModels: async () => liveSubscriptionModels(entry, name) }
			: { refreshModels: async () => liveSubscriptionModels(entry, name) }),
	};
	subscriptionRegistrations.set(name, registration);
	pi.registerProvider(name, registration);
}

// ==========================================================================
// Pool rotation engine
// ==========================================================================

const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i,
	/rate.?limit/i,
	/limit.*reached/i,
	/too many requests/i,
	/overloaded/i,
	/capacity/i,
	/429/,
	/quota/i,
];

const TERMINAL_OAUTH_REFRESH_PATTERNS = [
	/invalid[_\s-]?refresh[_\s-]?token/i,
	/refresh token.*(?:invalid|expired|revoked)/i,
	/(?:invalid|expired|revoked).*refresh token/i,
];

const providersRequiringReauthentication = new Set<string>();

function isRateLimitError(errorMessage: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(errorMessage));
}

function isTerminalOAuthRefreshError(errorMessage: string): boolean {
	return TERMINAL_OAUTH_REFRESH_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

const PI_RETRYABLE_STATUSES = new Set([408, 409, 429]);

function parseHttpStatus(errorMessage: string): number | undefined {
	const leading = errorMessage.match(/^\s*(?:Error:\s*)?(\d{3})\b/);
	if (leading) return Number(leading[1]);
	const field = errorMessage.match(/"status"\s*:\s*(\d{3})\b/);
	return field ? Number(field[1]) : undefined;
}

function piWillRetryTurn(errorMessage: string): boolean {
	const status = parseHttpStatus(errorMessage);
	if (status === undefined) return true;
	return status >= 500 || PI_RETRYABLE_STATUSES.has(status);
}

// ==========================================================================
// Schedule evaluation helpers
// ==========================================================================

const JS_DAY_TO_DOW: DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function getDayOfWeek(date: Date): DayOfWeek {
	return JS_DAY_TO_DOW[date.getDay()];
}

function isInHourRange(hour: number, range: [number, number]): boolean {
	const [start, end] = range;
	if (start <= end) {
		// Normal range, e.g. [9, 17] = 09:00-16:59
		return hour >= start && hour < end;
	}
	// Wrapping range, e.g. [22, 6] = 22:00-05:59
	return hour >= start || hour < end;
}

function isInDateRange(date: Date, range: { from?: string; to?: string }): boolean {
	const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	if (range.from && dateStr < range.from) return false;
	if (range.to && dateStr > range.to) return false;
	return true;
}

function isInScheduleWindow(window: ScheduleWindow, now: Date): boolean {
	if (window.days && window.days.length > 0) {
		if (!window.days.includes(getDayOfWeek(now))) return false;
	}
	if (window.hours) {
		if (!isInHourRange(now.getHours(), window.hours)) return false;
	}
	if (window.dateRange) {
		if (!isInDateRange(now, window.dateRange)) return false;
	}
	return true;
}

/** Calculate ms until the current window closes. Returns Infinity if window
 *  has no hour constraint (open-ended). */
function getWindowRemainingMs(window: ScheduleWindow, now: Date): number {
	if (!window.hours) return Infinity;
	const [, end] = window.hours;
	const endToday = new Date(now);
	endToday.setHours(end, 0, 0, 0);
	let remaining = endToday.getTime() - now.getTime();
	if (remaining <= 0) {
		// End is tomorrow (wrapped range like [22, 6])
		remaining += 24 * 60 * 60 * 1000;
	}
	return remaining;
}

interface ScheduledMemberState {
	provider: string;
	role: "preferred" | "default" | "overflow";
	active: boolean;
	shortestRemainingMs: number;
}

function getScheduledMemberState(
	provider: string,
	schedule: MemberSchedule | undefined,
	now: Date,
): ScheduledMemberState {
	if (!schedule) {
		return { provider, role: "default", active: true, shortestRemainingMs: Infinity };
	}
	const role: "preferred" | "default" | "overflow" = schedule.role || "default";
	if (role === "overflow") {
		return { provider, role, active: true, shortestRemainingMs: Infinity };
	}

	const windows = schedule.windows || [];
	if (windows.length === 0) {
		return { provider, role, active: true, shortestRemainingMs: Infinity };
	}

	let anyActive = false;
	let shortestRemainingMs = Infinity;
	for (const w of windows) {
		if (isInScheduleWindow(w, now)) {
			anyActive = true;
			const remaining = getWindowRemainingMs(w, now);
			if (remaining < shortestRemainingMs) shortestRemainingMs = remaining;
		}
	}

	return { provider, role, active: anyActive, shortestRemainingMs };
}

/** Sort available members by schedule priority:
 *  1. Preferred members in their active window (shortest remaining first)
 *  2. Default members (always available)
 *  3. Overflow members (last resort) */
function getScheduledMemberOrder(
	pool: PoolConfig,
	available: string[],
	now: Date,
): string[] {
	const memberSchedule = pool.memberSchedule || {};
	const states = available.map((provider) =>
		getScheduledMemberState(provider, memberSchedule[provider], now),
	);

	const preferred = states
		.filter((s) => s.role === "preferred" && s.active)
		.sort((a, b) => a.shortestRemainingMs - b.shortestRemainingMs);
	const defaults = states.filter((s) => s.role === "default");
	const overflow = states.filter((s) => s.role === "overflow");
	// Preferred members NOT in their window are skipped entirely
	return [...preferred, ...defaults, ...overflow].map((s) => s.provider);
}

// ==========================================================================
// Custom selector script loader
// ==========================================================================

const selectorCache = new Map<string, PoolSelectorFn | null>();

function resolveSelectorScriptPath(scriptPath: string): string {
	if (isAbsolute(scriptPath)) return scriptPath;
	if (scriptPath.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		return join(home, scriptPath.slice(2));
	}
	// Resolve relative to global config directory
	return join(getAgentDir(), scriptPath);
}

/** Drop every cached variant (any mtime) of one selector script. */
function forgetSelectorScript(scriptPath: string): void {
	const resolved = resolveSelectorScriptPath(scriptPath);
	for (const key of selectorCache.keys()) {
		if (key === resolved || key.startsWith(`${resolved}?mtime=`)) selectorCache.delete(key);
	}
}

async function loadSelectorScript(scriptPath: string): Promise<PoolSelectorFn | null> {
	const resolved = resolveSelectorScriptPath(scriptPath);
	// Key on mtime as well: users iterate on selector scripts, and a path-only
	// cache would keep serving the first imported version until process restart.
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(resolved).mtimeMs;
	} catch {
		forgetSelectorScript(scriptPath);
		return null;
	}
	const cacheKey = `${resolved}?mtime=${mtimeMs}`;
	const cached = selectorCache.get(cacheKey);
	if (cached !== undefined) return cached;

	forgetSelectorScript(scriptPath);

	try {
		const mod = await import(`${pathToFileURL(resolved).href}?mtime=${mtimeMs}`);
		const fn: PoolSelectorFn = typeof mod.default === "function"
			? mod.default
			: typeof mod === "function"
				? mod
				: null;
		selectorCache.set(cacheKey, fn);
		return fn;
	} catch {
		selectorCache.set(cacheKey, null);
		return null;
	}
}

async function runCustomSelector(
	pool: PoolConfig,
	available: string[],
	currentProvider: string,
	modelId: string,
	prompt?: string,
): Promise<string | undefined> {
	if (!pool.selectorScript) return undefined;
	const fn = await loadSelectorScript(pool.selectorScript);
	if (!fn) return undefined;

	const now = new Date();
	const ctx: PoolSelectorContext = {
		members: [...available],
		currentProvider,
		modelId,
		pool: { name: pool.name, baseProvider: pool.baseProvider, members: [...pool.members] },
		timestamp: now.getTime(),
		hour: now.getHours(),
		day: getDayOfWeek(now),
		prompt,
	};

	try {
		const result = await fn(ctx);
		if (typeof result === "string" && available.includes(result)) return result;
		if (Array.isArray(result)) {
			const first = result.find((r) => typeof r === "string" && available.includes(r));
			if (first) return first;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// ==========================================================================
// Pool rotation engine
// ==========================================================================

interface PoolState {
	/** Current index into pool.members */
	currentIndex: number;
	/** Members that are temporarily "exhausted" (hit limit), with timestamps */
	exhausted: Map<string, number>;
	retryAt: Map<string, number>;
	/** Cooldown period in ms before retrying an exhausted member */
	cooldownMs: number;
}

interface RoutingTraceEntry {
	timestamp: number;
	message: string;
}

const MAX_ROUTING_TRACE_ENTRIES = 100;

function summarizeTraceError(errorMessage: string): string {
	const status = parseHttpStatus(errorMessage);
	if (status !== undefined) return `HTTP ${status}`;
	if (/usage.?limit/i.test(errorMessage)) return "usage limit";
	if (/rate.?limit|too many requests/i.test(errorMessage)) return "rate limit";
	if (/overloaded/i.test(errorMessage)) return "overloaded";
	if (/capacity/i.test(errorMessage)) return "capacity";
	if (/quota/i.test(errorMessage)) return "quota";
	return "provider error";
}

class PoolManager {
	private pools: Map<string, PoolConfig> = new Map();
	private poolStates: Map<string, PoolState> = new Map();
	/** Map from provider name -> pool name (for quick lookup) */
	private providerToPool: Map<string, string> = new Map();
	private pi: ExtensionAPI;
	private cascadeState: FailoverCascadeState | null = null;
	private suppressNextStartTurn = false;
	private hostContinuationPending = false;
	private startupQuotaCheck?: Promise<void>;
	private startupQuotaGeneration = 0;
	private traceEnabled = false;
	private routingTrace: RoutingTraceEntry[] = [];
	private usage = new Map<string, AccountUsage>();
	private recordedMessages = new WeakSet<object>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	resetUsage(): void {
		this.usage.clear();
		this.recordedMessages = new WeakSet<object>();
	}

	recordUsage(provider: string, message: object & { usage?: unknown }): void {
		if (!provider || this.recordedMessages.has(message)) return;
		this.recordedMessages.add(message);
		this.usage.set(provider, addUsage(this.usage.get(provider), message.usage));
	}

	getUsage(): Record<string, AccountUsage> {
		return Object.fromEntries([...this.usage].map(([provider, usage]) => [provider, { ...usage }]));
	}

	async preview(currentModel: Model<Api>, config: MultiPassConfig, ctx: ExtensionContext): Promise<string[]> {
		const shadow = new PoolManager({} as ExtensionAPI);
		shadow.loadPools(config.pools);
		for (const [name, state] of this.poolStates) {
			shadow.poolStates.set(name, { ...state, exhausted: new Map(state.exhausted), retryAt: new Map(state.retryAt) });
		}
		shadow.usage = new Map(this.usage);
		const pool = shadow.getPoolForProvider(currentModel.provider);
		const lines = [`Routing preview — ${currentModel.provider}/${currentModel.id}`, "No model switch, prompt, quota request, or selector script is run."];
		if (!pool) return [...lines, "Current provider is not in an enabled pool."];
		lines.push(`Pool: ${pool.name} · strategy: ${pool.strategy ?? "round-robin"}`);
		const plan = shadow.buildFailoverPlan(currentModel, config, getAuthStorage(ctx));
		if (pool.strategy !== "custom" && pool.strategy !== "quota-first") {
			await shadow.reorderCandidatesByStrategy(pool, plan, currentModel, { ...ctx, ui: { ...ctx.ui, notify() {} } }, {
				prompt: "", attemptedProviders: new Set(), visitedChainIndexes: new Set(),
			}, null);
		} else if (pool.strategy === "quota-first") {
			const ranked = plan.candidates.filter(candidate => candidate.source === "pool");
			ranked.sort((left, right) => {
				const a = statusBarQuota.get(left.provider), b = statusBarQuota.get(right.provider);
				return a && b ? compareQuotaResults(a, b) : a ? -1 : b ? 1 : 0;
			});
			plan.candidates = [...ranked, ...plan.candidates.filter(candidate => candidate.source !== "pool")];
			lines.push("Quota order uses the last cached snapshot; live results may differ.");
		} else {
			lines.push("Custom selector is not executed; the listed order is its round-robin fallback.");
		}
		let nextPrompt = currentModel.provider;
		if (pool.strategy === "per-turn") nextPrompt = plan.candidates.find(candidate => candidate.source === "pool" && ctx.modelRegistry.find(candidate.provider, currentModel.id))?.provider ?? nextPrompt;
		if (pool.strategy === "weighted") {
			const usable = shadow.getAvailableMembers(pool, getAuthStorage(ctx)).filter(provider => ctx.modelRegistry.find(provider, currentModel.id));
			nextPrompt = weightedNextMember(pool.members, currentModel.provider, usable, pool.memberWeights ?? {}, this.getUsage()) ?? nextPrompt;
		}
		lines.push(`Next new prompt: ${nextPrompt}/${currentModel.id}`);
		const candidates = plan.candidates.filter(candidate => ctx.modelRegistry.find(candidate.provider, candidate.modelId));
		lines.push(...candidates.map((candidate, index) => `Failover ${index + 1}: ${candidate.provider}/${candidate.modelId} (${candidate.poolName})`));
		if (!candidates.length) lines.push("No usable failover target.");
		for (const member of pool.members) {
			const remaining = shadow.getCooldownRemainingMs(member);
			if (remaining) lines.push(`Cooldown: ${member} · ${Math.ceil(remaining / 1000)}s remaining`);
		}
		lines.push(...plan.skips.map(skip => `Skipped: ${skip.detail}`));
		return lines;
	}

	startTrace(): void {
		this.routingTrace = [];
		this.traceEnabled = true;
	}

	stopTrace(): void {
		this.traceEnabled = false;
	}

	clearTrace(): void {
		this.routingTrace = [];
	}

	isTraceEnabled(): boolean {
		return this.traceEnabled;
	}

	getRoutingTrace(): RoutingTraceEntry[] {
		return this.routingTrace.map((entry) => ({ ...entry }));
	}

	private recordTrace(message: string): void {
		if (!this.traceEnabled) return;
		this.routingTrace.push({ timestamp: Date.now(), message });
		if (this.routingTrace.length > MAX_ROUTING_TRACE_ENTRIES) {
			this.routingTrace.splice(0, this.routingTrace.length - MAX_ROUTING_TRACE_ENTRIES);
		}
	}

	private getOrCreatePoolState(poolName: string): PoolState {
		let state = this.poolStates.get(poolName);
		if (!state) {
			state = {
				currentIndex: 0,
				exhausted: new Map(),
				retryAt: new Map(),
				cooldownMs: 5 * 60 * 1000, // 5 min default cooldown
			};
			this.poolStates.set(poolName, state);
		}
		return state;
	}

	loadPools(configs: PoolConfig[]): void {
		this.pools.clear();
		this.providerToPool.clear();

		const activePoolNames = new Set<string>();
		for (const pool of configs) {
			if (!pool || typeof pool.name !== "string" || !Array.isArray(pool.members)) continue;
			if (!pool.enabled) continue;
			activePoolNames.add(pool.name);
			this.pools.set(pool.name, pool);

			const state = this.getOrCreatePoolState(pool.name);
			state.currentIndex = pool.members.length > 0 ? state.currentIndex % pool.members.length : 0;
			for (const member of Array.from(state.exhausted.keys())) {
				if (!pool.members.includes(member)) {
					state.exhausted.delete(member);
					state.retryAt.delete(member);
				}
			}

			// Map each member to this pool
			for (const member of pool.members) {
				this.providerToPool.set(member, pool.name);
			}
		}

		for (const poolName of Array.from(this.poolStates.keys())) {
			if (!activePoolNames.has(poolName)) {
				this.poolStates.delete(poolName);
			}
		}
	}

	/** Find pool for a given provider name */
	getPoolForProvider(providerName: string): PoolConfig | undefined {
		const poolName = this.providerToPool.get(providerName);
		return poolName ? this.pools.get(poolName) : undefined;
	}

	/** Get available (non-exhausted, authenticated) members of a pool */
	getAvailableMembers(
		pool: PoolConfig,
		authStorage: { hasAuth(provider: string): boolean },
	): string[] {
		return pool.members.filter((member) => {
			if (!authStorage.hasAuth(member)) return false;
			return !this.isMemberExhausted(pool, member);
		});
	}

	isMemberExhausted(pool: PoolConfig, provider: string): boolean {
		const state = this.getOrCreatePoolState(pool.name);
		const exhaustedAt = state.exhausted.get(provider);
		if (!exhaustedAt) return false;
		if (Date.now() >= (state.retryAt.get(provider) ?? exhaustedAt + state.cooldownMs)) {
			state.exhausted.delete(provider);
			state.retryAt.delete(provider);
			return false;
		}
		return true;
	}

	getCooldownRemainingMs(provider: string): number {
		const pool = this.getPoolForProvider(provider);
		if (!pool || !this.isMemberExhausted(pool, provider)) return 0;
		const state = this.getOrCreatePoolState(pool.name);
		return Math.max(0, (state.retryAt.get(provider) ?? state.exhausted.get(provider)! + state.cooldownMs) - Date.now());
	}

	getEnabledChains(config: MultiPassConfig): ChainConfig[] {
		return config.chains.filter((chain) => chain.enabled);
	}

	findApplicableChain(poolName: string, config: MultiPassConfig): {
		chain: ChainConfig;
		index: number;
	} | undefined {
		for (const chain of this.getEnabledChains(config)) {
			const index = chain.entries.findIndex((entry) => entry.pool === poolName);
			if (index >= 0) {
				return { chain, index };
			}
		}
		return undefined;
	}

	buildFailoverPlan(
		currentModel: Model<Api>,
		config: MultiPassConfig,
		authStorage: { hasAuth(provider: string): boolean },
		options?: FailoverPlanOptions,
	): FailoverPlan {
		const attemptedProviders = options?.attemptedProviders ?? new Set<string>();
		const visitedChainIndexes = options?.visitedChainIndexes ?? new Set<number>();
		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) {
			return { candidates: [], skips: [] };
		}

		const skips: FailoverSkip[] = [];
		const candidates: FailoverCandidate[] = [];
		const poolSize = pool.members.length;
		const currentIndex = pool.members.indexOf(currentModel.provider);
		const startIndex = currentIndex >= 0 ? currentIndex : 0;

		for (let step = 1; step <= poolSize; step++) {
			const candidateIndex = poolSize <= 0 ? -1 : (startIndex + step) % poolSize;
			if (candidateIndex < 0) break;
			const candidate = pool.members[candidateIndex];
			if (candidate === currentModel.provider) continue;
			if (attemptedProviders.has(candidate)) {
				skips.push({
					type: "pool-member",
					poolName: pool.name,
					reason: "already-attempted",
					detail: `${candidate} skipped (already attempted this turn)`,
				});
				continue;
			}
			const skip = classifyPoolMemberSkip(
				pool.name,
				candidate,
				authStorage,
				this.isMemberExhausted(pool, candidate),
			);
			if (skip) {
				skips.push(skip);
				continue;
			}
			candidates.push({
				poolName: pool.name,
				provider: candidate,
				modelId: currentModel.id,
				source: "pool",
			});
		}

		const applicable = this.findApplicableChain(pool.name, config);
		if (!applicable) {
			return { pool, candidates, skips };
		}

		for (let chainIndex = applicable.index + 1; chainIndex < applicable.chain.entries.length; chainIndex++) {
			const entry = applicable.chain.entries[chainIndex];
			if (visitedChainIndexes.has(chainIndex)) {
				skips.push({
					type: "chain-entry",
					poolName: entry.pool,
					reason: "already-visited-chain-entry",
					detail: `${entry.pool} -> ${entry.model} skipped (chain entry already visited this turn)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
				continue;
			}
			const entrySkip = classifyChainEntrySkip(applicable.chain, chainIndex, entry, config);
			if (entrySkip) {
				skips.push(entrySkip);
				continue;
			}
			const targetPool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!targetPool) {
				skips.push({
					type: "chain-entry",
					poolName: entry.pool,
					reason: "missing-pool",
					detail: `${entry.pool} -> ${entry.model} skipped (pool missing)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
				continue;
			}
			let foundEligible = false;
			for (const member of targetPool.members) {
				if (attemptedProviders.has(member)) {
					skips.push({
						type: "pool-member",
						poolName: targetPool.name,
						reason: "already-attempted",
						detail: `${member} skipped (already attempted this turn)`,
						chainName: applicable.chain.name,
						chainIndex,
					});
					continue;
				}
				const memberSkip = classifyPoolMemberSkip(
					targetPool.name,
					member,
					authStorage,
					this.isMemberExhausted(targetPool, member),
				);
				if (memberSkip) {
					skips.push({
						...memberSkip,
						chainName: applicable.chain.name,
						chainIndex,
					});
					continue;
				}
				foundEligible = true;
				candidates.push({
					poolName: targetPool.name,
					provider: member,
					modelId: entry.model,
					source: "chain",
					chainName: applicable.chain.name,
					chainIndex,
				});
			}
			if (!foundEligible) {
				skips.push({
					type: "chain-entry",
					poolName: targetPool.name,
					reason: "no-eligible-members",
					detail: `${targetPool.name} -> ${entry.model} skipped (no eligible members)`,
					chainName: applicable.chain.name,
					chainIndex,
				});
			}
		}

		return {
			pool,
			chain: applicable.chain,
			currentChainIndex: applicable.index,
			candidates,
			skips,
		};
	}

	/** Mark a member as exhausted (hit rate limit) */
	markExhausted(providerName: string, errorMessage = "", resetAtSeconds?: number): void {
		const poolName = this.providerToPool.get(providerName);
		if (!poolName) return;
		const state = this.getOrCreatePoolState(poolName);
		const now = Date.now();
		state.exhausted.set(providerName, now);
		state.retryAt.set(providerName, now + parseCooldownMs(errorMessage, now, state.cooldownMs, resetAtSeconds));
	}

	resetStartupSelection(): void {
		this.startupQuotaGeneration++;
		this.startupQuotaCheck = undefined;
	}

	/** Check once per session; defer until a model is available if necessary. */
	selectStartupMember(ctx: ExtensionContext): Promise<void> {
		if (!ctx.model) return Promise.resolve();
		if (!this.startupQuotaCheck) {
			this.startupQuotaCheck = this.selectStartupQuotaMember(ctx, ctx.model, this.startupQuotaGeneration);
		}
		return this.startupQuotaCheck;
	}

	private async selectStartupQuotaMember(ctx: ExtensionContext, currentModel: Model<Api>, generation: number): Promise<void> {
		const pool = this.getPoolForProvider(currentModel.provider);
		if (pool?.strategy !== "quota-first") return;
		const available = new Set(this.getAvailableMembers(pool, getAuthStorage(ctx)));
		const accounts = collectQuotaAccounts(ctx).filter(account =>
			available.has(account.providerName)
			&& !account.pendingSelection
			&& ctx.modelRegistry.find(account.providerName, currentModel.id),
		);
		if (accounts.length === 0) return;
		const sessionId = ctx.sessionManager?.getSessionId();
		try {
			const signal = AbortSignal.timeout(3000);
			// Some checkers refresh credentials before reaching fetch. Race the
			// whole lookup so even a refresh that ignores the signal cannot stall startup.
			const results = (await Promise.race([
				runQuotaChecks(accounts, signal),
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			]))
				.filter(result => result.kind !== "error" && result.kind !== "missing-auth" && result.kind !== "pending-selection"
					&& result.worstRemainingPercent !== undefined && result.worstRemainingPercent > 0)
				.sort((left, right) => {
					// Keep the current account on an equal quota score rather than
					// letting the display-name tie-breaker cause an unnecessary switch.
					if (left.kind === right.kind && left.score === right.score) {
						return Number(right.account.providerName === currentModel.provider)
							- Number(left.account.providerName === currentModel.provider)
							|| compareQuotaResults(left, right);
					}
					return compareQuotaResults(left, right);
				});
			// A slow response must not undo a user model/account change or affect
			// a different session/pool configuration.
			const names = new Set(accounts.map(account => account.providerName));
			if (generation !== this.startupQuotaGeneration
				|| ctx.sessionManager?.getSessionId() !== sessionId
				|| ctx.model?.provider !== currentModel.provider || ctx.model?.id !== currentModel.id
				|| this.getPoolForProvider(currentModel.provider) !== pool
				|| !sameQuotaAccounts(accounts, collectQuotaAccounts(ctx).filter(account => names.has(account.providerName)))) return;
			const stillAvailable = new Set(this.getAvailableMembers(pool, getAuthStorage(ctx)));
			for (const result of results) {
				const provider = result.account.providerName;
				if (!stillAvailable.has(provider)) continue;
				if (provider === currentModel.provider) return;
				const model = ctx.modelRegistry.find(provider, currentModel.id);
				if (!model) continue;
				try {
					if (!await this.pi.setModel(model)) continue;
				} catch {
					this.recordTrace(`${provider} skipped because the startup quota switch failed`);
					continue;
				}
				ctx.ui.notify(`[pool:${pool.name}] quota-first startup: selected ${provider} (${Math.round(result.worstRemainingPercent!)}% remaining at its bottleneck)`, "info");
				ctx.ui.setStatus("multi-pass", `pool:${pool.name} | quota-first | active ${provider} (${model.id})`);
				this.recordTrace(`startup quota-first selected ${provider} (${model.id}) via pool ${pool.name}`);
				return;
			}
		} catch {
			// Startup quota lookups are bounded and optional; preserve the active
			// model when the endpoint is unavailable and keep normal failover.
			this.recordTrace("startup quota check unavailable; retaining the current account");
		}
	}

	/**
	 * Pick the best member using built-in quota checkers.
	 * Returns the provider name with the highest remaining quota,
	 * or undefined if no quota data is available (caller should
	 * fall back to round-robin).
	 */
	async getQuotaBestMember(
		pool: PoolConfig,
		currentProvider: string,
		authStorage: { hasAuth(provider: string): boolean; get(provider: string): unknown },
		excludeProviders?: Set<string>,
	): Promise<string | undefined> {
		const available = this.getAvailableMembers(pool, authStorage);
		const eligible = available.filter(
			(member) => member !== currentProvider && !(excludeProviders?.has(member)),
		);
		if (eligible.length === 0) return undefined;
		// If only one candidate, skip the network calls.
		if (eligible.length === 1) return eligible[0];

		const accounts: QuotaAccount[] = eligible.map((providerName) => ({
			providerName,
			baseProvider: getBaseProvider(providerName) || providerName,
			displayName: providerName,
			auth: authStorage.get(providerName) as AuthStorageEntry | undefined,
		}));

		try {
			const results = await runQuotaChecks(accounts);
			if (results.length === 0) return undefined;
			// runQuotaChecks returns sorted best-first.
			const best = results[0];
			// Only use quota selection when the best result has real data.
			if (best.kind === "error" || best.kind === "missing-auth" || best.kind === "pending-selection") return undefined;
			return best.account.providerName;
		} catch {
			// Network failure etc. -- fall back to round-robin.
			return undefined;
		}
	}

	/**
	 * Reorder failover plan candidates based on the pool's strategy.
	 * Mutates plan.candidates in place.
	 */
	private async reorderCandidatesByStrategy(
		pool: PoolConfig,
		plan: FailoverPlan,
		currentModel: Model<Api>,
		ctx: ExtensionContext,
		cascade: FailoverCascadeState,
		lastUserPrompt: string | null,
	): Promise<void> {
		const strategy = pool.strategy || "round-robin";
		if (strategy === "round-robin" || strategy === "per-turn") return;

		const poolCandidates = plan.candidates.filter(
			(c) => c.source === "pool" && c.poolName === pool.name,
		);
		if (strategy === "weighted") {
			const remaining = [...poolCandidates];
			const ordered: FailoverCandidate[] = [];
			let current = currentModel.provider;
			while (remaining.length) {
				const provider = weightedNextMember(pool.members, current, remaining.map(candidate => candidate.provider), pool.memberWeights ?? {}, this.getUsage());
				const index = remaining.findIndex(candidate => candidate.provider === provider);
				if (index < 0) break;
				ordered.push(...remaining.splice(index, 1));
				current = provider!;
			}
			plan.candidates = [...ordered, ...plan.candidates.filter(candidate => candidate.source !== "pool" || candidate.poolName !== pool.name)];
			return;
		}
		if (poolCandidates.length < 2 && strategy === "quota-first") return;

		if (strategy === "quota-first") {
			try {
				const best = await this.getQuotaBestMember(
					pool,
					currentModel.provider,
					getAuthStorage(ctx),
					cascade.attemptedProviders,
				);
				if (best) {
					const bestIdx = plan.candidates.findIndex(
						(c) => c.provider === best && c.source === "pool",
					);
					if (bestIdx > 0) {
						const [moved] = plan.candidates.splice(bestIdx, 1);
						plan.candidates.unshift(moved);
						ctx.ui.notify(
							`[pool:${pool.name}] quota-first: ${best} has the most remaining quota`,
							"info",
						);
						this.recordTrace(`${best} ranked first by quota-first in pool ${pool.name}`);
					}
				}
			} catch {
				// Quota check failed -- proceed with default order.
			}
			return;
		}

		if (strategy === "scheduled") {
			const available = poolCandidates.map((c) => c.provider);
			const ordered = getScheduledMemberOrder(pool, available, new Date());

			// Rebuild pool candidates in schedule order, keep chain candidates at the end.
			const chainCandidates = plan.candidates.filter(
				(c) => c.source === "chain" || c.poolName !== pool.name,
			);
			const reordered = ordered
				.map((provider) => poolCandidates.find((c) => c.provider === provider))
				.filter((c): c is FailoverCandidate => Boolean(c));
			plan.candidates = [...reordered, ...chainCandidates];

			const first = ordered[0];
			if (first) {
				ctx.ui.notify(
					`[pool:${pool.name}] scheduled: ${first} selected by schedule priority`,
					"info",
				);
				this.recordTrace(`${first} ranked first by schedule in pool ${pool.name}`);
			}
			return;
		}

		if (strategy === "custom") {
			const available = poolCandidates.map((c) => c.provider);
			try {
				const best = await runCustomSelector(
					pool,
					available,
					currentModel.provider,
					currentModel.id,
					lastUserPrompt || undefined,
				);
				if (best) {
					const bestIdx = plan.candidates.findIndex(
						(c) => c.provider === best && c.source === "pool",
					);
					if (bestIdx > 0) {
						const [moved] = plan.candidates.splice(bestIdx, 1);
						plan.candidates.unshift(moved);
						ctx.ui.notify(
							`[pool:${pool.name}] custom: selector chose ${best}`,
							"info",
						);
						this.recordTrace(`${best} ranked first by custom selector in pool ${pool.name}`);
					}
				}
			} catch {
				// Custom selector failed -- proceed with default order.
			}
			return;
		}
	}

	private ensureCascadeState(prompt: string | null, currentModel: Model<Api>): FailoverCascadeState {
		if (!prompt) {
			const fallbackState: FailoverCascadeState = {
				prompt: "",
				attemptedProviders: new Set([currentModel.provider]),
				visitedChainIndexes: new Set<number>(),
			};
			this.cascadeState = fallbackState;
			return fallbackState;
		}

		if (!this.cascadeState || this.cascadeState.prompt !== prompt) {
			this.cascadeState = {
				prompt,
				attemptedProviders: new Set([currentModel.provider]),
				visitedChainIndexes: new Set<number>(),
			};
		} else {
			this.cascadeState.attemptedProviders.add(currentModel.provider);
		}

		return this.cascadeState;
	}

	/** Advance within the pool without changing the requested model. */
	private async rotatePerTurn(currentModel: Model<Api>, ctx: ExtensionContext): Promise<Model<Api>> {
		const pool = this.getPoolForProvider(currentModel.provider);
		if (pool?.strategy !== "per-turn" && pool?.strategy !== "weighted") return currentModel;
		const available = new Set(this.getAvailableMembers(pool, getAuthStorage(ctx)));
		if (pool.strategy === "weighted") {
			const usable = [...available].filter(provider => ctx.modelRegistry.find(provider, currentModel.id));
			while (usable.length) {
				const provider = weightedNextMember(pool.members, currentModel.provider, usable, pool.memberWeights ?? {}, this.getUsage());
				if (!provider || provider === currentModel.provider) return currentModel;
				const model = ctx.modelRegistry.find(provider, currentModel.id)!;
				try {
					if (await this.pi.setModel(model)) {
						this.recordTrace(`weighted selected ${provider} (${model.id}) via pool ${pool.name}`);
						return model;
					}
				} catch { /* Try the next usable account. */ }
				usable.splice(usable.indexOf(provider), 1);
			}
			return currentModel;
		}
		const startIndex = pool.members.indexOf(currentModel.provider);
		for (let step = 1; step < pool.members.length; step++) {
			const provider = pool.members[(startIndex + step) % pool.members.length];
			if (!available.has(provider)) continue;
			const model = ctx.modelRegistry.find(provider, currentModel.id);
			if (!model) continue;
			try {
				if (!await this.pi.setModel(model)) continue;
			} catch {
				this.recordTrace(`${provider} skipped because the per-turn switch failed`);
				continue;
			}
			this.recordTrace(`per-turn selected ${provider} (${model.id}) via pool ${pool.name}`);
			ctx.ui.setStatus("multi-pass", `pool:${pool.name} | per-turn | active ${provider} (${model.id})`);
			return model;
		}
		return currentModel;
	}

	async startTurn(prompt: string | null, currentModel?: Model<Api>, ctx?: ExtensionContext): Promise<boolean> {
		if (this.suppressNextStartTurn) {
			this.suppressNextStartTurn = false;
			this.hostContinuationPending = false;
			return false;
		}
		const hostContinuationPending = this.hostContinuationPending;
		this.hostContinuationPending = false;
		if (hostContinuationPending) {
			if (currentModel) this.cascadeState?.attemptedProviders.add(currentModel.provider);
			return false;
		}
		if (!prompt) {
			this.cascadeState = null;
			return false;
		}
		if (currentModel && ctx) currentModel = await this.rotatePerTurn(currentModel, ctx);
		this.cascadeState = {
			prompt,
			attemptedProviders: new Set(currentModel ? [currentModel.provider] : []),
			visitedChainIndexes: new Set<number>(),
		};
		if (currentModel) {
			const pool = this.getPoolForProvider(currentModel.provider);
			const source = pool ? `pool ${pool.name} (${pool.strategy || "round-robin"})` : "current model";
			this.recordTrace(`turn started on ${currentModel.provider} (${currentModel.id}) via ${source}`);
		}
		return true;
	}

	clearCascadeState(): void {
		this.cascadeState = null;
		this.suppressNextStartTurn = false;
		this.hostContinuationPending = false;
	}

	continueTurn(): void {
		this.hostContinuationPending = true;
	}

	getCascadeStateSnapshot():
		| { prompt: string; attemptedProviders: string[]; visitedChainIndexes: number[] }
		| null {
		if (!this.cascadeState) return null;
		return {
			prompt: this.cascadeState.prompt,
			attemptedProviders: [...this.cascadeState.attemptedProviders],
			visitedChainIndexes: [...this.cascadeState.visitedChainIndexes],
		};
	}

	/**
	 * Handle an error: if it's a rate limit and the provider is in a pool,
	 * build an ordered failover plan, switch to the first usable candidate, and retry.
	 * Returns true if rotation happened.
	 */
	async handleError(
		errorMessage: string,
		currentModel: Model<Api> | undefined,
		ctx: ExtensionContext,
		lastUserPrompt: string | null,
		config: MultiPassConfig,
		hostWillRetry?: boolean,
		resetAtSeconds?: number,
	): Promise<boolean> {
		if (!currentModel) return false;
		if (!isRateLimitError(errorMessage)) return false;

		const pool = this.getPoolForProvider(currentModel.provider);
		if (!pool) return false;

		this.recordTrace(`${currentModel.provider} failed with ${summarizeTraceError(errorMessage)}`);
		const cascade = this.ensureCascadeState(lastUserPrompt, currentModel);

		// Mark current as exhausted before planning the forward-only cascade.
		this.markExhausted(currentModel.provider, errorMessage, resetAtSeconds);

		const plan = this.buildFailoverPlan(
			currentModel,
			config,
			getAuthStorage(ctx),
			{
				attemptedProviders: cascade.attemptedProviders,
				visitedChainIndexes: cascade.visitedChainIndexes,
			},
		);

		// Strategy-aware reordering of pool candidates before failover.
		await this.reorderCandidatesByStrategy(
			pool,
			plan,
			currentModel,
			ctx,
			cascade,
			lastUserPrompt,
		);

		const continuation = formatFailoverContinuation(plan.candidates[0]);
		for (const skip of plan.skips) {
			ctx.ui.notify(
				`[pool:${skip.poolName}] ${skip.detail}; ${continuation}`,
				"warning",
			);
			this.recordTrace(skip.detail);
		}

		let nextCandidate: FailoverCandidate | undefined;
		for (let index = 0; index < plan.candidates.length; index++) {
			const candidate = plan.candidates[index];
			const model = ctx.modelRegistry.find(candidate.provider, candidate.modelId);
			let issue = "model missing at runtime";
			if (model) {
				try {
					if (await this.pi.setModel(model)) {
						nextCandidate = candidate;
						break;
					}
					issue = "authentication unavailable during switch";
				} catch {
					issue = "model switch failed";
				}
			}
			cascade.attemptedProviders.add(candidate.provider);
			ctx.ui.notify(
				`[pool:${candidate.poolName}] ${candidate.provider} -> ${candidate.modelId} skipped (${issue}); ${formatFailoverContinuation(plan.candidates[index + 1])}`,
				"warning",
			);
			this.recordTrace(`${candidate.provider} skipped because ${issue}`);
		}
		if (!nextCandidate) {
			ctx.ui.notify(formatFailoverExhausted(pool.name, currentModel.provider), "warning");
			ctx.ui.setStatus("multi-pass", formatFailoverStatus(null, pool.name));
			this.recordTrace(`failover exhausted in pool ${pool.name}`);
			return false;
		}

		cascade.attemptedProviders.add(nextCandidate.provider);
		if (typeof nextCandidate.chainIndex === "number") {
			cascade.visitedChainIndexes.add(nextCandidate.chainIndex);
		}

		ctx.ui.notify(
			formatFailoverTransition(pool.name, currentModel.provider, nextCandidate),
			"info",
		);
		ctx.ui.setStatus("multi-pass", formatFailoverStatus(nextCandidate));
		const route = nextCandidate.source === "chain"
			? `chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
			: `pool ${nextCandidate.poolName} (${pool.strategy || "round-robin"})`;
		this.recordTrace(`selected ${nextCandidate.provider} (${nextCandidate.modelId}) via ${route}`);

		const willRetry = hostWillRetry ?? piWillRetryTurn(errorMessage);
		if (lastUserPrompt && !willRetry) {
			this.suppressNextStartTurn = true;
			this.pi.sendUserMessage(lastUserPrompt, { deliverAs: "followUp" });
			this.recordTrace("queued follow-up because the host will not retry this error");
		} else if (willRetry) {
			this.continueTurn();
			this.recordTrace("waiting for the host to retry the turn");
		} else {
			this.recordTrace("turn cannot be replayed because no prompt was captured");
		}

		return true;
	}

	getPoolConfigs(): PoolConfig[] {
		return Array.from(this.pools.values());
	}
}

// ==========================================================================
// /subs command handlers
// ==========================================================================

async function handleSubsDoctor(ctx: ExtensionCommandContext): Promise<void> {
	const models = ctx.modelRegistry.getAll();
	const knownProviders = [...new Set([...SUPPORTED_PROVIDERS, ...models.map(model => model.provider)])];
	const modelsByProvider = Object.fromEntries(knownProviders.map(provider => [provider, models.filter(model => model.provider === provider).map(model => model.id)]));
	const lines = [`Multi-pass doctor · ${isOmp ? "OMP" : "Pi"}`, `Agent directory: ${getAgentDir()}`];
	let errors = 0;
	let inheritedPools: PoolConfig[] = [];
	for (const [path, project] of [[globalConfigPath(), false], [projectConfigPath(ctx.cwd), true]] as const) {
		if (!existsSync(path)) { lines.push(`OK ${path}: absent (defaults/inheritance)`); continue; }
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			const issues = validateRoutingConfig(raw, { project, knownProviders, modelsByProvider, inheritedPools });
			if (!project) inheritedPools = normalizeMultiPassConfig(raw).pools;
			if (!issues.length) lines.push(`OK ${path}`);
			for (const issue of issues) {
				if (issue.level === "error") errors++;
				lines.push(`${issue.level.toUpperCase()} ${path} ${issue.path}: ${issue.message}`);
			}
		} catch {
			errors++;
			lines.push(`ERROR ${path}: unreadable or invalid JSON. Correct the file, then run /subs doctor again.`);
		}
	}
	try {
		const effective = loadEffectiveConfig(ctx.cwd);
		lines.push(`Project providers: ${effective.allowedProviderNames?.join(", ") ?? "all"}`);
		const auth = getAuthStorage(ctx);
		const providers = effective.allowedProviderNames ?? [...new Set([...knownProviders, ...effective.subscriptions.map(subProviderName), ...effective.pools.flatMap(pool => pool.members)])];
		for (const provider of providers) {
			if (isOmp) {
				const native = (ctx.modelRegistry as any).authStorage ?? ompAuth;
				const sid = ctx.sessionManager?.getSessionId();
				if (!(sid && native.sessions.get(provider, sid)) && native.credentials.list(provider).filter((entry: { credential: AuthStorageEntry }) => entry.credential.type === "oauth").length > 1) {
					lines.push(`WARN ${provider}: choose a saved OMP login for this session.`); continue;
				}
			}
			const credential = auth.get(provider);
			if (!auth.hasAuth(provider)) { lines.push(`WARN ${provider}: no credential; run /login or /subs login.`); continue; }
			if (providersRequiringReauthentication.has(provider)) {
				lines.push(`WARN ${provider}: rejected credential; run /subs login.`);
			} else if (credential?.type === "oauth" && typeof credential.expires === "number" && credential.expires <= Date.now()) {
				lines.push(`WARN ${provider}: access token expired; the host must refresh it. Use /subs login if refresh fails.`);
			} else lines.push(`OK ${provider}: credential available`);
		}
		if (ctx.model && effective.allowedProviderNames && !effective.allowedProviderNames.includes(ctx.model.provider)) {
			errors++;
			lines.push(`ERROR active provider ${ctx.model.provider} is outside the project allow-list.`);
		}
	} catch { errors++; lines.push("ERROR account checks could not run. Fix the configuration errors first."); }
	lines.push(statusBarQuotaFetchedAt ? `Quota snapshot: ${Math.max(0, Math.round((Date.now() - statusBarQuotaFetchedAt) / 1000))}s old; refresh with /subs limits.` : "Quota has not been checked; use /subs limits.");
	lines.push(`${errors} configuration error${errors === 1 ? "" : "s"}. Credentials and prompts are never included in this report.`);
	ctx.ui.notify(lines.join("\n"), errors ? "warning" : "info");
}

async function handleSubsStats(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const rows = Object.entries(poolManager.getUsage()).map(([provider, usage]) =>
		`${provider}: ${usage.requests} requests · input ${usage.inputTokens} · output ${usage.outputTokens} · total ${usage.totalTokens} tokens`,
	);
	ctx.ui.notify(`Account usage — current session\n${rows.join("\n") || "No finalized assistant requests yet."}\nInput includes cache reads/writes; unavailable usage is counted as zero.`, "info");
}

async function handlePoolPreview(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	if (!ctx.model) { ctx.ui.notify("Select a model before previewing routing.", "warning"); return; }
	const effective = loadEffectiveConfig(ctx.cwd);
	const config = normalizeMultiPassConfig(effective);
	ctx.ui.notify((await poolManager.preview(ctx.model, config, ctx)).join("\n"), "info");
}

async function handlePoolWeights(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(ctx.cwd);
	const pools = project?.pools ?? global.pools;
	const name = await ctx.ui.select("Pool to balance by weight", pools.map(pool => pool.name));
	const pool = pools.find(pool => pool.name === name);
	if (!pool) return;
	const weights: Record<string, number> = {};
	for (const member of pool.members) {
		const raw = await ctx.ui.input(`Weight for ${member} (positive number; default 1)`, String(pool.memberWeights?.[member] ?? 1));
		if (raw === undefined) return;
		const weight = raw.trim() === "" ? 1 : Number(raw);
		if (!Number.isFinite(weight) || weight <= 0) { ctx.ui.notify("Weights must be positive finite numbers. Nothing was saved.", "warning"); return; }
		weights[member] = weight;
	}
	pool.memberWeights = weights;
	pool.strategy = "weighted";
	if (project?.pools) saveProjectConfig(ctx.cwd, project);
	else saveGlobalConfig(global);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Weighted routing enabled for ${pool.name}: ${Object.entries(weights).map(([member, weight]) => `${member}=${weight}`).join(", ")}. Balances finalized request counts within this session.`, "info");
}

function getSubscriptionSource(config: MultiPassConfig, entry: SubEntry): "config" | "env" {
	return config.subscriptions.find(
		(s) => s.provider === entry.provider && s.index === entry.index,
	)
		? "config"
		: "env";
}

function formatSubscriptionMeta(
	entry: SubEntry,
	config: MultiPassConfig,
	authStorage: { hasAuth(provider: string): boolean },
): string {
	const name = subProviderName(entry);
	const hasAuth = authStorage.hasAuth(name);
	const status = providersRequiringReauthentication.has(name)
		? "[reauthentication required]"
		: hasAuth
			? "[logged in]"
			: "[not logged in]";
	const source = getSubscriptionSource(config, entry);
	return `${status} (${source})`;
}

function formatSubscriptionListLine(
	entry: SubEntry,
	config: MultiPassConfig,
	authStorage: { hasAuth(provider: string): boolean },
): string {
	return `${subDisplayName(entry)} -- ${formatSubscriptionMeta(entry, config, authStorage)}`;
}

function normalizeSwitchAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function getSwitchableProviderOptions(
	ctx: ExtensionContext | ExtensionCommandContext,
): Array<{ providerName: string; label: string; description: string }> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const options: Array<{ providerName: string; label: string; description: string }> = [];
	const seen = new Set<string>();
	const push = (providerName: string, label: string, description: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (!getAuthStorage(ctx).hasAuth(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		options.push({ providerName, label, description });
	};

	for (const providerName of SUPPORTED_PROVIDERS) {
		push(
			providerName,
			PROVIDER_TEMPLATES[providerName]?.displayName || providerName,
			"base provider",
		);
	}
	for (const entry of allSubs) {
		push(subProviderName(entry), subDisplayName(entry), "extra subscription");
	}
	return options;
}

function resolveSwitchTargetModel(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!getAuthStorage(ctx).hasAuth(providerName)) {
		return undefined;
	}
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) {
			return preferred as Model<Api>;
		}
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) {
		return undefined;
	}
	for (const baseModel of minimaxBase(providerName)
		? providerModelChoices(ctx, providerName)
		: getModels(baseProvider as any) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) {
			return candidate as Model<Api>;
		}
	}
	return undefined;
}

interface ModelPickerItem {
	model: Model<Api>;
	searchText: string;
	providerLabel: string;
	email?: string;
	isCurrent: boolean;
	source: "built-in" | "multi-pass";
}

/** Replacement for pi's /model with per-subscription labels and email.
 * pi's built-in /model hardcodes `[providerId]` in the inline list and
 * cannot be overridden (it short-circuits before the extension event
 * system runs), so we provide /subs model as a labelled drop-in. */
async function handleSubsModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext | ExtensionCommandContext,
	initialQuery?: string,
): Promise<void> {
	const authStorage = getAuthStorage(ctx);
	const globalConfig = loadGlobalConfig();
	const subs = normalizeEntries(mergeConfigs(globalConfig, parseEnvConfig()));
	const providerNamesForEmails = Array.from(new Set([
		...SUPPORTED_PROVIDERS.filter((provider) => authStorage.hasAuth(provider)),
		...subs.map((entry) => subProviderName(entry)),
	]));
	await resolveAccountEmails(providerNamesForEmails, authStorage);

	const available = ordinaryChoices(ctx, ctx.modelRegistry.getAvailable(), ctx.model);
	const items: ModelPickerItem[] = available.map((model) => {
		const subEntry = subs.find((entry) => subProviderName(entry) === model.provider);
		const email = getStoredAccountEmail(model.provider, authStorage);
		const providerLabel = subEntry
			? subDisplayName(subEntry)
			: `${PROVIDER_TEMPLATES[model.provider]?.displayName || model.provider} (built-in)`;
		return {
			model: model as Model<Api>,
			providerLabel,
			email,
			isCurrent:
				ctx.model?.provider === model.provider && ctx.model?.id === model.id,
			source: subEntry ? "multi-pass" : "built-in",
			searchText: [
				model.provider,
				`${model.provider}/${model.id}`,
				model.id,
				model.name || "",
				providerLabel,
				email || "",
			].join(" ").toLowerCase(),
		};
	});
	items.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		if (a.source !== b.source) return a.source === "built-in" ? -1 : 1;
		const providerCmp = a.model.provider.localeCompare(b.model.provider);
		return providerCmp !== 0 ? providerCmp
			: minimaxChoiceRank(a.model) - minimaxChoiceRank(b.model) || a.model.id.localeCompare(b.model.id);
	});

	if (items.length === 0) {
		ctx.ui.notify("No authenticated models found. Use /subs login first.", "info");
		return;
	}

	if (!ctx.hasUI) {
		const rendered = items.map(
			(item) => `${item.model.id} -- ${item.providerLabel}${item.email ? ` [${item.email}]` : ""}`,
		);
		const selectedLine = await ctx.ui.select("Switch Model", rendered);
		if (!selectedLine) return;
		const index = rendered.indexOf(selectedLine);
		const selected = index >= 0 ? items[index]?.model : undefined;
		if (selected) await pi.setModel(selected);
		return;
	}

	const selectedModel = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
		const searchInput = new Input({ prompt: theme.fg("accent", "\u276f ") });
		if (initialQuery) searchInput.setValue(initialQuery);
		searchInput.focused = true;

		let filtered: ModelPickerItem[] = initialQuery
			? fuzzyFilter(items, initialQuery.toLowerCase(), (item) => item.searchText)
			: items.slice();
		let selectedIndex = Math.max(
			0,
			filtered.findIndex((item) => item.isCurrent),
		);
		let viewStart = 0;
		const maxVisible = 15;

		const applyQuery = () => {
			const query = searchInput.getValue().trim().toLowerCase();
			filtered = query
				? fuzzyFilter(items, query, (item) => item.searchText)
				: items.slice();
			selectedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, filtered.length - 1));
			viewStart = 0;
			tui.requestRender();
		};

		const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const footerHint = [
			keyHint("tui.select.confirm", "switch"),
			keyHint("tui.select.cancel", "close"),
		].join(" \u2022 ");

		return {
			render(width: number): string[] {
				if (selectedIndex < viewStart) viewStart = selectedIndex;
				if (selectedIndex >= viewStart + maxVisible) {
					viewStart = selectedIndex - maxVisible + 1;
				}

				const nameWidth = Math.min(
					32,
					Math.max(14, ...filtered.map((item) => visibleWidth(item.model.id))),
				);
				const padName = (text: string): string => {
					const truncated = truncateToWidth(text, nameWidth);
					return truncated + " ".repeat(Math.max(0, nameWidth - visibleWidth(truncated)));
				};

				const lines: string[] = [];
				const push = (line: string) => lines.push(truncateToWidth(line, width));
				lines.push(...topBorder.render(width));
				push(theme.fg("accent", theme.bold(" \u2726 multi-pass \u00b7 switch model")));
				push("");
				for (const inputLine of searchInput.render(Math.max(1, width - 2))) {
					push(` ${inputLine}`);
				}
				push("");

				if (filtered.length === 0) {
					push(theme.fg("muted", "   No matching models"));
				} else {
					const end = Math.min(filtered.length, viewStart + maxVisible);
					for (let i = viewStart; i < end; i++) {
						const item = filtered[i];
						const isSelected = i === selectedIndex;
						const cursor = isSelected ? theme.fg("accent", " \u2192 ") : "   ";
						const currentMarker = item.isCurrent
							? theme.fg("accent", "\u2713 ")
							: "  ";
						const name = isSelected
							? theme.fg("accent", theme.bold(padName(item.model.id)))
							: padName(item.model.id);
						const sourceTag = theme.fg(
							item.source === "built-in" ? "muted" : "dim",
							item.source === "built-in" ? "[built-in]" : "[multi-pass]",
						);
						const label = theme.fg("muted", item.providerLabel);
						const email = item.email ? theme.fg("dim", ` \u00b7 ${item.email}`) : "";
						push(`${cursor}${currentMarker}${name}  ${sourceTag} ${label}${email}`);
					}
					if (filtered.length > maxVisible) {
						push(theme.fg("dim", `   (${selectedIndex + 1}/${filtered.length})`));
					}
				}

				push("");
				push(theme.fg("dim", ` ${footerHint}`));
				lines.push(...bottomBorder.render(width));
				return lines;
			},
			invalidate() {
				topBorder.invalidate?.();
				bottomBorder.invalidate?.();
				searchInput.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					if (selectedIndex > 0) {
						selectedIndex--;
						tui.requestRender();
					}
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (selectedIndex < filtered.length - 1) {
						selectedIndex++;
						tui.requestRender();
					}
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
					done(filtered[selectedIndex]?.model ?? null);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				const before = searchInput.getValue();
				searchInput.handleInput(data);
				if (searchInput.getValue() !== before) applyQuery();
			},
		};
	});

	if (!selectedModel) return;
	if (ctx.model?.provider === selectedModel.provider && ctx.model?.id === selectedModel.id) {
		ctx.ui.notify(`Already using ${selectedModel.id} on ${selectedModel.provider}.`, "info");
		return;
	}
	const success = await pi.setModel(selectedModel);
	if (!success) {
		ctx.ui.notify(`Failed to switch to ${selectedModel.id}.`, "warning");
		return;
	}
	const subEntry = subs.find((entry) => subProviderName(entry) === selectedModel.provider);
	const providerLabel = subEntry
		? subDisplayName(subEntry)
		: PROVIDER_TEMPLATES[selectedModel.provider]?.displayName || selectedModel.provider;
	ctx.ui.notify(`Switched to ${selectedModel.id} (${providerLabel}).`, "info");
}

async function handleSubsSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedProviderName?: string,
): Promise<void> {
	const options = getSwitchableProviderOptions(ctx);
	if (options.length === 0) {
		const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(`No authenticated subscriptions are available to switch${suffix}.`, "info");
		return;
	}

	let providerName = requestedProviderName?.trim();
	if (!providerName) {
		providerName = await showWrappedSelect(ctx, {
			title: "Switch Subscription",
			subtitle: "Select the subscription/provider to use now.",
			items: options.map((option) => ({
				value: option.providerName,
				label: option.label,
				description: option.description,
			})),
			initialValue: ctx.model?.provider,
			confirmHint: "switch",
			cancelHint: "back",
		});
		if (!providerName) return;
	}

	const selected = options.find((option) => option.providerName === providerName);
	if (!selected) {
		ctx.ui.notify(`Subscription not available for switching: ${providerName}`, "error");
		return;
	}

	const nextModel = resolveSwitchTargetModel(ctx, selected.providerName, ctx.model?.id);
	if (!nextModel) {
		ctx.ui.notify(`No selectable models found for ${selected.label}.`, "error");
		return;
	}
	if (ctx.model?.provider === nextModel.provider && ctx.model?.id === nextModel.id) {
		ctx.ui.notify(`Already using ${selected.label} (${nextModel.id}).`, "info");
		return;
	}

	const success = await pi.setModel(nextModel);
	if (!success) {
		ctx.ui.notify(`Failed to switch to ${selected.label}.`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${selected.label} (${nextModel.id}).`, "info");
}

async function renameSubscriptionLabel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
): Promise<void> {
	const previousName = subDisplayName(entry);
	const nextLabel = await ctx.ui.input(
		"Friendly label (optional)",
		entry.label || "e.g. work, personal, team, outlook",
	);
	if (nextLabel === undefined) return;

	entry.label = nextLabel.trim() || undefined;
	saveGlobalConfig(config);

	const nextName = subDisplayName(entry);
	if (nextName === previousName) {
		ctx.ui.notify(`No changes for ${nextName}.`, "info");
		return;
	}

	registerSub(pi, entry);
	await ctx.modelRegistry.refresh();

	ctx.ui.notify(`Updated ${previousName} -> ${nextName}`, "info");
}

async function removeSubscriptionEntry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
	poolManager: PoolManager,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${subDisplayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	const name = subProviderName(entry);
	if (getAuthStorage(ctx).hasAuth(name)) {
		await getAuthStorage(ctx).logout(name);
	}
	providersRequiringReauthentication.delete(name);
	pi.unregisterProvider(name);

	for (const pool of config.pools) {
		pool.members = pool.members.filter((member) => member !== name);
	}
	const removedPoolNames = new Set(
		config.pools.filter((pool) => pool.members.length === 0).map((pool) => pool.name),
	);
	config.pools = config.pools.filter((pool) => pool.members.length > 0);
	if (removedPoolNames.size > 0) {
		const pruned = pruneRemovedPoolReferences(config.chains, removedPoolNames);
		config.chains = pruned.chains;
	}
	config.subscriptions = config.subscriptions.filter(
		(candidate) => !(candidate.provider === entry.provider && candidate.index === entry.index),
	);

	saveGlobalConfig(config);
	await ctx.modelRegistry.refresh();
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Removed ${subDisplayName(entry)}`, "info");
}

async function showSubscriptionActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	entry: SubEntry,
	poolManager: PoolManager,
): Promise<void> {
	const source = getSubscriptionSource(config, entry);
	if (source === "env") {
		await showWrappedSelect(ctx, {
			title: `Subscription: ${subDisplayName(entry)}`,
			subtitle: "This entry comes from MULTI_SUB and is read-only here.",
			items: [
				{
					value: subProviderName(entry),
					label: formatSubscriptionListLine(entry, config, getAuthStorage(ctx)),
				},
			],
			confirmHint: "back",
			cancelHint: "back",
		});
		return;
	}

	const name = subProviderName(entry);
	const authStorage = getAuthStorage(ctx);
	const hasAuth = authStorage.hasAuth(name);
	const auth = authStorage.get(name);
	const needsReauthentication = providersRequiringReauthentication.has(name);
	const actionItems: SelectItem[] = [
		{ value: "rename", label: "rename", description: "Change friendly label" },
		...(hasAuth && auth?.type === "oauth"
			? [{
				value: "reauthenticate",
				label: "re-authenticate",
				description: needsReauthentication
					? "Replace the rejected OAuth credential"
					: "Replace the saved OAuth credential",
			}]
			: []),
		hasAuth
			? { value: "logout", label: "logout", description: "Log out this subscription" }
			: { value: "login", label: "login", description: "Show login instructions" },
		{ value: "remove", label: "remove", description: "Remove this subscription" },
	];

	const action = await showWrappedSelect(ctx, {
		title: subDisplayName(entry),
		subtitle: "Escape returns to the subscriptions list.",
		items: actionItems,
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return;

	if (action === "rename") {
		return renameSubscriptionLabel(pi, ctx, config, entry);
	}
	if (action === "login") {
		ctx.ui.notify(
			`Use /login and select "${subscriptionLoginName(entry)}" to authenticate.`,
			"info",
		);
		return;
	}
	if (action === "reauthenticate") {
		const confirmed = await ctx.ui.confirm(
			`Re-authenticate ${subDisplayName(entry)}`,
			"The saved OAuth credential will be removed before starting a new login. Continue?",
		);
		if (!confirmed) return;
		await authStorage.logout(name);
		providersRequiringReauthentication.delete(name);
		ctx.ui.notify(
			`Credential cleared. Use /login and select "${subscriptionLoginName(entry)}" to authenticate again.`,
			"info",
		);
		return;
	}
	if (action === "logout") {
		await authStorage.logout(name);
		providersRequiringReauthentication.delete(name);
		ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
		return;
	}
	if (action === "remove") {
		return removeSubscriptionEntry(pi, ctx, config, entry, poolManager);
	}
}

/** Best-effort account email from a stored credential, without network
 * calls: JWT claims on the access/id token, a stored email field, or a
 * cached quota result from /subs limits or the status bar. */
function extractEmailFromJwt(token: string | undefined): string | undefined {
	if (!token || token.split(".").length < 3) return undefined;
	const payload = decodeJwtPayload(token);
	if (typeof payload.email === "string") return payload.email;
	const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
	if (profile && typeof profile.email === "string") return profile.email;
	return undefined;
}

const accountEmailCache = new Map<string, string>();

function getStoredAccountEmail(
	providerName: string,
	authStorage: AuthStorageCompat,
): string | undefined {
	const cached = accountEmailCache.get(providerName);
	if (cached) return cached;
	const auth = authStorage.get(providerName);
	if (!auth) return undefined;
	if (typeof auth.email === "string" && auth.email) return auth.email;
	const idToken = typeof auth.idToken === "string"
		? auth.idToken
		: typeof auth.id_token === "string"
			? auth.id_token
			: undefined;
	return (
		extractEmailFromJwt(typeof auth.access === "string" ? auth.access : undefined) ??
		extractEmailFromJwt(idToken) ??
		statusBarQuota.get(providerName)?.email
	);
}

/** Fill accountEmailCache for providers whose stored credential does not
 * carry an email (currently Anthropic, whose OAuth token is opaque). One
 * profile request per provider, cached for the process lifetime. Failures
 * are negatively cached for a few minutes so a broken/slow profile endpoint
 * cannot stall (or be re-hit on) every dashboard redraw. */
const anthropicProfileRetryAt = new Map<string, number>();
const ANTHROPIC_PROFILE_RETRY_MS = 5 * 60_000;
async function resolveAccountEmails(
	providerNames: string[],
	authStorage: AuthStorageCompat,
): Promise<void> {
	await Promise.all(providerNames.map(async (providerName) => {
		if (getStoredAccountEmail(providerName, authStorage)) return;
		const base = getBaseProvider(providerName) || providerName;
		if (base !== "anthropic") return;
		const auth = authStorage.get(providerName);
		if (typeof auth?.access !== "string" || !auth.access) return;
		const retryAt = anthropicProfileRetryAt.get(providerName) ?? 0;
		if (Date.now() < retryAt) return;
		try {
			const profile = await fetchAnthropicProfile(new Headers({
				Authorization: `Bearer ${auth.access}`,
				"anthropic-beta": ANTHROPIC_OAUTH_BETA,
				Accept: "application/json",
			}), AbortSignal.timeout(5_000));
			if (profile.email) accountEmailCache.set(providerName, profile.email);
			else anthropicProfileRetryAt.set(providerName, Date.now() + ANTHROPIC_PROFILE_RETRY_MS);
		} catch {
			// best effort; the list simply shows no email
			anthropicProfileRetryAt.set(providerName, Date.now() + ANTHROPIC_PROFILE_RETRY_MS);
		}
	}));
}

interface SubsDashboardItem {
	value: string;
	glyph: string;
	name: string;
	statusColor: "success" | "warning" | "dim";
	statusGlyph: string;
	detail: string;
	meta?: string;
	active?: boolean;
}

interface SubsDashboardSection {
	heading: string;
	items: SubsDashboardItem[];
}

/** Sectioned account picker with non-selectable headings. SelectList does
 * not support decoration rows, so this renders its own list: section
 * headings, aligned columns, status dots, and an active-provider marker. */
async function showSubsDashboard(
	ctx: ExtensionCommandContext,
	sections: SubsDashboardSection[],
	initialValue?: string,
): Promise<string | undefined> {
	const visibleSections = sections.filter((section) => section.items.length > 0);
	const flat = visibleSections.flatMap((section) => section.items);
	if (flat.length === 0) return undefined;

	if (!ctx.hasUI) {
		const rendered = flat.map((item) =>
			[item.name, item.detail, item.meta].filter(Boolean).join(" -- "),
		);
		const selected = await ctx.ui.select("Subscriptions", rendered);
		if (!selected) return undefined;
		const index = rendered.indexOf(selected);
		return index >= 0 ? flat[index]?.value : undefined;
	}

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let selectedIndex = Math.max(
			0,
			flat.findIndex((item) => item.value === initialValue),
		);
		const nameWidth = Math.min(
			38,
			Math.max(...flat.map((item) => visibleWidth(item.name))),
		);
		const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
		const footer = [
			keyHint("tui.select.confirm", "open"),
			keyHint("tui.select.cancel", "close"),
		].join(" \u2022 ");

		const padName = (name: string): string => {
			const truncated = truncateToWidth(name, nameWidth);
			return truncated + " ".repeat(Math.max(0, nameWidth - visibleWidth(truncated)));
		};

		return {
			render(width: number): string[] {
				const lines: string[] = [];
				const push = (line: string) => lines.push(truncateToWidth(line, width));
				lines.push(...topBorder.render(width));
				push(theme.fg("accent", theme.bold(" \u2726 multi-pass \u00b7 subscriptions")));
				for (const section of visibleSections) {
					push("");
					push(theme.fg("muted", theme.bold(` ${section.heading.toUpperCase()}`)));
					for (const item of section.items) {
						const index = flat.indexOf(item);
						const isSelected = index === selectedIndex;
						const prefix = isSelected ? theme.fg("accent", " \u2192 ") : "   ";
						const glyph = theme.fg(item.statusColor, item.glyph);
						const name = isSelected
							? theme.fg("accent", theme.bold(padName(item.name)))
							: padName(item.name);
						const status = theme.fg(item.statusColor, item.statusGlyph);
						const detail = theme.fg("muted", item.detail);
						const meta = item.meta ? theme.fg("dim", `  \u00b7 ${item.meta}`) : "";
						const active = item.active ? theme.fg("accent", "  \u2726 active") : "";
						push(`${prefix}${glyph} ${name}  ${status} ${detail}${meta}${active}`);
					}
				}
				push("");
				push(theme.fg("dim", ` ${footer}`));
				lines.push(...bottomBorder.render(width));
				return lines;
			},
			invalidate() {
				topBorder.invalidate?.();
				bottomBorder.invalidate?.();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) {
					selectedIndex = (selectedIndex - 1 + flat.length) % flat.length;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.down)) {
					selectedIndex = (selectedIndex + 1) % flat.length;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
					done(flat[selectedIndex]?.value ?? null);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done(null);
				}
			},
		};
	});
	return result ?? undefined;
}

async function showBuiltinProviderInfo(
	ctx: ExtensionCommandContext,
	provider: string,
): Promise<void> {
	const email = getStoredAccountEmail(provider, getAuthStorage(ctx));
	const lines = [
		`provider: ${provider}`,
		email ? `email: ${email}` : "email: unknown (run /subs limits to fetch)",
		"source: built-in pi provider",
		"manage: /login and /logout handle this credential",
	];
	await showWrappedSelect(ctx, {
		title: `${PROVIDER_TEMPLATES[provider]?.displayName || provider} (built-in)`,
		subtitle: "Built-in provider credential. Press Escape to go back.",
		items: lines.map((line, index) => ({ value: String(index), label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

async function handleSubsList(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiPassConfig,
	poolManager: PoolManager,
): Promise<void> {
	let preferredProviderName: string | undefined = ctx.model?.provider;

	while (true) {
		const envEntries = parseEnvConfig();
		const all = normalizeEntries(mergeConfigs(config, envEntries));
		const authStorage = getAuthStorage(ctx);

		const builtinProviderNames = SUPPORTED_PROVIDERS.filter((provider) =>
			authStorage.hasAuth(provider),
		);
		await resolveAccountEmails(
			[...builtinProviderNames, ...all.map((entry) => subProviderName(entry))],
			authStorage,
		);

		const builtinItems: SubsDashboardItem[] = builtinProviderNames.map((provider) => {
			const email = getStoredAccountEmail(provider, authStorage);
			return {
				value: `builtin:${provider}`,
				glyph: STATUS_BAR_GLYPHS[provider] || "\u25cf",
				name: PROVIDER_TEMPLATES[provider]?.displayName || provider,
				statusColor: "success" as const,
				statusGlyph: "\u25cf",
				detail: email || "logged in",
				active: ctx.model?.provider === provider,
			};
		});

		if (all.length === 0 && builtinItems.length === 0) {
			ctx.ui.notify("No extra subscriptions configured. Use /subs add to create one.", "info");
			return;
		}

		const subItems: SubsDashboardItem[] = all.map((entry) => {
			const name = subProviderName(entry);
			const email = getStoredAccountEmail(name, authStorage);
			const needsReauth = providersRequiringReauthentication.has(name);
			const loggedIn = authStorage.hasAuth(name);
			return {
				value: name,
				glyph: STATUS_BAR_GLYPHS[entry.provider] || "\u25cf",
				name: subDisplayName(entry),
				statusColor: needsReauth ? "warning" as const : loggedIn ? "success" as const : "dim" as const,
				statusGlyph: needsReauth ? "\u27f3" : loggedIn ? "\u25cf" : "\u25cb",
				detail: needsReauth
					? "reauth required"
					: loggedIn
						? email || "logged in"
						: "not logged in",
				meta: getSubscriptionSource(config, entry),
				active: ctx.model?.provider === name,
			};
		});

		const selectedProviderName = await showSubsDashboard(
			ctx,
			[
				{ heading: "built-in", items: builtinItems },
				{ heading: "multi-pass", items: subItems },
			],
			preferredProviderName,
		);
		if (!selectedProviderName) return;

		preferredProviderName = selectedProviderName;
		if (selectedProviderName.startsWith("builtin:")) {
			await showBuiltinProviderInfo(ctx, selectedProviderName.slice("builtin:".length));
			continue;
		}
		const entry = all.find((candidate) => subProviderName(candidate) === selectedProviderName);
		if (!entry) continue;
		await showSubscriptionActions(pi, ctx, config, entry, poolManager);
	}
}

async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const providerItems: SelectItem[] = SUPPORTED_PROVIDERS.map((provider) => ({
		value: provider,
		label: provider,
		description: PROVIDER_TEMPLATES[provider]?.displayName,
	}));

	const provider = await showWrappedSelect(ctx, {
		title: "Select provider to add",
		items: providerItems,
		confirmHint: "select",
		cancelHint: "close",
	});
	if (!provider) return;

	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allEntries = normalizeEntries(mergeConfigs(config, envEntries));
	const usedIndices = new Set(
		allEntries.filter((e) => e.provider === provider).map((e) => e.index),
	);
	let nextIndex = 2;
	while (usedIndices.has(nextIndex)) nextIndex++;

	const entry: SubEntry = {
		provider,
		index: nextIndex,
		label: label?.trim() || undefined,
	};

	config.subscriptions.push(entry);
	saveGlobalConfig(config);

	registerSub(pi, entry);
	await ctx.modelRegistry.refresh();

	const loginNow = await ctx.ui.confirm(
		subDisplayName(entry),
		`Created ${subDisplayName(entry)}.\n\nLogin now?`,
	);

	if (loginNow) {
		ctx.ui.notify(
			`Use /login and select "${subscriptionLoginName(entry)}" to authenticate.`,
			"info",
		);
	} else {
		ctx.ui.notify(`Added ${subDisplayName(entry)}. Use /subs login to authenticate.`, "info");
	}
}

async function handleSubsRemove(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Remove subscription",
		subtitle: "Select a saved subscription to remove.",
		initialValue: ctx.model?.provider,
		items: config.subscriptions.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: getAuthStorage(ctx).hasAuth(subProviderName(entry))
				? "logged in"
				: "not logged in",
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = config.subscriptions.find(
		(candidate) => subProviderName(candidate) === selectedProviderName,
	);
	if (!entry) return;

	return removeSubscriptionEntry(pi, ctx, config, entry, poolManager);
}

async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));
	const authStorage = getAuthStorage(ctx);
	const loginCandidates = all.filter((entry) => {
		const name = subProviderName(entry);
		return !authStorage.hasAuth(name) || authStorage.get(name)?.type === "oauth";
	});

	if (loginCandidates.length === 0) {
		ctx.ui.notify(
			all.length === 0
				? "No subscriptions configured. Use /subs add first."
				: "All subscriptions use API keys and are already configured.",
			"info",
		);
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Login to subscription",
		subtitle: "Logged-in OAuth subscriptions can be re-authenticated.",
		initialValue: ctx.model?.provider,
		items: loginCandidates.map((entry) => {
			const name = subProviderName(entry);
			const hasAuth = authStorage.hasAuth(name);
			return {
				value: name,
				label: subDisplayName(entry),
				description: providersRequiringReauthentication.has(name)
					? "reauthentication required"
					: hasAuth
						? "logged in; re-authenticate"
						: "not logged in",
			};
		}),
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = loginCandidates.find(
		(candidate) => subProviderName(candidate) === selectedProviderName,
	);
	if (!entry) return;

	if (authStorage.hasAuth(selectedProviderName)) {
		const confirmed = await ctx.ui.confirm(
			`Re-authenticate ${subDisplayName(entry)}`,
			"The saved OAuth credential will be removed before starting a new login. Continue?",
		);
		if (!confirmed) return;
		await authStorage.logout(selectedProviderName);
		providersRequiringReauthentication.delete(selectedProviderName);
	}

	ctx.ui.notify(
		`Use /login and select "${subscriptionLoginName(entry)}" to authenticate.`,
		"info",
	);
}

async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const loggedIn = all.filter((entry) =>
		getAuthStorage(ctx).hasAuth(subProviderName(entry)),
	);

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Logout from subscription",
		subtitle: "Select a subscription to log out.",
		initialValue: ctx.model?.provider,
		items: loggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: "logged in",
		})),
		confirmHint: "logout",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = loggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	await getAuthStorage(ctx).logout(subProviderName(entry));
	providersRequiringReauthentication.delete(subProviderName(entry));
	ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
}

async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const entry of all) {
		const name = subProviderName(entry);
		const cred = getAuthStorage(ctx).get(name);
		const hasAuth = getAuthStorage(ctx).hasAuth(name);

		let status: string;
		if (providersRequiringReauthentication.has(name)) {
			status = "reauthentication required (use /subs login)";
		} else if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = typeof cred.expires === "number" ? cred.expires - Date.now() : 0;
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (expires ${mins}m)`;
			} else {
				status = "logged in (token expired, will refresh)";
			}
		} else {
			status = "logged in (api key)";
		}

		const modelCount = (getModels(entry.provider as any) as Model<Api>[]).length;
		const source = config.subscriptions.find(
			(s) => s.provider === entry.provider && s.index === entry.index,
		)
			? "saved"
			: "env";

		// Check if in any pool
		const inPools = config.pools
			.filter((p) => p.members.includes(name))
			.map((p) => p.name);
		const poolInfo = inPools.length > 0 ? ` | pools: ${inPools.join(", ")}` : "";

		lines.push(
			`${subDisplayName(entry)} | ${status} | ${modelCount} models | ${source}${poolInfo}`,
		);
	}

	await showWrappedSelect(ctx, {
		title: "Subscription Status",
		subtitle: "Press Enter or Escape to go back.",
		items: lines.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

// ==========================================================================
// /pool command handlers
// ==========================================================================

/** Get all provider names that belong to a base provider type (including the original) */
function getAllProvidersForBase(
	baseProvider: string,
	allSubs: SubEntry[],
): string[] {
	const providers = [baseProvider]; // original
	for (const entry of allSubs) {
		if (entry.provider === baseProvider) {
			providers.push(subProviderName(entry));
		}
	}
	return providers;
}

function createPoolValidationMessage(members: string[]): string | null {
	if (members.length < 1) {
		return "Pool needs at least 1 member.";
	}
	return null;
}

/** Parse a human-friendly schedule window like "9-17 mon-fri" or "22-6". */
function parseScheduleWindowInput(raw: string): ScheduleWindow | null {
	const window: ScheduleWindow = {};
	const parts = raw.trim().split(/\s+/);

	for (const part of parts) {
		// Hour range: "9-17" or "22-6"
		const hourMatch = part.match(/^(\d{1,2})-(\d{1,2})$/);
		if (hourMatch) {
			const start = parseInt(hourMatch[1], 10);
			const end = parseInt(hourMatch[2], 10);
			// start === end is rejected: isInHourRange treats [h, h] as
			// hour >= h && hour < h — never active — so accepting it would
			// silently configure a preferred member that can never serve.
			if (start >= 0 && start <= 23 && end >= 0 && end <= 23 && start !== end) {
				window.hours = [start, end];
				continue;
			}
			return null;
		}
		// Day range: "mon-fri" or single day: "mon"
		const dayRangeMatch = part.match(/^([a-z]{3})-([a-z]{3})$/);
		if (dayRangeMatch) {
			const startDay = dayRangeMatch[1] as DayOfWeek;
			const endDay = dayRangeMatch[2] as DayOfWeek;
			const startIdx = ALL_DAYS.indexOf(startDay);
			const endIdx = ALL_DAYS.indexOf(endDay);
			if (startIdx >= 0 && endIdx >= 0) {
				const days: DayOfWeek[] = [];
				for (let i = startIdx; i !== (endIdx + 1) % 7; i = (i + 1) % 7) {
					days.push(ALL_DAYS[i]);
				}
				days.push(ALL_DAYS[endIdx]);
				window.days = [...new Set(days)];
				continue;
			}
		}
		// Single day
		if (ALL_DAYS.includes(part as DayOfWeek)) {
			window.days = window.days || [];
			if (!window.days.includes(part as DayOfWeek)) {
				window.days.push(part as DayOfWeek);
			}
			continue;
		}
		// Date range: "2025-01-01..2025-01-31"
		const dateMatch = part.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
		if (dateMatch) {
			window.dateRange = { from: dateMatch[1], to: dateMatch[2] };
			continue;
		}
		// A partially recognized window would silently discard a constraint.
		return null;
	}

	if (!window.hours && !window.days && !window.dateRange) return null;
	return window;
}

async function promptForScheduleWindows(
	ctx: ExtensionCommandContext,
	member: string,
): Promise<ScheduleWindow[] | undefined> {
	while (true) {
		const input = await ctx.ui.input(
			`Time window for ${member}`,
			"hours e.g. 9-17, days e.g. mon-fri (or leave empty for always)",
		);
		if (input === undefined) return undefined;
		if (!input.trim()) return [];
		const window = parseScheduleWindowInput(input.trim());
		if (window) return [window];
		ctx.ui.notify(`Invalid time window "${input.trim()}". Try e.g. "9-17 mon-fri".`, "warning");
	}
}

function buildPoolConfig(input: {
	name: string;
	baseProvider: string;
	members: string[];
	enabled?: boolean;
	strategy?: PoolStrategy;
	memberSchedule?: Record<string, MemberSchedule>;
	selectorScript?: string;
}): { ok: true; pool: PoolConfig } | { ok: false; error: string } {
	const name = input.name.trim();
	if (!name) {
		return { ok: false, error: "Pool name is required." };
	}
	const validation = createPoolValidationMessage(input.members);
	if (validation) {
		return { ok: false, error: validation };
	}
	const pool: PoolConfig = {
		name,
		baseProvider: input.baseProvider,
		members: [...input.members],
		enabled: input.enabled ?? true,
	};
	if (input.strategy && input.strategy !== "round-robin") {
		pool.strategy = input.strategy;
	}
	if (input.memberSchedule && Object.keys(input.memberSchedule).length > 0) {
		pool.memberSchedule = input.memberSchedule;
	}
	if (input.selectorScript) {
		pool.selectorScript = input.selectorScript;
	}
	return { ok: true, pool };
}

function persistPoolConfig(
	config: MultiPassConfig,
	pool: PoolConfig,
): { action: "created" | "updated"; config: MultiPassConfig } {
	const existingIdx = config.pools.findIndex((candidate) => candidate.name === pool.name);
	if (existingIdx >= 0) {
		config.pools[existingIdx] = pool;
		return { action: "updated", config };
	}
	config.pools.push(pool);
	return { action: "created", config };
}

function reloadPoolManagerForCurrentProject(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): void {
	poolManager.loadPools(loadEffectiveConfig(ctx.cwd).pools);
}

function renamePoolReferences(
	chains: ChainConfig[],
	previousName: string,
	nextName: string,
): number {
	let updatedEntries = 0;
	for (const chain of chains) {
		for (const entry of chain.entries) {
			if (entry.pool !== previousName) continue;
			entry.pool = nextName;
			updatedEntries += 1;
		}
	}
	return updatedEntries;
}

function pruneRemovedPoolReferences(
	chains: ChainConfig[],
	removedPoolNames: Set<string>,
): { chains: ChainConfig[]; removedEntries: number; removedChains: number } {
	let removedEntries = 0;
	let removedChains = 0;

	for (const chain of chains) {
		const beforeCount = chain.entries.length;
		chain.entries = chain.entries.filter((entry) => !removedPoolNames.has(entry.pool));
		removedEntries += beforeCount - chain.entries.length;
	}

	const remainingChains = chains.filter((chain) => {
		if (chain.entries.length > 0) return true;
		removedChains += 1;
		return false;
	});

	return { chains: remainingChains, removedEntries, removedChains };
}

async function renamePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const previousName = pool.name;
	const nextName = await ctx.ui.input("Pool name", pool.name);
	if (nextName === undefined) return;

	const trimmedName = nextName.trim();
	if (!trimmedName) {
		ctx.ui.notify("Pool name is required.", "warning");
		return;
	}
	if (trimmedName === previousName) {
		ctx.ui.notify(`No changes for pool "${previousName}".`, "info");
		return;
	}
	if (config.pools.some((candidate) => candidate.name === trimmedName)) {
		ctx.ui.notify(`Pool "${trimmedName}" already exists.`, "warning");
		return;
	}

	pool.name = trimmedName;
	const updatedEntries = renamePoolReferences(config.chains, previousName, trimmedName);
	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(
		updatedEntries > 0
			? `Renamed pool "${previousName}" -> "${trimmedName}" and updated ${updatedEntries} chain entr${updatedEntries === 1 ? "y" : "ies"}.`
			: `Renamed pool "${previousName}" -> "${trimmedName}".`,
		"info",
	);
}

async function editPoolMembers(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const availableProviders = getAllProvidersForBase(pool.baseProvider, allSubs);
	const selectedMembers = [...pool.members];

	while (true) {
		const removableItems: SelectItem[] = selectedMembers.map((member) => ({
			value: `remove:${member}`,
			label: `remove ${member}`,
			description: getAuthStorage(ctx).hasAuth(member) ? "logged in" : "not logged in",
		}));
		const addableItems: SelectItem[] = availableProviders
			.filter((providerName) => !selectedMembers.includes(providerName))
			.map((providerName) => ({
				value: `add:${providerName}`,
				label: `add ${providerName}`,
				description: getAuthStorage(ctx).hasAuth(providerName)
					? "logged in"
					: "not logged in",
			}));

		const action = await showWrappedSelect(ctx, {
			title: `Pool Members: ${pool.name}`,
			subtitle: [
				`Base provider: ${pool.baseProvider}`,
				`Selected (${selectedMembers.length}): ${selectedMembers.join(", ") || "none"}`,
				"Choose add/remove entries, then save when done.",
			].join("\n"),
			items: [
				{
					value: "save",
					label: "save",
					description: "Persist member changes",
				},
				...removableItems,
				...addableItems,
			],
			confirmHint: "select",
			cancelHint: "back",
		});
		if (!action) return;

		if (action === "save") {
			const validation = createPoolValidationMessage(selectedMembers);
			if (validation) {
				ctx.ui.notify(validation, "warning");
				continue;
			}
			const changed = pool.members.length !== selectedMembers.length
				|| pool.members.some((member, index) => member !== selectedMembers[index]);
			if (!changed) {
				ctx.ui.notify(`No changes for pool "${pool.name}".`, "info");
				return;
			}
			pool.members = [...selectedMembers];
			saveGlobalConfig(config);
			reloadPoolManagerForCurrentProject(ctx, poolManager);
			ctx.ui.notify(
				`Updated pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.`,
				"info",
			);
			return;
		}

		if (action.startsWith("remove:")) {
			const member = action.slice("remove:".length);
			const index = selectedMembers.indexOf(member);
			if (index >= 0) selectedMembers.splice(index, 1);
			continue;
		}

		if (action.startsWith("add:")) {
			const member = action.slice("add:".length);
			if (!selectedMembers.includes(member)) {
				selectedMembers.push(member);
			}
		}
	}
}

async function promptForPoolDefinition(
	ctx: ExtensionCommandContext,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const providerLabels = SUPPORTED_PROVIDERS.map((p) => {
		const t = PROVIDER_TEMPLATES[p];
		return `${p} -- ${t.displayName}`;
	});

	const selectedProvider = await ctx.ui.select("Pool base provider", providerLabels);
	if (!selectedProvider) return undefined;
	const baseProvider = selectedProvider.split(" -- ")[0];

	const poolName = await ctx.ui.input("Pool name", `e.g. ${baseProvider}-pool`);
	if (!poolName?.trim()) return undefined;

	const allProviders = getAllProvidersForBase(baseProvider, allSubs);
	const authedProviders = allProviders.filter((p) =>
		getAuthStorage(ctx).hasAuth(p),
	);

	if (authedProviders.length === 0) {
		ctx.ui.notify(
			`No authenticated ${baseProvider} subscriptions found. Login first with /subs login.`,
			"warning",
		);
		return undefined;
	}

	const members: string[] = [];
	let selecting = true;
	while (selecting) {
		const remaining = allProviders.filter((p) => !members.includes(p));
		if (remaining.length === 0) break;

		const optionsList = [
			`--- Selected (${members.length}): ${members.join(", ") || "none"} ---`,
			...remaining.map((p) => {
				const authed = getAuthStorage(ctx).hasAuth(p);
				return `${p} ${authed ? "[logged in]" : "[not logged in]"}`;
			}),
			"[Done - create pool]",
		];

		const picked = await ctx.ui.select("Add members ([Done] saves, Esc cancels)", optionsList);
		if (!picked) {
			ctx.ui.notify(`Cancelled pool creation${poolName ? ` for "${poolName}"` : ""}.`, "info");
			return undefined;
		}
		if (picked.startsWith("---")) {
			continue;
		}
		if (picked === "[Done - create pool]") {
			if (members.length === 0) {
				ctx.ui.notify("Select at least one member.", "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		const provName = picked.split(" ")[0];
		if (provName && allProviders.includes(provName)) {
			members.push(provName);
		}
	}

	// Ask for selection strategy
	const strategyItems = [
		"round-robin -- Rotate members sequentially on rate limits (default)",
		"per-turn -- Rotate before each new prompt; keep retries on their account",
		"weighted -- Balance finalized request counts by per-account weight",
		"quota-first -- Prefer the member with the most remaining quota",
		"scheduled -- Use per-member time windows and priority roles",
		"custom -- Delegate to a JS selector script",
	];
	const strategyPick = await ctx.ui.select("Selection strategy", strategyItems);
	let strategy: PoolStrategy = "round-robin";
	if (strategyPick?.startsWith("per-turn")) strategy = "per-turn";
	else if (strategyPick?.startsWith("weighted")) strategy = "weighted";
	else if (strategyPick?.startsWith("quota-first")) strategy = "quota-first";
	else if (strategyPick?.startsWith("scheduled")) strategy = "scheduled";
	else if (strategyPick?.startsWith("custom")) strategy = "custom";

	// Collect strategy-specific config
	let memberSchedule: Record<string, MemberSchedule> | undefined;
	let selectorScript: string | undefined;

	if (strategy === "scheduled" && members.length > 0) {
		memberSchedule = {};
		for (const member of members) {
			const roleItems = [
				"default -- Always available (no schedule needed)",
				"preferred -- Only during time windows (burn quota when window active)",
				"overflow -- Last resort (used when preferred/default exhausted)",
			];
			const rolePick = await ctx.ui.select(`Role for ${member}`, roleItems);
			if (!rolePick) continue;

			let role: "preferred" | "overflow" | undefined;
			if (rolePick.startsWith("preferred")) role = "preferred";
			else if (rolePick.startsWith("overflow")) role = "overflow";

			if (role === "preferred") {
				const windows = await promptForScheduleWindows(ctx, member);
				if (!windows) return undefined;
				memberSchedule[member] = { role, windows };
			} else if (role === "overflow") {
				memberSchedule[member] = { role };
			}
			// "default" role = no entry needed
		}
		if (Object.keys(memberSchedule).length === 0) memberSchedule = undefined;
	}

	if (strategy === "custom") {
		const scriptPath = await ctx.ui.input(
			"Selector script path",
			`e.g. selectors/my-pool.js (relative to ${getAgentDir()}/)`,
		);
		if (scriptPath?.trim()) {
			selectorScript = scriptPath.trim();
			const resolved = resolveSelectorScriptPath(selectorScript);
			if (!existsSync(resolved)) {
				ctx.ui.notify(
					`Warning: script not found at ${resolved}. You can create it later.`,
					"warning",
				);
			}
		} else {
			ctx.ui.notify("No selector script provided. Pool will fall back to round-robin.", "warning");
			strategy = "round-robin";
		}
	}

	const built = buildPoolConfig({
		name: poolName,
		baseProvider,
		members,
		enabled: true,
		strategy,
		memberSchedule,
		selectorScript,
	});
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return undefined;
	}

	const existing = config.pools.find((pool) => pool.name === built.pool.name);
	if (existing && !options?.allowOverwrite) {
		ctx.ui.notify(`Pool "${built.pool.name}" already exists.`, "warning");
		return undefined;
	}
	if (existing && options?.allowOverwrite) {
		const overwrite = await ctx.ui.confirm(
			"Pool exists",
			`Pool "${built.pool.name}" already exists. Overwrite?`,
		);
		if (!overwrite) return undefined;
	}

	if (options?.resumeChainName) {
		ctx.ui.notify(
			`Prepared pool "${built.pool.name}" for chain "${options.resumeChainName}".`,
			"info",
		);
	}

	return built.pool;
}

async function createAndPersistPool(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	options?: {
		allowOverwrite?: boolean;
		resumeChainName?: string;
	},
): Promise<PoolConfig | undefined> {
	const pool = await promptForPoolDefinition(ctx, options);
	if (!pool) return undefined;

	const config = loadGlobalConfig();
	const persisted = persistPoolConfig(config, pool);
	saveGlobalConfig(persisted.config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);

	const resumeSuffix = options?.resumeChainName
		? ` Chain builder resumed for "${options.resumeChainName}".`
		: "";
	ctx.ui.notify(
		`${persisted.action === "created" ? "Created" : "Updated"} pool "${pool.name}" with ${pool.members.length} member${pool.members.length === 1 ? "" : "s"}: ${pool.members.join(", ")}.${resumeSuffix}`,
		"info",
	);
	return pool;
}

function getModelsForPool(pool: PoolConfig, ctx?: ExtensionContext | ExtensionCommandContext): string[] {
	if (!minimaxBase(pool.baseProvider)) {
		return (getModels(pool.baseProvider as any) as Model<Api>[]).map((model) => model.id);
	}
	const models = subscriptionCatalog(pool.baseProvider).map(({ model }) => model.id);
	if (ctx) {
		models.push(...ctx.modelRegistry.getAll()
			.filter((model) => model.provider === pool.baseProvider || pool.members.includes(model.provider))
			.map((model) => model.id));
	}
	return [...new Set(models)];
}

function getSelectableModelsForPool(pool: PoolConfig, ctx: ExtensionCommandContext): string[] {
	if (!minimaxBase(pool.baseProvider)) return getModelsForPool(pool);
	const models = ctx.modelRegistry.getAll()
		.filter((model) => model.provider === pool.baseProvider || pool.members.includes(model.provider));
	return [...new Set(ordinaryChoices(ctx, models).map((model) => model.id))]
		.sort((a, b) => minimaxChoiceRank({ provider: pool.baseProvider, id: a })
			- minimaxChoiceRank({ provider: pool.baseProvider, id: b }));
}

function createChainValidationError(
	config: MultiPassConfig,
	chain: ChainConfig,
	ctx?: ExtensionCommandContext,
): string | null {
	if (!chain.name.trim()) {
		return "Chain name is required.";
	}
	if (findChainByName(config.chains, chain.name)) {
		return `Chain "${chain.name}" already exists.`;
	}
	if (chain.entries.length === 0) {
		return `Chain "${chain.name}" needs at least 1 entry.`;
	}

	for (const entry of chain.entries) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (!pool) {
			return `Chain entry pool "${entry.pool}" does not exist.`;
		}
		const selectableModels = getModelsForPool(pool, ctx);
		if (selectableModels.length === 0) {
			return `Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`;
		}
		if (!selectableModels.includes(entry.model)) {
			return `Model "${entry.model}" is not available for pool "${pool.name}".`;
		}
	}

	return null;
}

function buildChainConfig(
	config: MultiPassConfig,
	input: { name: string; entries: ChainEntryConfig[]; enabled?: boolean },
	ctx?: ExtensionCommandContext,
): { ok: true; chain: ChainConfig } | { ok: false; error: string } {
	const chain: ChainConfig = {
		name: input.name.trim(),
		entries: input.entries.map((entry) => ({ ...entry })),
		enabled: input.enabled ?? true,
	};
	const validationError = createChainValidationError(config, chain, ctx);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	return { ok: true, chain };
}

async function handlePoolCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	await createAndPersistPool(ctx, poolManager, { allowOverwrite: true });
}

async function inspectPoolConfig(
	ctx: ExtensionCommandContext,
	pool: PoolConfig,
	poolManager: PoolManager,
): Promise<void> {
	await showWrappedSelect(ctx, {
		title: `Pool Status: ${pool.name}`,
		subtitle: "Press Enter or Escape to go back to the pools list.",
		items: formatPoolStatusLines(pool, getAuthStorage(ctx), poolManager)
			.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}

async function togglePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	pool.enabled = !pool.enabled;
	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Pool "${pool.name}" is now ${pool.enabled ? "enabled" : "disabled"}`, "info");
}

async function changePoolStrategy(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<void> {
	const current = pool.strategy || "round-robin";
	const items: SelectItem[] = [
		{
			value: "round-robin",
			label: "round-robin",
			description: "Rotate members sequentially on rate limits (default)",
		},
		{
			value: "per-turn",
			label: "per-turn",
			description: "Rotate before each new prompt; keep retries on their account",
		},
		{
			value: "quota-first",
			label: "quota-first",
			description: "Prefer the member with the most remaining quota",
		},
		{
			value: "weighted",
			label: "weighted",
			description: "Balance request counts by member weights; configure with /pool weights",
		},
		{
			value: "scheduled",
			label: "scheduled",
			description: "Use per-member time windows and priority roles",
		},
		{
			value: "custom",
			label: "custom",
			description: "Delegate to a JS selector script",
		},
	];

	const selected = await showWrappedSelect(ctx, {
		title: `Strategy: ${pool.name}`,
		subtitle: `Currently: ${current}`,
		items,
		initialValue: current,
		confirmHint: "select",
		cancelHint: "back",
	});
	if (!selected) return;

	const nextStrategy = selected as PoolStrategy;
	if (nextStrategy === current) {
		ctx.ui.notify(`Strategy unchanged (${current}).`, "info");
		return;
	}

	// Collect strategy-specific config
	if (nextStrategy === "scheduled") {
		const memberSchedule: Record<string, MemberSchedule> = {};
		for (const member of pool.members) {
			const roleItems = [
				"default -- Always available (no schedule needed)",
				"preferred -- Only during time windows",
				"overflow -- Last resort",
			];
			const rolePick = await ctx.ui.select(`Role for ${member}`, roleItems);
			if (!rolePick) continue;

			let role: "preferred" | "overflow" | undefined;
			if (rolePick.startsWith("preferred")) role = "preferred";
			else if (rolePick.startsWith("overflow")) role = "overflow";

			if (role === "preferred") {
				const windows = await promptForScheduleWindows(ctx, member);
				if (!windows) return;
				memberSchedule[member] = { role, windows };
			} else if (role === "overflow") {
				memberSchedule[member] = { role };
			}
		}
		pool.memberSchedule = Object.keys(memberSchedule).length > 0 ? memberSchedule : undefined;
		delete pool.selectorScript;
	} else if (nextStrategy === "custom") {
		const scriptPath = await ctx.ui.input(
			"Selector script path",
			`e.g. selectors/my-pool.js (relative to ${getAgentDir()}/)`,
		);
		if (!scriptPath?.trim()) {
			ctx.ui.notify("No script path provided. Strategy unchanged.", "warning");
			return;
		}
		pool.selectorScript = scriptPath.trim();
		forgetSelectorScript(pool.selectorScript);
		delete pool.memberSchedule;
	} else if (nextStrategy === "quota-first" || nextStrategy === "weighted") {
		delete pool.memberSchedule;
		delete pool.selectorScript;
	}
	if (nextStrategy === "round-robin") {
		delete pool.strategy;
		delete pool.memberSchedule;
		delete pool.selectorScript;
	} else {
		pool.strategy = nextStrategy;
	}

	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);
	ctx.ui.notify(`Pool "${pool.name}" strategy changed to ${nextStrategy}.`, "info");
}

async function removePoolConfig(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<boolean> {
	const referencedEntries = config.chains.reduce(
		(count, chain) => count + chain.entries.filter((entry) => entry.pool === pool.name).length,
		0,
	);
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		referencedEntries > 0
			? `Remove pool "${pool.name}"? (Subscriptions are kept.)\n\nThis will also remove ${referencedEntries} chain entr${referencedEntries === 1 ? "y" : "ies"} that reference this pool.`
			: `Remove pool "${pool.name}"? (Subscriptions are kept.)`,
	);
	if (!confirmed) return false;

	const pruned = pruneRemovedPoolReferences(config.chains, new Set([pool.name]));
	const removedEntries = pruned.removedEntries;
	const removedChains = pruned.removedChains;
	config.chains = pruned.chains;
	config.pools = config.pools.filter((candidate) => candidate.name !== pool.name);
	saveGlobalConfig(config);
	reloadPoolManagerForCurrentProject(ctx, poolManager);

	let message = `Removed pool "${pool.name}"`;
	if (removedEntries > 0) {
		message += ` and ${removedEntries} linked chain entr${removedEntries === 1 ? "y" : "ies"}`;
	}
	if (removedChains > 0) {
		message += ` (${removedChains} empty chain${removedChains === 1 ? "" : "s"} deleted)`;
	}
	ctx.ui.notify(`${message}.`, "info");
	return true;
}

async function showPoolActions(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	config: MultiPassConfig,
	pool: PoolConfig,
): Promise<"removed" | undefined> {
	const currentStrategy = pool.strategy || "round-robin";
	const action = await showWrappedSelect(ctx, {
		title: pool.name,
		subtitle: "Escape returns to the pools list.",
		items: [
			{ value: "inspect", label: "inspect", description: "View pool health and member status" },
			{ value: "rename", label: "rename", description: "Change pool name" },
			{ value: "members", label: "members", description: "Add or remove pool members" },
			{
				value: "strategy",
				label: "strategy",
				description: `Currently ${currentStrategy}`,
			},
			{
				value: "toggle",
				label: pool.enabled ? "disable" : "enable",
				description: `Currently ${pool.enabled ? "enabled" : "disabled"}`,
			},
			{ value: "remove", label: "remove", description: "Delete this pool (subscriptions are kept)" },
		],
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return undefined;

	if (action === "inspect") {
		await inspectPoolConfig(ctx, pool, poolManager);
		return undefined;
	}
	if (action === "rename") {
		await renamePoolConfig(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "members") {
		await editPoolMembers(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "strategy") {
		await changePoolStrategy(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "toggle") {
		await togglePoolConfig(ctx, poolManager, config, pool);
		return undefined;
	}
	if (action === "remove") {
		const removed = await removePoolConfig(ctx, poolManager, config, pool);
		return removed ? "removed" : undefined;
	}
	return undefined;
}

async function handlePoolList(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	let preferredPoolName: string | undefined;

	while (true) {
		const config = loadGlobalConfig();
		const pools = config.pools;

		if (pools.length === 0) {
			ctx.ui.notify("No pools configured. Use /pool create to make one.", "info");
			return;
		}

		const selectedPoolName = await showWrappedSelect(ctx, {
			title: "Pools",
			subtitle: "Select a pool for quick actions.",
			items: pools.map((pool) => ({
				value: pool.name,
				label: pool.name,
				description: formatPoolListDescription(pool, getAuthStorage(ctx), poolManager),
			})),
			initialValue: preferredPoolName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedPoolName) return;

		preferredPoolName = selectedPoolName;
		const pool = config.pools.find((candidate) => candidate.name === selectedPoolName);
		if (!pool) continue;
		const result = await showPoolActions(ctx, poolManager, config, pool);
		if (result === "removed") {
			preferredPoolName = undefined;
			continue;
		}
		preferredPoolName = pool.name;
	}
}

async function handlePoolToggle(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map(
		(p) => `${p.name} -- currently ${p.enabled ? "enabled" : "disabled"}`,
	);

	const selected = await ctx.ui.select("Toggle pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	return togglePoolConfig(ctx, poolManager, config, config.pools[idx]);
}

async function handlePoolRemove(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const options = config.pools.map((p) => {
		const memberLabel = p.members.length === 1 ? "member" : "members";
		return `${p.name} (${p.members.length} ${memberLabel})`;
	});

	const selected = await ctx.ui.select("Remove pool", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	await removePoolConfig(ctx, poolManager, config, config.pools[idx]);
}

function summarizePoolHealth(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): {
	availableCount: number;
	authedCount: number;
	memberCount: number;
	unavailableCount: number;
	statusLabel: string;
} {
	const availableMembers = pool.enabled
		? poolManager.getAvailableMembers(pool, authStorage)
		: [];
	let authedCount = 0;
	for (const member of pool.members) {
		if (authStorage.hasAuth(member)) authedCount += 1;
	}
	const availableCount = availableMembers.length;
	const memberCount = pool.members.length;
	const unavailableCount = memberCount - availableCount;
	let statusLabel = `${availableCount}/${memberCount} available`;
	if (!pool.enabled) {
		statusLabel += " | pool disabled";
	} else if (memberCount === 0) {
		statusLabel += " | no members configured";
	} else if (availableCount === 0) {
		if (authedCount === 0) {
			statusLabel += " | no auth";
		} else {
			statusLabel += " | cooldown/no eligible members";
		}
	}
	return {
		availableCount,
		authedCount,
		memberCount,
		unavailableCount,
		statusLabel,
	};
}

function formatPoolListDescription(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const status = pool.enabled ? "enabled" : "disabled";
	return `${pool.baseProvider} | ${summary.memberCount} member${summary.memberCount === 1 ? "" : "s"} (${summary.authedCount} authed, ${summary.availableCount} available) | ${status}${summary.unavailableCount > 0 ? ` | ${summary.unavailableCount} unavailable` : ""}`;
}

function formatPoolStatusLines(
	pool: PoolConfig,
	authStorage: { hasAuth(provider: string): boolean },
	poolManager: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted"> & Partial<Pick<PoolManager, "getCooldownRemainingMs">>,
): string[] {
	const summary = summarizePoolHealth(pool, authStorage, poolManager);
	const strategy = pool.strategy || "round-robin";
	const lines = [
		`=== ${pool.name} (${pool.enabled ? "enabled" : "disabled"}) ===`,
		`provider: ${pool.baseProvider}`,
		`strategy: ${strategy}`,
		`members: ${summary.memberCount}`,
		`availability: ${summary.statusLabel}`,
	];
	if (pool.selectorScript) {
		lines.push(`selector: ${pool.selectorScript}`);
	}
	if (pool.strategy === "weighted") lines.push(`weights: ${pool.members.map(member => `${member}=${pool.memberWeights?.[member] ?? 1}`).join(", ")}`);
	if (pool.members.length === 0) {
		lines.push("  [no members configured]");
		return lines;
	}
	const memberSchedule = pool.memberSchedule || {};
	for (const member of pool.members) {
		const authed = authStorage.hasAuth(member);
		const exhausted = pool.enabled && authed && poolManager.isMemberExhausted(pool, member);
		let status = authed ? "logged in" : "not logged in";
		if (exhausted) status += " (rate limited, cooling down)";
		const remaining = exhausted ? poolManager.getCooldownRemainingMs?.(member) : 0;
		if (remaining) status += ` · ${Math.ceil(remaining / 1000)}s remaining`;
		if (pool.enabled && authed && !exhausted) status += " (available)";
		if (!pool.enabled && authed) status += " (pool disabled)";

		const schedule = memberSchedule[member];
		if (schedule) {
			const role = schedule.role || "default";
			status += ` [${role}]`;
			if (schedule.windows && schedule.windows.length > 0) {
				const now = new Date();
				const state = getScheduledMemberState(member, schedule, now);
				status += state.active ? " (in window)" : " (outside window)";
			}
		}

		lines.push(`  ${member} -- ${status}`);
	}
	return lines;
}

async function handlePoolStatus(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.pools.length === 0) {
		ctx.ui.notify("No pools configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const pool of config.pools) {
		lines.push(
			...formatPoolStatusLines(pool, getAuthStorage(ctx), poolManager),
		);
	}

	await ctx.ui.select("Pool Status", lines);
}

function findChainByName(chains: ChainConfig[], name: string): ChainConfig | undefined {
	return chains.find((chain) => chain.name === name);
}

function getChainEntryIssue(entry: ChainEntryConfig, config: MultiPassConfig): string | null {
	const pool = config.pools.find((candidate) => candidate.name === entry.pool);
	if (!pool) {
		return `invalid pool: ${entry.pool} missing`;
	}
	if (!pool.enabled) {
		return `invalid pool: ${pool.name} disabled`;
	}
	const selectableModels = getModelsForPool(pool);
	if (selectableModels.length === 0) {
		return `invalid model: no selectable models for ${pool.baseProvider}`;
	}
	if (!selectableModels.includes(entry.model)) {
		return `invalid model: ${entry.model} unavailable for ${pool.name}`;
	}
	return null;
}

interface FailoverCandidate {
	poolName: string;
	provider: string;
	modelId: string;
	source: "pool" | "chain";
	chainName?: string;
	chainIndex?: number;
}

interface FailoverSkip {
	type: "pool-member" | "chain-entry";
	poolName: string;
	reason:
		| "no-auth"
		| "exhausted"
		| "missing-pool"
		| "disabled-entry"
		| "disabled-pool"
		| "unavailable-model"
		| "no-eligible-members"
		| "already-attempted"
		| "already-visited-chain-entry";
	detail: string;
	chainName?: string;
	chainIndex?: number;
}

interface FailoverPlanOptions {
	attemptedProviders?: Set<string>;
	visitedChainIndexes?: Set<number>;
}

interface FailoverPlan {
	pool?: PoolConfig;
	chain?: ChainConfig;
	currentChainIndex?: number;
	candidates: FailoverCandidate[];
	skips: FailoverSkip[];
}

interface FailoverCascadeState {
	prompt: string;
	attemptedProviders: Set<string>;
	visitedChainIndexes: Set<number>;
}

function formatFailoverTarget(candidate: Pick<FailoverCandidate, "provider" | "modelId">): string {
	return `${candidate.provider} (${candidate.modelId})`;
}

function formatFailoverStatus(
	candidate:
		| Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex">
		| null,
	fallbackPoolName?: string,
): string {
	if (!candidate) {
		return fallbackPoolName
			? `pool:${fallbackPoolName} | cascade exhausted | no eligible target`
			: "cascade exhausted | no eligible target";
	}
	const scope = candidate.source === "chain"
		? `chain:${candidate.chainName}#${(candidate.chainIndex ?? 0) + 1}`
		: `pool:${candidate.poolName}`;
	return `${scope} | active ${formatFailoverTarget(candidate)}`;
}

function formatFailoverContinuation(
	nextCandidate: Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex"> | undefined,
): string {
	if (!nextCandidate) {
		return "cascade exhausted; no later eligible target";
	}
	const phase = nextCandidate.source === "chain"
		? `continuing forward to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `continuing within pool ${nextCandidate.poolName}`;
	return `${phase} -> ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverTransition(
	poolName: string,
	currentProvider: string,
	nextCandidate: Pick<FailoverCandidate, "provider" | "modelId" | "source" | "poolName" | "chainName" | "chainIndex">,
): string {
	const phase = nextCandidate.source === "chain"
		? `advancing to chain ${nextCandidate.chainName}#${(nextCandidate.chainIndex ?? 0) + 1}`
		: `rotating within pool ${poolName}`;
	return `[pool:${poolName}] Rate limited on ${currentProvider}; ${phase}; active ${formatFailoverTarget(nextCandidate)}`;
}

function formatFailoverExhausted(poolName: string, currentProvider: string): string {
	return `[pool:${poolName}] Failover exhausted after ${currentProvider}; no eligible target remained in this cascade.`;
}

function classifyPoolMemberSkip(
	poolName: string,
	provider: string,
	authStorage: { hasAuth(provider: string): boolean },
	exhausted: boolean,
): FailoverSkip | null {
	if (!authStorage.hasAuth(provider)) {
		return {
			type: "pool-member",
			poolName,
			reason: "no-auth",
			detail: `${provider} skipped (no auth)` ,
		};
	}
	if (exhausted) {
		return {
			type: "pool-member",
			poolName,
			reason: "exhausted",
			detail: `${provider} skipped (cooldown active)`,
		};
	}
	return null;
}

function classifyChainEntrySkip(
	chain: ChainConfig,
	chainIndex: number,
	entry: ChainEntryConfig,
	config: MultiPassConfig,
): FailoverSkip | null {
	if (!entry.enabled) {
		return {
			type: "chain-entry",
			poolName: entry.pool,
			reason: "disabled-entry",
			detail: `${entry.pool} -> ${entry.model} skipped (entry disabled)`,
			chainName: chain.name,
			chainIndex,
		};
	}
	const issue = getChainEntryIssue(entry, config);
	if (!issue) return null;
	const reason = issue.includes("missing")
		? "missing-pool"
		: issue.includes("disabled")
			? "disabled-pool"
			: "unavailable-model";
	return {
		type: "chain-entry",
		poolName: entry.pool,
		reason,
		detail: `${entry.pool} -> ${entry.model} skipped (${issue})`,
		chainName: chain.name,
		chainIndex,
	};
}

function formatChainEntryStatus(
	entry: ChainEntryConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryState = entry.enabled ? "enabled" : "disabled";
	const issue = config ? getChainEntryIssue(entry, config) : null;
	let healthSuffix = "";
	if (config && authStorage && poolManager) {
		const pool = config.pools.find((candidate) => candidate.name === entry.pool);
		if (pool) {
			const summary = summarizePoolHealth(pool, authStorage, poolManager);
			healthSuffix = ` | pool ${pool.enabled ? "enabled" : "disabled"} | ${summary.availableCount}/${summary.memberCount} available | ${summary.authedCount} authed`;
		}
	}
	const issueSuffix = issue ? ` | ${issue} | skipped` : "";
	return `${entry.pool} -> ${entry.model} (${entryState}${healthSuffix}${issueSuffix})`;
}

function formatChainListLine(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	const invalidEntries = config
		? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length
		: 0;
	let usableEntries = 0;
	if (config && authStorage && poolManager) {
		usableEntries = chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool || !pool.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length;
	}
	const issueLabel = invalidEntries > 0 ? ` | ${invalidEntries} invalid` : "";
	const usableLabel = config && authStorage && poolManager
		? ` | ${usableEntries}/${chain.entries.length} usable now`
		: "";
	return `${chain.name} | ${chain.entries.length} ${entryLabel} | ${chain.enabled ? "enabled" : "disabled"}${issueLabel}${usableLabel}`;
}

function formatChainToggleOption(chain: ChainConfig): string {
	return `${chain.name} -- currently ${chain.enabled ? "enabled" : "disabled"}`;
}

function formatChainRemoveOption(chain: ChainConfig): string {
	const entryLabel = chain.entries.length === 1 ? "entry" : "entries";
	return `${chain.name} (${chain.entries.length} ${entryLabel})`;
}

function formatChainStatusLines(
	chain: ChainConfig,
	config?: MultiPassConfig,
	authStorage?: { hasAuth(provider: string): boolean },
	poolManager?: Pick<PoolManager, "getAvailableMembers" | "isMemberExhausted">,
): string[] {
	const invalidEntries = config
		? chain.entries.filter((entry) => getChainEntryIssue(entry, config)).length
		: 0;
	const usableEntries = config && authStorage && poolManager
		? chain.entries.filter((entry) => {
			if (!entry.enabled) return false;
			if (getChainEntryIssue(entry, config)) return false;
			const pool = config.pools.find((candidate) => candidate.name === entry.pool);
			if (!pool || !pool.enabled) return false;
			return summarizePoolHealth(pool, authStorage, poolManager).availableCount > 0;
		}).length
		: undefined;
	const lines = [
		`=== ${chain.name} (${chain.enabled ? "enabled" : "disabled"}) ===`,
		`entries: ${chain.entries.length}`,
		`chain state: ${chain.enabled ? "active" : "disabled (all entries skipped)"}`,
	];

	if (usableEntries !== undefined) {
		lines.push(`usable entries now: ${usableEntries}/${chain.entries.length}`);
	}

	if (invalidEntries > 0) {
		lines.push(`invalid entries: ${invalidEntries} (skipped until fixed)`);
	}

	if (chain.entries.length === 0) {
		lines.push("  [no entries configured]");
		return lines;
	}

	for (let i = 0; i < chain.entries.length; i++) {
		const entry = chain.entries[i];
		lines.push(`  ${i + 1}. ${formatChainEntryStatus(entry, config, authStorage, poolManager)}`);
	}

	return lines;
}

async function handlePoolChainCreate(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	const chainName = await ctx.ui.input("Chain name", "e.g. primary-fallback");
	if (!chainName?.trim()) return;
	if (findChainByName(config.chains, chainName.trim())) {
		ctx.ui.notify(`Chain "${chainName.trim()}" already exists.`, "warning");
		return;
	}

	const entries: ChainEntryConfig[] = [];
	let selecting = true;
	while (selecting) {
		const latestConfig = loadGlobalConfig();
		const availablePools = latestConfig.pools;
		const options = [
			`--- Selected (${entries.length}): ${entries.map((entry) => formatChainEntryStatus(entry, latestConfig)).join(", ") || "none"} ---`,
			...availablePools.map((pool) => `${pool.name} -- ${pool.baseProvider} (${pool.enabled ? "enabled" : "disabled"})`),
			"[Create pool inline]",
			"[Done - save chain]",
		];

		const selected = await ctx.ui.select("Add chain entries ([Done] saves, Esc cancels)", options);
		if (!selected) {
			ctx.ui.notify(`Cancelled chain creation for "${chainName.trim()}".`, "info");
			return;
		}
		if (selected.startsWith("---")) {
			continue;
		}

		if (selected === "[Done - save chain]") {
			if (entries.length === 0) {
				ctx.ui.notify(`Chain "${chainName.trim()}" needs at least 1 entry.`, "warning");
				continue;
			}
			selecting = false;
			continue;
		}

		if (selected === "[Create pool inline]") {
			await createAndPersistPool(ctx, poolManager, {
				allowOverwrite: false,
				resumeChainName: chainName.trim(),
			});
			continue;
		}

		const poolName = selected.split(" -- ")[0];
		const pool = availablePools.find((candidate) => candidate.name === poolName);
		if (!pool) {
			ctx.ui.notify(`Pool "${poolName}" is no longer available.`, "warning");
			continue;
		}

		const selectableModels = getSelectableModelsForPool(pool, ctx);
		if (selectableModels.length === 0) {
			ctx.ui.notify(
				`Pool "${pool.name}" has no selectable models for ${pool.baseProvider}.`,
				"warning",
			);
			continue;
		}

		const selectedModel = await ctx.ui.select(
			`Default model for ${pool.name}`,
			selectableModels,
		);
		if (!selectedModel) continue;

		const enabled = await ctx.ui.confirm(
			`Enable entry for ${pool.name}?`,
			`${pool.name} -> ${selectedModel}\n\nEnable this chain entry?`,
		);
		entries.push({ pool: pool.name, model: selectedModel, enabled });
	}

	const latestConfig = loadGlobalConfig();
	const built = buildChainConfig(latestConfig, {
		name: chainName.trim(),
		entries,
		enabled: true,
	}, ctx);
	if (!built.ok) {
		ctx.ui.notify(built.error, "warning");
		return;
	}

	latestConfig.chains.push(built.chain);
	saveGlobalConfig(latestConfig);
	ctx.ui.notify(
		`Created chain "${built.chain.name}" with ${built.chain.entries.length} ${built.chain.entries.length === 1 ? "entry" : "entries"}.`,
		"info",
	);
}

async function handlePoolChainList(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured. Use /pool chain to create one.", "info");
		return;
	}

	await ctx.ui.select(
		"Chains",
		config.chains.map((chain) =>
			formatChainListLine(chain, config, getAuthStorage(ctx), poolManager),
		),
	);
}

async function handlePoolChainToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainToggleOption);
	const selected = await ctx.ui.select("Toggle chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	config.chains[idx].enabled = !config.chains[idx].enabled;
	saveGlobalConfig(config);

	const chain = config.chains[idx];
	ctx.ui.notify(
		`Chain "${chain.name}" is now ${chain.enabled ? "enabled" : "disabled"}`,
		"info",
	);
}

async function handlePoolChainRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const options = config.chains.map(formatChainRemoveOption);
	const selected = await ctx.ui.select("Remove chain", options);
	if (!selected) return;

	const idx = options.indexOf(selected);
	if (idx < 0) return;

	const chain = config.chains[idx];
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove chain "${chain.name}"?`,
	);
	if (!confirmed) return;

	config.chains.splice(idx, 1);
	saveGlobalConfig(config);
	ctx.ui.notify(`Removed chain "${chain.name}"`, "info");
}

async function handlePoolChainStatus(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.chains.length === 0) {
		ctx.ui.notify("No chains configured.", "info");
		return;
	}

	const selected = await ctx.ui.select(
		"Chain Status",
		config.chains.map((chain) => `${chain.name} -- inspect chain entries`),
	);
	if (!selected) return;

	const chainName = selected.split(" -- ")[0];
	const chain = findChainByName(config.chains, chainName);
	if (!chain) {
		ctx.ui.notify(`Chain "${chainName}" not found.`, "warning");
		return;
	}

	await ctx.ui.select(
		`Chain Status: ${chain.name}`,
		formatChainStatusLines(chain, config, getAuthStorage(ctx), poolManager),
	);
}

async function handlePoolChainMenu(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"create   -- Create a new fallback chain",
		"list     -- Show all chains",
		"toggle   -- Enable/disable a chain",
		"remove   -- Remove a chain",
		"status   -- Inspect ordered chain entries",
	];

	const selected = await ctx.ui.select("Chain Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolChainCreate(ctx, poolManager);
		case "list":
			return handlePoolChainList(ctx, poolManager);
		case "toggle":
			return handlePoolChainToggle(ctx);
		case "remove":
			return handlePoolChainRemove(ctx);
		case "status":
			return handlePoolChainStatus(ctx, poolManager);
	}
}

async function handlePoolProject(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const projectPath = projectConfigPath(ctx.cwd);
	const projectConf = loadProjectConfig(ctx.cwd);
	const globalConf = loadGlobalConfig();

	const hasProjectConfig = projectConf !== undefined;

	const actions: string[] = [];
	if (hasProjectConfig) {
		actions.push(`edit     -- Edit project pool config (${projectPath})`);
		actions.push("clear    -- Remove project config (use global pools)");
	}
	actions.push("restrict -- Set allowed subs for this project");
	actions.push("pools    -- Set project-specific pools");
	actions.push("info     -- Show effective config for this project");

	const selected = await ctx.ui.select(
		`Project Config (${hasProjectConfig ? "active" : "none"})`,
		actions,
	);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();

	if (action === "clear") {
		if (!hasProjectConfig) {
			ctx.ui.notify("No project config to clear.", "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Clear project config",
			`Remove ${projectPath}?\nGlobal pools will be used instead.`,
		);
		if (!confirmed) return;
		try {
			writeFileSync(projectPath, "{}", "utf-8");
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project config cleared. Using global pools.", "info");
		} catch (err: unknown) {
			ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		return;
	}

	if (action === "restrict") {
		// Show all global subs and let user pick which are allowed
		const envEntries = parseEnvConfig();
		const allSubs = normalizeEntries(mergeConfigs(globalConf, envEntries));
		const allProviderNames = [
			...SUPPORTED_PROVIDERS.filter((p) =>
				getAuthStorage(ctx).hasAuth(p),
			),
			...allSubs.map((s) => subProviderName(s)),
		];

		if (allProviderNames.length === 0) {
			ctx.ui.notify("No subscriptions available to restrict.", "info");
			return;
		}

		const currentAllowed = projectConf?.allowedSubs || [];
		const allowed: string[] = [];
		let selecting = true;

		while (selecting) {
			const remaining = allProviderNames.filter((p) => !allowed.includes(p));
			if (remaining.length === 0) break;

			const options = [
				`--- Allowed (${allowed.length}): ${allowed.join(", ") || "all (no restriction)"} ---`,
				...remaining.map((p) => {
					const authed = getAuthStorage(ctx).hasAuth(p);
					const current = currentAllowed.includes(p) ? " [currently allowed]" : "";
					return `${p} ${authed ? "[logged in]" : "[not logged in]"}${current}`;
				}),
				"[Done - save]",
				"[Clear - allow all]",
			];

			const picked = await ctx.ui.select("Select allowed subs (Esc when done)", options);
			if (!picked || picked.startsWith("---")) {
				selecting = false;
				continue;
			}
			if (picked === "[Done - save]") {
				selecting = false;
				continue;
			}
			if (picked === "[Clear - allow all]") {
				allowed.length = 0;
				selecting = false;
				continue;
			}

			const provName = picked.split(" ")[0];
			if (provName && allProviderNames.includes(provName)) {
				allowed.push(provName);
			}
		}

		const newProjectConf: ProjectConfig = {
			...projectConf,
			allowedSubs: allowed.length > 0 ? allowed : undefined,
		};
		saveProjectConfig(ctx.cwd, newProjectConf);

		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		if (allowed.length > 0) {
			ctx.ui.notify(
				`Project restricted to: ${allowed.join(", ")}`,
				"info",
			);
		} else {
			ctx.ui.notify("Project restriction cleared. All subs available.", "info");
		}
		return;
	}

	if (action === "pools") {
		// Copy global pools and let user toggle which are active for this project
		const globalPools = globalConf.pools;
		if (globalPools.length === 0) {
			ctx.ui.notify("No global pools defined. Create pools first with /pool create.", "info");
			return;
		}

		const currentProjectPools = projectConf?.pools;
		const options = [
			"[Use global pools (no override)]",
			...globalPools.map((p) => {
				const isIncluded = currentProjectPools
					? currentProjectPools.some((pp) => pp.name === p.name)
					: true;
				return `${p.name} (${p.members.length} members) ${isIncluded ? "[included]" : "[excluded]"}`;
			}),
		];

		const selected2 = await ctx.ui.select("Project pools (select to toggle)", options);
		if (!selected2) return;

		if (selected2 === "[Use global pools (no override)]") {
			const newProjectConf: ProjectConfig = { ...projectConf };
			delete newProjectConf.pools;
			saveProjectConfig(ctx.cwd, newProjectConf);
			const effective = loadEffectiveConfig(ctx.cwd);
			poolManager.loadPools(effective.pools);
			ctx.ui.notify("Project will use global pools.", "info");
			return;
		}

		// Toggle: build project pool list
		const poolName = selected2.split(" (")[0];
		const pool = globalPools.find((p) => p.name === poolName);
		if (!pool) return;

		let projectPools = currentProjectPools ? [...currentProjectPools] : [...globalPools];
		const existingIdx = projectPools.findIndex((p) => p.name === pool.name);
		if (existingIdx >= 0) {
			projectPools.splice(existingIdx, 1);
		} else {
			projectPools.push(pool);
		}

		const newProjectConf: ProjectConfig = { ...projectConf, pools: projectPools };
		saveProjectConfig(ctx.cwd, newProjectConf);
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);

		const activeNames = projectPools.map((p) => p.name).join(", ") || "none";
		ctx.ui.notify(`Project pools: ${activeNames}`, "info");
		return;
	}

	if (action === "info") {
		const effective = loadEffectiveConfig(ctx.cwd);
		const lines: string[] = [];

		if (effective.projectConfigPath && loadProjectConfig(ctx.cwd)) {
			lines.push(`Project config: ${projectPath}`);
		} else {
			lines.push("Project config: none (using global)");
		}

		const pc = loadProjectConfig(ctx.cwd);
		if (pc?.allowedSubs && pc.allowedSubs.length > 0) {
			lines.push(`Allowed subs: ${pc.allowedSubs.join(", ")}`);
		} else {
			lines.push("Allowed subs: all (no restriction)");
		}

		lines.push("");
		lines.push(`Effective pools (${effective.pools.length}):`);
		for (const pool of effective.pools) {
			const src = pc?.pools ? "project" : "global";
			lines.push(`  ${pool.name} [${src}] -- ${pool.members.join(", ")} (${pool.enabled ? "enabled" : "disabled"})`);
		}

		lines.push("");
		lines.push(`Effective subs (${effective.subscriptions.length}):`);
		for (const sub of effective.subscriptions) {
			const authed = getAuthStorage(ctx).hasAuth(subProviderName(sub));
			lines.push(`  ${subDisplayName(sub)} -- ${authed ? "logged in" : "not logged in"}`);
		}

		await ctx.ui.select("Effective Config", lines);
		return;
	}
}

async function handlePoolTrace(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
	action?: string,
): Promise<void> {
	let selectedAction = action;
	if (!selectedAction) {
		selectedAction = await showWrappedSelect(ctx, {
			title: "Routing Trace",
			subtitle: poolManager.isTraceEnabled() ? "Recording is active." : "Recording is off until explicitly started.",
			items: [
				{ value: "start", label: "start", description: "Clear old entries and begin recording" },
				{ value: "show", label: "show", description: "Inspect recorded routing decisions" },
				{ value: "stop", label: "stop", description: "Stop recording and retain entries" },
				{ value: "clear", label: "clear", description: "Delete recorded entries" },
				{ value: "status", label: "status", description: "Show recording state and entry count" },
			],
			confirmHint: "run",
			cancelHint: "back",
		});
	}
	if (!selectedAction) return;

	switch (selectedAction) {
		case "start":
			poolManager.startTrace();
			ctx.ui.notify("Routing trace started; previous entries cleared", "info");
			return;
		case "stop":
			poolManager.stopTrace();
			ctx.ui.notify("Routing trace stopped; recorded entries retained", "info");
			return;
		case "clear":
			poolManager.clearTrace();
			ctx.ui.notify("Routing trace cleared", "info");
			return;
		case "status": {
			const state = poolManager.isTraceEnabled() ? "recording" : "stopped";
			ctx.ui.notify(`Routing trace: ${state}, ${poolManager.getRoutingTrace().length} entries`, "info");
			return;
		}
		case "show": {
			const entries = poolManager.getRoutingTrace();
			if (entries.length === 0) {
				ctx.ui.notify(
					poolManager.isTraceEnabled()
						? "Routing trace is recording but has no entries yet"
						: "Routing trace is empty; run /pool trace start first",
					"info",
				);
				return;
			}
			await showWrappedSelect(ctx, {
				title: "Routing Trace",
				subtitle: `${entries.length} most recent decisions (maximum ${MAX_ROUTING_TRACE_ENTRIES}).`,
				items: entries.map((entry, index) => ({
					value: String(index),
					label: `${new Date(entry.timestamp).toLocaleTimeString()}  ${entry.message}`,
				})),
				confirmHint: "close",
				cancelHint: "close",
			});
			return;
		}
		default:
			return handlePoolTrace(ctx, poolManager);
	}
}

async function handlePoolMenu(
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions = [
		"create   -- Create a new rotation pool",
		"list     -- Show pools and quick actions",
		"chain    -- Manage saved fallback chains",
		"toggle   -- Enable/disable a pool",
		"remove   -- Remove a pool",
		"status   -- Detailed pool status with member health",
		"trace    -- Opt-in routing decision trace",
		"preview  -- Preview routing without sending a prompt",
		"weights  -- Configure relative per-account request shares",
		`project  -- Project-level pool config (${projectConfigDir}/multi-pass.json)`,
	];

	const selected = await ctx.ui.select("Pool Manager", actions);
	if (!selected) return;

	const action = selected.split(" ")[0].trim();
	switch (action) {
		case "create":
			return handlePoolCreate(ctx, poolManager);
		case "list":
			return handlePoolList(ctx, poolManager);
		case "chain":
			return handlePoolChainMenu(ctx, poolManager);
		case "toggle":
			return handlePoolToggle(ctx, poolManager);
		case "remove":
			return handlePoolRemove(ctx, poolManager);
		case "status":
			return handlePoolStatus(ctx, poolManager);
		case "trace":
			return handlePoolTrace(ctx, poolManager);
		case "preview":
			return handlePoolPreview(ctx, poolManager);
		case "weights":
			return handlePoolWeights(ctx, poolManager);
		case "project":
			return handlePoolProject(ctx, poolManager);
	}
}

// ==========================================================================
// /subs share and receive
// ==========================================================================

function portableOAuth(account: string, baseProvider: string, label: string | undefined, auth: AuthStorageEntry | undefined): SharedAccount | undefined {
	if (auth?.type !== "oauth" || typeof auth.access !== "string" || typeof auth.refresh !== "string"
		|| !auth.access || !auth.refresh || typeof auth.expires !== "number") return undefined;
	const credential: SharedAccount["credential"] = { type: "oauth", access: auth.access, refresh: auth.refresh, expires: auth.expires };
	for (const key of ["accountId", "projectId", "enterpriseUrl"] as const) {
		if (typeof auth[key] === "string") credential[key] = auth[key];
	}
	return { providerName: account, baseProvider, ...(label ? { label } : {}), credential };
}

async function handleSubsShare(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") { ctx.ui.notify("/subs share requires an interactive terminal", "warning"); return; }
	const config = loadGlobalConfig();
	const auth = getAuthStorage(ctx);
	const candidates = [
		...Object.keys(PROVIDER_TEMPLATES).filter((p) => PROVIDER_TEMPLATES[p].buildOAuth)
			.map((p) => portableOAuth(p, p, undefined, auth.get(p))),
		...config.subscriptions.map((s) => portableOAuth(subProviderName(s), s.provider, s.label, auth.get(subProviderName(s)))),
	].filter((a): a is SharedAccount => Boolean(a));
	if (!candidates.length) { ctx.ui.notify("No OAuth accounts with refresh credentials to share", "warning"); return; }
	const chosen = await ctx.ui.select("Share one OAuth account (experimental)", candidates.map((a) => `${a.label || a.providerName} [${a.providerName}]`));
	const account = candidates.find((a) => `${a.label || a.providerName} [${a.providerName}]` === chosen);
	if (!account) return;
	if (!(await ctx.ui.confirm("Export OAuth credentials?", `Anyone with ALL QR frames or the full text string can access ${account.providerName}. They do not expire or self-destruct. Copied refresh tokens may break the original login. Show them?`))) return;
	try {
		const bundle: ShareBundle = { schemaVersion: 2, accounts: [account] };
		const frames = await encodeShareFrames(bundle);
		const fullText = encodeShareText(bundle);
		while (true) {
			const action = await ctx.ui.custom<"copy" | "close">((tui, theme, _kb, done) => {
				let index = 0;
				let showUri = false;
				return {
					render(width: number) {
						const frame = frames[index];
						const lines = frame.qr.trimEnd().split("\n");
						return [theme.fg("accent", `OAuth export ${account.providerName} - QR ${frame.index}/${frame.total}`),
							...(lines.some((line) => visibleWidth(line) > width)
								? [theme.fg("warning", "Widen terminal to scan the QR, or press u for its URI.")]
								: lines),
							...(showUri ? wrapTextWithAnsi(frame.uri, width) : []),
							theme.fg("warning", "Bearer credential: a copy of every frame grants account access."),
							"n/p frames, u reveal frame URI, c full copyable export, Esc close."];
					},
					invalidate() {},
					handleInput(data: string) {
						if (data === "n" || matchesKey(data, Key.right)) index = (index + 1) % frames.length;
						else if (data === "p" || matchesKey(data, Key.left)) index = (index + frames.length - 1) % frames.length;
						else if (data === "u") showUri = !showUri;
						else if (data === "c") { done("copy"); return; }
						else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { done("close"); return; }
						tui.requestRender();
					},
				};
			});
			if (action !== "copy") break;
			await ctx.ui.editor("Copy full OAuth export string (bearer credential; clipboard may sync)", fullText);
		}
	} catch (error) {
		ctx.ui.notify(`Share failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function importShareBundle(bundle: ShareBundle): Promise<string[]> {
	validateBundle(bundle);
	return withAuthFile((stored) => {
		const config = loadGlobalConfig();
		const added: string[] = [];
		for (const item of bundle.accounts) {
			if (!PROVIDER_TEMPLATES[item.baseProvider]?.buildOAuth || ![item.baseProvider, ...Array.from({ length: 99 }, (_, i) => `${item.baseProvider}-${i + 2}`)].includes(item.providerName)) throw new Error("Unsupported provider in bundle");
			let index = 2;
			while (stored[`${item.baseProvider}-${index}`] || config.subscriptions.some((s) => s.provider === item.baseProvider && s.index === index)) index++;
			const name = `${item.baseProvider}-${index}`;
			stored[name] = item.credential;
			config.subscriptions.push({ provider: item.baseProvider, index, ...(item.label ? { label: item.label } : {}) });
			added.push(name);
		}
		// Save config before auth: an auth write failure leaves harmless unauthed entries.
		saveGlobalConfig(config);
		return { value: added, changed: true };
	});
}

async function handleSubsReceive(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) { ctx.ui.notify("/subs receive requires an interactive prompt", "warning"); return; }
	const mode = await ctx.ui.select("Receive OAuth credentials from pi", ["Paste one full export string", "Paste QR frame URIs"]);
	if (!mode) return;
	try {
		let bundle: ShareBundle;
		let count = 1;
		if (mode === "Paste one full export string") {
			const text = await ctx.ui.editor("Paste full OAuth export string (keep it private)");
			if (!text) return;
			bundle = decodeShareText(text);
		} else {
			const collector = new ShareFrameCollector();
			let progress = "Paste a share QR URI (1 of ?), Esc to cancel";
			while (true) {
				const uri = await ctx.ui.input(progress);
				if (!uri) return;
				const result = collector.add(uri);
				if (result.bundle) { bundle = result.bundle; count = result.total; break; }
				progress = `Collected ${result.received}/${result.total} frames. Paste another URI, Esc to cancel`;
			}
		}
		const account = bundle.accounts[0];
		if (!(await ctx.ui.confirm("Import OAuth credentials?", `Import ${account.providerName} from ${count === 1 ? "the export string" : `${count} QR frames`}? The sender keeps its copy; token refresh on either device may invalidate the other.`))) return;
		const added = await importShareBundle(bundle);
		ctx.ui.notify(`Imported: ${added.join(", ")}. Restart ${isOmp ? "OMP" : "pi"} to register the new subscription.`, "info");
	} catch (error) {
		ctx.ui.notify(`Receive failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

// ==========================================================================
// /subs main menu
// ==========================================================================

async function handleSubsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	poolManager: PoolManager,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "list", label: "list", description: "Show all extra subscriptions" },
		{ value: "add", label: "add", description: "Add a new subscription" },
		{ value: "remove", label: "remove", description: "Remove a subscription" },
		{ value: "login", label: "login", description: "Login to a subscription" },
		{ value: "logout", label: "logout", description: "Logout from a subscription" },
		{ value: "switch", label: "switch", description: "Switch to a different subscription/provider now" },
		{ value: "model", label: "model", description: "Pick a model with pretty subscription labels (replaces /model)" },
		{ value: "status", label: "status", description: "Show auth status and token info" },
		{ value: "doctor", label: "doctor", description: "Diagnose config, credentials, models, and project restrictions" },
		{ value: "stats", label: "stats", description: "Per-account request and token totals for this session" },
		{ value: "limits", label: "limits", description: "Check built-in quota support (Anthropic + Codex + Google)" },
		{ value: "share", label: "share", description: "Export one OAuth account as offline QR frames (experimental)" },
		{ value: "receive", label: "receive", description: "Import offline QR frames from another pi" },
		{ value: "statusbar", label: "statusbar", description: "Toggle quota display (OMP widget / Pi footer)" },
		{ value: "intercept-model", label: "intercept-model", description: "Route pi's /model to /subs model (replaces editor)" },
		{ value: "keeper", label: "keeper", description: "Toggle shared OAuth token keeper for parallel pi sessions" },
	];
	let preferredAction = "list";

	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Subscription Manager",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		const config = loadGlobalConfig();
		switch (action) {
			case "list":
				await handleSubsList(pi, ctx, config, poolManager);
				break;
			case "add":
				await handleSubsAdd(pi, ctx);
				break;
			case "remove":
				await handleSubsRemove(pi, ctx, poolManager);
				break;
			case "login":
				await handleSubsLogin(ctx);
				break;
			case "logout":
				await handleSubsLogout(ctx);
				break;
			case "switch":
				await handleSubsSwitch(pi, ctx);
				break;
			case "model":
				await handleSubsModel(pi, ctx);
				break;
			case "status":
				await handleSubsStatus(ctx);
				break;
			case "doctor":
				await handleSubsDoctor(ctx);
				break;
			case "stats":
				await handleSubsStats(ctx, poolManager);
				break;
			case "limits":
				await handleSubsLimits(ctx);
				break;
			case "share":
				await handleSubsShare(ctx);
				break;
			case "receive":
				await handleSubsReceive(ctx);
				break;
			case "statusbar":
				await handleSubsStatusbar(ctx, poolManager);
				break;
			case "intercept-model":
				await handleSubsInterceptModel(ctx, pi);
				break;
			case "keeper":
				await handleSubsKeeper(ctx);
				break;
		}
	}
}

// ==========================================================================
// /mp-preset command handlers
// ==========================================================================

/** Pretty-print a preset entry using subscription labels when available. */
function formatPresetEntry(entry: PresetEntry): string {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

/** Lightweight version that takes pre-loaded subs to avoid re-reading config per entry. */
function formatPresetEntryWith(entry: PresetEntry, allSubs: SubEntry[]): string {
	const displayName = getProviderDisplayName(entry.provider, allSubs);
	return `${displayName} / ${entry.model}`;
}

async function handlePresetCreate(
	ctx: ExtensionCommandContext,
): Promise<void> {
	const presetName = await ctx.ui.input("Preset name", "e.g. coding-premium, coding-budget, fastest");
	if (!presetName?.trim()) return;

	const config = loadGlobalConfig();
	if (config.presets.find((p) => p.name === presetName.trim())) {
		const overwrite = await ctx.ui.confirm("Preset exists", `Overwrite "${presetName.trim()}"?`);
		if (!overwrite) return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const effective = loadEffectiveConfig(ctx.cwd);
	const allowed = effective.allowedProviderNames && new Set(effective.allowedProviderNames);
	const allProviders = [...new Set([
		...ctx.modelRegistry.getAll().map((model) => model.provider),
		...builtinProviders().map((provider) => provider.id),
		...allSubs.map(subProviderName),
	])].filter((provider) => !allowed || allowed.has(provider));

	const entries: PresetEntry[] = [];
	let adding = true;
	while (adding) {
		const providerOptions = [
			`--- Entries (${entries.length}): ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ") || "none"} ---`,
			...allProviders.map((p) => {
				const template = PROVIDER_TEMPLATES[p];
				const display = template?.displayName || p;
				const sub = allSubs.find((s) => subProviderName(s) === p);
				const label = sub ? subDisplayName(sub) : display;
				return `${p} -- ${label}`;
			}),
			"[Done - save preset]",
		];

		const picked = await ctx.ui.select("Add entry (Esc cancels)", providerOptions);
		if (!picked) return;
		if (picked.startsWith("---")) continue;
		if (picked === "[Done - save preset]") {
			if (entries.length === 0) {
				ctx.ui.notify("Add at least one entry.", "warning");
				continue;
			}
			adding = false;
			continue;
		}

		const provider = picked.split(" -- ")[0].trim();
		if (!allProviders.includes(provider)) continue;
		const models = providerModelChoices(ctx, provider).map((m) => m.id);
		if (models.length === 0) {
			ctx.ui.notify(`No models available for ${provider}.`, "warning");
			continue;
		}

		const model = await ctx.ui.select(`Model for ${provider}`, models);
		if (!model) continue;

		entries.push({ provider, model, enabled: true });
	}

	const preset: PresetConfig = {
		name: presetName.trim(),
		entries,
		enabled: true,
	};
	const existingIdx = config.presets.findIndex((p) => p.name === preset.name);
	if (existingIdx >= 0) {
		config.presets[existingIdx] = preset;
	} else {
		config.presets.push(preset);
	}
	saveGlobalConfig(config);
	ctx.ui.notify(
		`Preset "${preset.name}" saved with ${entries.length} ${entries.length === 1 ? "entry" : "entries"}: ${entries.map((e) => formatPresetEntryWith(e, allSubs)).join(", ")}`,
		"info",
	);
}

async function handlePresetList(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured. Use /mp-preset create to add one.", "info");
		return;
	}

	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const items: SelectItem[] = config.presets.map((preset) => ({
		value: preset.name,
		label: `${preset.enabled ? "+" : "-"} ${preset.name}`,
		description: preset.entries.map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
	}));

	await showWrappedSelect(ctx, {
		title: "Model Presets",
		subtitle: "Presets are named routing shortcuts across providers.",
		items,
		confirmHint: "back",
		cancelHint: "close",
	});
}

async function handlePresetActivate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedName?: string,
): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const enabled = config.presets.filter((p) => p.enabled);
	if (enabled.length === 0) {
		ctx.ui.notify("No enabled presets. Use /mp-preset create to add one.", "info");
		return;
	}

	let presetName = requestedName?.trim();
	if (!presetName) {
		presetName = await showWrappedSelect(ctx, {
			title: "Activate Preset",
			subtitle: "Select a preset to switch to its best available entry.",
			items: enabled.map((p) => ({
				value: p.name,
				label: p.name,
				description: p.entries.filter((e) => e.enabled).map((e) => formatPresetEntryWith(e, allSubs)).join(" -> "),
			})),
			confirmHint: "activate",
			cancelHint: "back",
		});
	}
	if (!presetName) return;

	const preset = enabled.find((p) => p.name === presetName);
	if (!preset) {
		ctx.ui.notify(`Preset "${presetName}" not found.`, "error");
		return;
	}

	for (const entry of preset.entries) {
		if (!entry.enabled) continue;
		if (!getAuthStorage(ctx).hasAuth(entry.provider)) continue;
		const model = ctx.modelRegistry.find(entry.provider, entry.model);
		if (!model) continue;

		const success = await pi.setModel(model);
		if (!success) continue;

		const prettyEntry = formatPresetEntryWith(entry, allSubs);
		ctx.ui.notify(`Preset "${preset.name}": switched to ${prettyEntry}`, "info");
		ctx.ui.setStatus("multi-pass", `preset:${preset.name} | ${prettyEntry}`);
		return;
	}

	ctx.ui.notify(
		`Preset "${preset.name}": no entry has a logged-in provider with the required model available.`,
		"warning",
	);
}

async function handlePresetRemove(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets to remove.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Remove Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: `${p.entries.length} entries`,
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selected) return;

	const confirmed = await ctx.ui.confirm("Confirm", `Remove preset "${selected}"?`);
	if (!confirmed) return;

	config.presets = config.presets.filter((p) => p.name !== selected);
	saveGlobalConfig(config);
	ctx.ui.notify(`Removed preset "${selected}".`, "info");
}

async function handlePresetToggle(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	if (config.presets.length === 0) {
		ctx.ui.notify("No presets configured.", "info");
		return;
	}

	const selected = await showWrappedSelect(ctx, {
		title: "Toggle Preset",
		items: config.presets.map((p) => ({
			value: p.name,
			label: `${p.enabled ? "+" : "-"} ${p.name}`,
			description: p.enabled ? "enabled" : "disabled",
		})),
		confirmHint: "toggle",
		cancelHint: "back",
	});
	if (!selected) return;

	const preset = config.presets.find((p) => p.name === selected);
	if (!preset) return;

	preset.enabled = !preset.enabled;
	saveGlobalConfig(config);
	ctx.ui.notify(`Preset "${preset.name}" is now ${preset.enabled ? "enabled" : "disabled"}.`, "info");
}

async function handlePresetMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "activate", label: "activate", description: "Switch to a preset's best available entry" },
		{ value: "create", label: "create", description: "Create a new preset" },
		{ value: "list", label: "list", description: "Show all presets" },
		{ value: "toggle", label: "toggle", description: "Enable/disable a preset" },
		{ value: "remove", label: "remove", description: "Delete a preset" },
	];

	let preferredAction = "activate";
	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Model Presets",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		switch (action) {
			case "activate":
				await handlePresetActivate(pi, ctx);
				break;
			case "create":
				await handlePresetCreate(ctx);
				break;
			case "list":
				await handlePresetList(ctx);
				break;
			case "toggle":
				await handlePresetToggle(ctx);
				break;
			case "remove":
				await handlePresetRemove(ctx);
				break;
		}
	}
}

// ==========================================================================
// Status bar (/subs statusbar) -- omarchy-style footer
// ==========================================================================

const STATUS_BAR_QUOTA_REFRESH_MS = 5 * 60_000;
const STATUS_BAR_CLOCK_MS = 30_000;
const OMP_QUOTA_RAINBOW_MS = 180;
const OMP_QUOTA_RAINBOW_COLORS = [196, 202, 226, 46, 51, 39, 129, 201];

const STATUS_BAR_GLYPHS: Record<string, string> = {
	anthropic: "\u2733",
	"openai-codex": "\u2b22",
	"github-copilot": "\u25c9",
	"google-gemini-cli": "\u2726",
	"google-antigravity": "\u25b2",
	minimax: "\u25c6",
	"minimax-cn": "\u25c6",
};

const STATUS_BAR_SHORT_NAMES: Record<string, string> = {
	anthropic: "claude",
	"openai-codex": "codex",
	"github-copilot": "copilot",
	"google-gemini-cli": "gemini",
	"google-antigravity": "agrav",
	minimax: "minimax",
	"minimax-cn": "minimax-cn",
};

interface StatusBarAccount {
	providerName: string;
	shortName: string;
	glyph: string;
}

let statusBarAccounts: StatusBarAccount[] = [];
const statusBarQuota = new Map<string, QuotaCheckResult>();
let statusBarQuotaFetchedAt = 0;
let statusBarRefreshInFlight: Promise<void> | undefined;
let disposeOmpStatusBar: (() => void) | undefined;
let refreshOmpStatusBar: (() => void) | undefined;

function statusBarShortName(providerName: string, subs: SubEntry[]): string {
	const entry = subs.find((candidate) => subProviderName(candidate) === providerName);
	if (entry?.label) {
		return entry.label.length > 12 ? `${entry.label.slice(0, 11)}\u2026` : entry.label;
	}
	const base = getBaseProvider(providerName) || providerName;
	const short = STATUS_BAR_SHORT_NAMES[base] || base;
	return entry ? `${short}#${entry.index}` : short;
}

function statusBarAccountsFrom(
	ctx: ExtensionContext,
	quotaAccounts: QuotaAccount[],
): StatusBarAccount[] {
	const subs = normalizeEntries(mergeConfigs(loadGlobalConfig(), parseEnvConfig()));
	return quotaAccounts.map((account) => ({
		providerName: account.providerName,
		shortName: statusBarShortName(account.providerName, subs),
		glyph: STATUS_BAR_GLYPHS[account.baseProvider] || "\u25cf",
	}));
}

function collectStatusBarAccounts(ctx: ExtensionContext): StatusBarAccount[] {
	return statusBarAccountsFrom(ctx, collectQuotaAccounts(ctx));
}

function sameQuotaAccounts(left: QuotaAccount[], right: QuotaAccount[]): boolean {
	return left.length === right.length && left.every((account) => {
		const other = right.find((candidate) => candidate.providerName === account.providerName);
		return other !== undefined
			&& account.auth?.access === other.auth?.access
			&& account.auth?.accountId === other.auth?.accountId
			&& Boolean(account.pendingSelection) === Boolean(other.pendingSelection);
	});
}

function knownQuotaResetAt(ctx: ExtensionContext, provider: string | undefined): number | undefined {
	if (!provider || statusBarQuotaFetchedAt <= Date.now() - STATUS_BAR_QUOTA_REFRESH_MS) return undefined;
	const cached = statusBarQuota.get(provider);
	const current = collectQuotaAccounts(ctx).find(account => account.providerName === provider);
	if (!cached || !current || current.pendingSelection || !sameQuotaAccounts([cached.account], [current])) return undefined;
	const resets = [...(cached.windows ?? []), ...(cached.models ?? [])]
		.filter(window => window.remainingPercent !== undefined && window.remainingPercent <= 0 && window.resetAt && window.resetAt * 1000 > Date.now())
		.map(window => window.resetAt!);
	return resets.length ? Math.max(...resets) : undefined;
}

function updateStatusBarQuota(ctx: ExtensionContext, onDone: () => void): void {
	// Collect once per tick: each collect re-reads the config files and auth
	// store, and this runs every STATUS_BAR_CLOCK_MS on OMP.
	const accounts = collectQuotaAccounts(ctx);
	const changed = !sameQuotaAccounts([...statusBarQuota.values()].map((result) => result.account), accounts);
	if (changed) statusBarQuota.clear();
	statusBarAccounts = statusBarAccountsFrom(ctx, accounts);
	if (changed || Date.now() - statusBarQuotaFetchedAt > STATUS_BAR_QUOTA_REFRESH_MS) {
		refreshStatusBarQuota(ctx, onDone);
	} else {
		onDone();
	}
}

function refreshStatusBarQuota(ctx: ExtensionContext, onDone: () => void): void {
	if (statusBarRefreshInFlight) {
		void statusBarRefreshInFlight.then(onDone);
		return;
	}
	const accounts = collectQuotaAccounts(ctx);
	statusBarAccounts = statusBarAccountsFrom(ctx, accounts);
	let selectionChanged = false;
	statusBarRefreshInFlight = runQuotaChecks(accounts)
		.then((results) => {
			selectionChanged = !sameQuotaAccounts(accounts, collectQuotaAccounts(ctx));
			if (selectionChanged) return;
			statusBarQuota.clear();
			for (const result of results) {
				statusBarQuota.set(result.account.providerName, result);
			}
			statusBarQuotaFetchedAt = Date.now();
		})
		.catch(() => {})
		.finally(() => {
			statusBarRefreshInFlight = undefined;
			if (selectionChanged) refreshStatusBarQuota(ctx, onDone);
			else onDone();
		});
}

function shortenPathForStatusBar(path: string): string {
	const home = homedir();
	let shortened = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	if (shortened.length > 28) {
		shortened = `\u2026${shortened.slice(-27)}`;
	}
	return shortened;
}

function renderStatusBarLine(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	ctx: ExtensionContext,
	width: number,
): string {
	const separator = theme.fg("dim", " \u2502 ");
	const segments: string[] = [];
	for (const account of statusBarAccounts) {
		const quota = statusBarQuota.get(account.providerName);
		const percent = quota?.worstRemainingPercent;
		const status = percent !== undefined
			? `${Math.round(percent)}%`
			: quota
				? getQuotaStatusGlyph(quota.kind)
				: "\u2026";
		const text = `${account.glyph} ${account.shortName} ${status}`;
		if (ctx.model?.provider === account.providerName) {
			segments.push(isOmp ? theme.bold(theme.fg("accent", text)) : theme.style(text, { fg: "accent", bold: true }));
		} else {
			const color = quota && quota.kind !== "missing-auth" && quota.kind !== "error"
				? quotaBarColor(percent)
				: "dim";
			segments.push(theme.fg(color, text));
		}
	}
	const left = segments.join(separator);

	const now = new Date();
	const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	const rightParts: string[] = [];
	rightParts.push(shortenPathForStatusBar(ctx.cwd));
	if (ctx.model) rightParts.push(ctx.model.id);
	const usage = ctx.getContextUsage();
	if (usage?.percent != null) rightParts.push(`ctx ${Math.round(usage.percent)}%`);
	const branch = footerData.getGitBranch();
	if (branch) rightParts.push(`\u2387 ${branch}`);
	rightParts.push(clock);
	const right = theme.fg("dim", rightParts.join("  "));

	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) {
		return left + " ".repeat(gap) + right;
	}
	return truncateToWidth(`${left} ${right}`, width);
}

function createStatusBarComponent(
	tui: TUI,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	ctx: ExtensionContext,
) {
	const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
	const clockTimer = setInterval(() => tui.requestRender(), STATUS_BAR_CLOCK_MS);
	const refreshTimer = setInterval(
		() => refreshStatusBarQuota(ctx, () => tui.requestRender()),
		STATUS_BAR_QUOTA_REFRESH_MS,
	);
	if (statusBarAccounts.length === 0) {
		statusBarAccounts = collectStatusBarAccounts(ctx);
	}
	if (Date.now() - statusBarQuotaFetchedAt > STATUS_BAR_QUOTA_REFRESH_MS) {
		refreshStatusBarQuota(ctx, () => tui.requestRender());
	}

	return {
		dispose() {
			unsubscribeBranch();
			clearInterval(clockTimer);
			clearInterval(refreshTimer);
		},
		invalidate() {},
		render(width: number): string[] {
			const lines = [renderStatusBarLine(theme, footerData, ctx, width)];
			// Keep texts other extensions publish via ctx.ui.setStatus() visible;
			// replacing the footer must not swallow them.
			const statuses = [...footerData.getExtensionStatuses().values()]
				.map((status) => status.trim())
				.filter(Boolean);
			if (statuses.length > 0) {
				lines.push(truncateToWidth(statuses.join(theme.fg("dim", " \u2502 ")), width));
			}
			return lines;
		},
	};
}

function renderOmpQuotaTitle(): string {
	const phase = Math.floor(Date.now() / OMP_QUOTA_RAINBOW_MS) % OMP_QUOTA_RAINBOW_COLORS.length;
	return Array.from("Multi Pass", (character, index) =>
		`\x1b[38;5;${OMP_QUOTA_RAINBOW_COLORS[(index + phase) % OMP_QUOTA_RAINBOW_COLORS.length]}m${character}\x1b[0m`,
	).join("");
}

function renderOmpQuotaLines(ctx: ExtensionContext, width = process.stdout.columns || 80, poolManager?: PoolManager): string[] {
	const theme = ctx.ui.theme;
	const title = `${renderOmpQuotaTitle()}${theme.fg("dim", " · quota left")}`;
	const lines: string[] = [];
	const nameWidth = Math.max(0, ...statusBarAccounts.map((account) => visibleWidth(account.shortName)));
	for (const account of statusBarAccounts) {
		const quota = statusBarQuota.get(account.providerName);
		const windows = [...(quota?.windows ?? []), ...(quota?.models ?? [])];
		const remaining = windows.length > 0
			? windows.map((window) => {
				const percent = window.remainingPercent;
				const value = percent === undefined ? "unknown" : `${Math.round(percent)}%`;
				const reset = window.resetAt ? theme.fg("dim", ` (reset ${formatResetShort(window.resetAt)})`) : "";
				return `${window.label} ${theme.fg(quotaBarColor(percent), value)}${reset}`;
			}).join(theme.fg("dim", " · "))
			: quota?.worstRemainingPercent !== undefined
				? theme.fg(quotaBarColor(quota.worstRemainingPercent), `${Math.round(quota.worstRemainingPercent)}%`)
				: theme.fg(quota?.kind === "error" ? "error" : "dim", quota ? quota.summary : "checking…");
		const active = ctx.model?.provider === account.providerName;
		const name = `${active ? "●" : "○"} ${account.shortName}`;
		const padding = " ".repeat(nameWidth - visibleWidth(account.shortName));
		lines.push(`${theme.fg(active ? "accent" : "muted", name)}${padding}  ${remaining}`);
	}
	if (statusBarAccounts.length === 0) lines.push("No supported quota accounts. Use /subs limits for details.");
	const pool = ctx.model ? poolManager?.getPoolForProvider(ctx.model.provider) : undefined;
	lines.push(`${theme.fg("dim", "pool: ")}${theme.fg(pool ? "accent" : "muted", pool?.name ?? "none")}`);
	lines.push(theme.fg("dim", statusBarQuotaFetchedAt ? `quota: checked ${Math.max(0, Math.floor((Date.now() - statusBarQuotaFetchedAt) / 1000))}s ago` : "quota: not checked yet"));
	if (width < 5) return [title, ...lines].map((line) => truncateToWidth(line, Math.max(0, width)));
	const contentWidth = Math.min(
		Math.max(visibleWidth(title) + 2, ...lines.map((line) => visibleWidth(line))),
		width - 4,
	);
	const heading = `─ ${truncateToWidth(title, contentWidth - 1)} `;
	const rows = lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
	// Headroom leaves its frame in the terminal's default foreground.
	return [
		`╭${heading}${"─".repeat(Math.max(0, contentWidth + 2 - visibleWidth(heading)))}╮`,
		...rows.map((line) => `│ ${line}${" ".repeat(Math.max(0, contentWidth - visibleWidth(line)))} │`),
		`╰${"─".repeat(contentWidth + 2)}╯`,
	];
}

function applyOmpStatusBar(ctx: ExtensionContext, enabled: boolean, poolManager?: PoolManager): void {
	disposeOmpStatusBar?.();
	disposeOmpStatusBar = undefined;
	if (!enabled) {
		ctx.ui.setWidget("multi-pass-quota", undefined, { placement: "aboveEditor" });
		return;
	}
	let disposed = false;
	const ui = ctx.ui;
	const setWidget = ui.setWidget;
	let headroom: { lines: string[]; options?: Parameters<typeof ui.setWidget>[2] } | undefined;
	let headroomHidden = false;
	const publish: typeof ui.setWidget = (key, content, options) => setWidget.call(ui, key, content as any, options);
	const render = () => {
		if (disposed) return;
		const width = process.stdout.columns || 102;
		const headroomWidth = headroom ? Math.max(0, ...headroom.lines.map((line) => visibleWidth(line))) : 0;
		const quotaWidth = width - headroomWidth - 2;
		if (headroom && headroomWidth > 0 && quotaWidth >= 40) {
			const quota = renderOmpQuotaLines(ctx, quotaWidth, poolManager);
			const height = Math.max(headroom.lines.length, quota.length);
			const padFrame = (lines: string[]): string[] => {
				if (lines.length >= height || !lines.at(-1)?.startsWith("╰")) return lines;
				const innerWidth = Math.max(0, visibleWidth(lines[0]) - 2);
				const blank = `│${" ".repeat(innerWidth)}│`;
				return [...lines.slice(0, -1), ...Array(height - lines.length).fill(blank), lines.at(-1)!];
			};
			const leftRows = padFrame(headroom.lines);
			const rightRows = padFrame(quota);
			const rows = Array.from({ length: height }, (_, index) => {
				const left = leftRows[index] ?? "";
				const right = rightRows[index] ?? "";
				return `${left}${" ".repeat(Math.max(0, headroomWidth - visibleWidth(left)) + 2)}${right}`;
			});
			if (!headroomHidden) publish("headroom", undefined, headroom.options);
			headroomHidden = true;
			publish("multi-pass-quota", rows, { placement: "aboveEditor" });
		} else {
			if (headroom) publish("headroom", headroom.lines, headroom.options);
			headroomHidden = false;
			publish("multi-pass-quota", renderOmpQuotaLines(ctx, width, poolManager), { placement: "aboveEditor" });
		}
	};
	// OMP shares this UI context between extensions, but only offers vertical
	// widget slots. Capture Headroom's string rows so the two live widgets can
	// share one slot; forward every unrelated widget and restore Headroom on exit.
	const groupedSetWidget: typeof ui.setWidget = (key, content, options) => {
		if (disposed || key !== "headroom") return publish(key, content as any, options);
		if (Array.isArray(content)) {
			headroom = { lines: [...content], options };
		} else {
			headroom = undefined;
			headroomHidden = false;
			publish(key, content as any, options);
		}
		render();
	};
	ui.setWidget = groupedSetWidget;
	const tick = () => {
		updateStatusBarQuota(ctx, render);
		render();
	};
	refreshOmpStatusBar = tick;
	statusBarAccounts = collectStatusBarAccounts(ctx);
	const timer = setInterval(tick, STATUS_BAR_CLOCK_MS);
	// Animation redraws cached quota data; network refresh keeps its own cadence.
	const animationTimer = setInterval(render, OMP_QUOTA_RAINBOW_MS);
	disposeOmpStatusBar = () => {
		disposed = true;
		clearInterval(timer);
		clearInterval(animationTimer);
		if (refreshOmpStatusBar === tick) refreshOmpStatusBar = undefined;
		if (ui.setWidget === groupedSetWidget) ui.setWidget = setWidget;
		if (headroomHidden && headroom) publish("headroom", headroom.lines, headroom.options);
	};
	tick();
}

function applyStatusBar(ctx: ExtensionContext | ExtensionCommandContext, enabled: boolean, poolManager?: PoolManager): void {
	if (!ctx.hasUI) return;
	// OMP's setFooter is a no-op, including in its interactive controller.
	if (isOmp) return applyOmpStatusBar(ctx, enabled, poolManager);
	if (!enabled) {
		ctx.ui.setFooter(undefined);
		return;
	}
	ctx.ui.setFooter((tui, theme, footerData) =>
		createStatusBarComponent(tui, theme, footerData ?? {
			getGitBranch: () => undefined,
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map(),
		} as ReadonlyFooterDataProvider, ctx),
	);
}

// ==========================================================================
// /model interception
//
// pi hardcodes /model in setupEditorSubmitHandler before the extension event
// system fires, so registerCommand("model", ...) and on("input", ...) are
// both too late. The only remaining hook is setEditorComponent: pi copies
// defaultEditor.onSubmit onto the custom editor via plain property
// assignment, so we install a property setter that wraps that handler,
// intercepts /model text, and forwards everything else unchanged.
// ==========================================================================

let modelInterceptContext: ExtensionContext | ExtensionCommandContext | undefined;
let modelInterceptPi: ExtensionAPI | undefined;
let modelInterceptActive = false;

function createModelInterceptEditor(
	tui: any,
	theme: any,
	keybindings: any,
): CustomEditor {
	const editor = new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
	let wrapped: ((text: string) => void) | undefined;
	Object.defineProperty(editor, "onSubmit", {
		configurable: true,
		get() {
			return wrapped;
		},
		set(handler: ((text: string) => void) | undefined) {
			wrapped = handler
				? async (text: string) => {
					const trimmed = text.trim();
					if (trimmed === "/model" || trimmed.startsWith("/model ")) {
						const query = trimmed.startsWith("/model ")
							? trimmed.slice(7).trim() || undefined
							: undefined;
						editor.setText("");
						if (modelInterceptContext && modelInterceptPi) {
							try {
								await handleSubsModel(
									modelInterceptPi,
									modelInterceptContext as ExtensionCommandContext,
									query,
								);
							} catch (error) {
								console.error("multi-pass /model intercept failed", error);
							}
						}
						return;
					}
					handler(text);
				}
				: undefined;
		},
	});
	return editor;
}

function applyModelIntercept(
	ctx: ExtensionContext | ExtensionCommandContext,
	pi: ExtensionAPI,
	enabled: boolean,
): void {
	modelInterceptContext = ctx;
	modelInterceptPi = pi;
	if (!ctx.hasUI) return;
	if (enabled && !modelInterceptActive) {
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			createModelInterceptEditor(tui, theme, keybindings),
		);
		modelInterceptActive = true;
	} else if (!enabled && modelInterceptActive) {
		ctx.ui.setEditorComponent(undefined);
		modelInterceptActive = false;
	}
}

async function handleSubsInterceptModel(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const config = loadGlobalConfig();
	config.interceptModel = !config.interceptModel;
	saveGlobalConfig(config);
	applyModelIntercept(ctx, pi, config.interceptModel);
	ctx.ui.notify(
		config.interceptModel
			? "multi-pass /model intercept enabled (/subs intercept-model to disable)"
			: "multi-pass /model intercept disabled, pi's /model restored",
		"info",
	);
}

async function handleSubsKeeper(ctx: ExtensionCommandContext): Promise<void> {
	if (isOmp) {
		ctx.ui.notify("OMP manages OAuth refresh ownership through its credential store; the Pi token keeper is not needed.", "info");
		return;
	}
	const config = loadGlobalConfig();
	config.tokenKeeper = !config.tokenKeeper;
	saveGlobalConfig(config);
	if (config.tokenKeeper) startTokenKeeper();
	else stopTokenKeeper();
	ctx.ui.notify(
		config.tokenKeeper
			? "multi-pass token keeper enabled: OAuth refreshes run once per machine (/subs keeper to disable)"
			: "multi-pass token keeper disabled, pi refreshes tokens itself again",
		"info",
	);
}

async function handleSubsStatusbar(ctx: ExtensionCommandContext, poolManager: PoolManager): Promise<void> {
	const config = loadGlobalConfig();
	config.statusBar = !config.statusBar;
	saveGlobalConfig(config);
	applyStatusBar(ctx, config.statusBar, poolManager);
	ctx.ui.notify(
		config.statusBar
			? isOmp ? "multi-pass quota widget enabled above the editor (/subs statusbar to disable)" : "multi-pass status bar enabled (/subs statusbar to disable)"
			: isOmp ? "multi-pass quota widget disabled" : "multi-pass status bar disabled, default footer restored",
		"info",
	);
}

// ==========================================================================
// Extension entry point
// ==========================================================================

export default function multiSub(pi: ExtensionAPI) {
	startTokenKeeper();

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	// Register all subscriptions (always global)
	for (const entry of all) {
		registerSub(pi, entry);
	}

	// Initialize pool manager with global pools (updated on session_start with project config)
	const poolManager = new PoolManager(pi);
	poolManager.loadPools(config.pools);

	let projectRestrictionSwitchInFlight = false;
	const enforceProjectRestriction = async (
		ctx: ExtensionContext | ExtensionCommandContext,
		reason: "session" | "model" | "input",
	): Promise<boolean> => {
		if (projectRestrictionSwitchInFlight) return true;
		const effective = loadEffectiveConfig(ctx.cwd);
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (!allowedSummary) {
			return true;
		}
		if (ctx.model && effective.allowedProviderNames?.includes(ctx.model.provider)) {
			return true;
		}

		for (const providerName of getProjectScopedProviderNames(ctx, effective)) {
			const model = findSelectableModelForProvider(ctx, providerName, ctx.model?.id);
			if (!model) continue;

			projectRestrictionSwitchInFlight = true;
			try {
				const success = await pi.setModel(model);
				if (!success) continue;
				const displayName = getProviderDisplayName(providerName, effective.subscriptions);
				ctx.ui.notify(
					`multi-pass: project restricted to ${allowedSummary}; switched to ${displayName} (${model.id}).`,
					"info",
				);
				return true;
			} finally {
				projectRestrictionSwitchInFlight = false;
			}
		}

		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current model";
		ctx.ui.notify(
			`multi-pass: project restricted to ${allowedSummary}, but no authenticated allowed provider can serve ${currentModel}.`,
			"warning",
		);
		return false;
	};

	// On session start, reload pools with project-level config
	pi.on("session_start", async (_event, ctx) => {
		setModelRegistry(ctx.modelRegistry);
		const effective = loadEffectiveConfig(ctx.cwd);
		poolManager.loadPools(effective.pools);
		poolManager.clearCascadeState();
		poolManager.resetStartupSelection();
		poolManager.resetUsage();

		const statusParts: string[] = [];
		const enabledChains = effective.chains.filter((chain) => chain.enabled);
		const activeChain = enabledChains[0];
		if (activeChain) {
			const firstEnabledEntry = activeChain.entries.find((entry) => entry.enabled);
			if (firstEnabledEntry) {
				statusParts.push(`chain:${activeChain.name} | starts ${firstEnabledEntry.pool} -> ${firstEnabledEntry.model}`);
			}
		}
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (allowedSummary) {
			statusParts.push(`allowed ${allowedSummary}`);
		} else {
			const poolCount = effective.pools.filter((p) => p.enabled).length;
			if (poolCount > 0 && !activeChain) {
				statusParts.push(`${poolCount} pool(s)`);
			}
		}
		if (statusParts.length > 0) {
			ctx.ui.setStatus("multi-pass", statusParts.join(" | "));
		}

		await enforceProjectRestriction(ctx, "session");
		await poolManager.selectStartupMember(ctx);

		const persisted = loadGlobalConfig();
		if (persisted.statusBar || isOmp) applyStatusBar(ctx, persisted.statusBar === true, poolManager);
		applyModelIntercept(ctx, pi, persisted.interceptModel === true);
	});

	pi.on("model_select", async (_event, ctx) => {
		await enforceProjectRestriction(ctx, "model");
		refreshOmpStatusBar?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (isOmp && ctx.hasUI) applyOmpStatusBar(ctx, false);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = (event as any).message;
		if (message?.role !== "assistant") return;
		const provider = typeof message.provider === "string" ? message.provider : ctx.model?.provider;
		if (provider) poolManager.recordUsage(provider, message);
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trimStart().startsWith("/")) {
			return { action: "continue" as const };
		}
		const ok = await enforceProjectRestriction(ctx, "input");
		return ok ? { action: "continue" as const } : { action: "handled" as const };
	});

	// Track last user prompt for retry on rotation
	let lastUserPrompt: string | null = null;

	// Listen for user input to track last prompt
	pi.on("before_agent_start", async (event, ctx) => {
		await poolManager.selectStartupMember(ctx);
		const newTurn = await poolManager.startTurn(event.prompt, ctx.model, ctx);
		if (newTurn) lastUserPrompt = event.prompt;
		refreshOmpStatusBar?.();
	});

	// Cancelling or exhausting host retries ends the pending continuation.
	pi.on("auto_retry_end", async (event, ctx) => {
		if (!event.success) {
			poolManager.clearCascadeState();
		}
	});

	// Listen for errors to trigger pool rotation
	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		refreshOmpStatusBar?.();
		const willContinue = (event as AgentEndEvent & { willContinue?: boolean }).willContinue === true;
		if (willContinue) poolManager.continueTurn();
		const finishTurn = () => {
			if (!willContinue) {
				poolManager.clearCascadeState();
			}
		};
		if (!event.messages || event.messages.length === 0) {
			finishTurn();
			return;
		}

		const lastMsg = event.messages[event.messages.length - 1];
		if (!lastMsg || lastMsg.role !== "assistant") {
			finishTurn();
			return;
		}

		const assistantMsg = lastMsg as any;
		const providerName = ctx.model?.provider;
		if (assistantMsg.stopReason !== "error") {
			if (providerName) providersRequiringReauthentication.delete(providerName);
			finishTurn();
			return;
		}
		if (!assistantMsg.errorMessage) {
			finishTurn();
			return;
		}

		const effective = loadEffectiveConfig(ctx.cwd);
		if (
			providerName &&
			isTerminalOAuthRefreshError(assistantMsg.errorMessage) &&
			effective.subscriptions.some((entry) => subProviderName(entry) === providerName) &&
			getAuthStorage(ctx).get(providerName)?.type === "oauth"
		) {
			providersRequiringReauthentication.add(providerName);
			ctx.ui.notify(
				`${getProviderDisplayName(providerName, effective.subscriptions)} needs reauthentication. Run /subs login to replace the rejected credential.`,
				"warning",
			);
		}

		const rotated = await poolManager.handleError(
			assistantMsg.errorMessage,
			ctx.model,
			ctx,
			lastUserPrompt,
			normalizeMultiPassConfig({
				subscriptions: effective.subscriptions,
				pools: effective.pools,
				chains: effective.chains,
				presets: effective.presets,
			}),
			isOmp ? (event as AgentEndEvent & { willContinue?: boolean }).willContinue === true : undefined,
			knownQuotaResetAt(ctx, ctx.model?.provider),
		);

		if (!rotated && !(isOmp ? willContinue : piWillRetryTurn(assistantMsg.errorMessage))) {
			finishTurn();
		} else if (!rotated) {
			poolManager.continueTurn();
		}
		if (!rotated && isRateLimitError(assistantMsg.errorMessage)) {
			const pool = ctx.model
				? poolManager.getPoolForProvider(ctx.model.provider)
				: undefined;
			if (pool) {
				const available = poolManager.getAvailableMembers(
					pool,
					getAuthStorage(ctx),
				);
				if (available.length === 0) {
					ctx.ui.notify(
						`[pool:${pool.name}] All members rate limited. Try again in a few minutes.`,
						"warning",
					);
				}
			}
		}
	});

	// Register /subs command
	pi.registerCommand("subs", {
		description: "Manage extra OAuth subscriptions",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "switch", "model", "status", "doctor", "stats", "limits", "share", "receive", "statusbar", "intercept-model", "keeper"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = loadGlobalConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "list":
				case "ls":
					return handleSubsList(pi, ctx, config, poolManager);
				case "add":
				case "new":
					return handleSubsAdd(pi, ctx);
				case "remove":
				case "rm":
				case "delete":
					return handleSubsRemove(pi, ctx, poolManager);
				case "login":
					return handleSubsLogin(ctx);
				case "logout":
					return handleSubsLogout(ctx);
				case "switch":
					return handleSubsSwitch(pi, ctx, rest || undefined);
				case "model":
				case "m":
					return handleSubsModel(pi, ctx, rest || undefined);
				case "status":
				case "info":
					return handleSubsStatus(ctx);
				case "doctor":
					return handleSubsDoctor(ctx);
				case "stats":
					return handleSubsStats(ctx, poolManager);
				case "limits":
				case "quota":
				case "usage":
					return handleSubsLimits(ctx);
				case "share":
					return handleSubsShare(ctx);
				case "receive":
					return handleSubsReceive(ctx);
				case "statusbar":
				case "bar":
					return handleSubsStatusbar(ctx, poolManager);
				case "keeper":
				case "tokenkeeper":
					return handleSubsKeeper(ctx);
				case "intercept-model":
				case "intercept":
					return handleSubsInterceptModel(ctx, pi);
				default:
					return handleSubsMenu(pi, ctx, poolManager);
			}
		},
	});

	// Register /pool command
	pi.registerCommand("pool", {
		description: "Manage subscription rotation pools",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["create", "list", "chain", "toggle", "remove", "status", "trace", "preview", "weights", "project"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);
			const subcommand = parts[0] || "";
			const chainSubcommand = parts[1] || "";
			const traceSubcommand = parts[1] || "";
			switch (subcommand) {
				case "create":
				case "new":
					return handlePoolCreate(ctx, poolManager);
				case "list":
				case "ls":
					return handlePoolList(ctx, poolManager);
				case "chain":
					switch (chainSubcommand) {
						case "":
							return handlePoolChainMenu(ctx, poolManager);
						case "list":
						case "ls":
							return handlePoolChainList(ctx, poolManager);
						case "toggle":
							return handlePoolChainToggle(ctx);
						case "remove":
						case "rm":
						case "delete":
							return handlePoolChainRemove(ctx);
						case "status":
						case "info":
							return handlePoolChainStatus(ctx, poolManager);
						case "create":
						case "new":
							return handlePoolChainCreate(ctx, poolManager);
						default:
							return handlePoolChainMenu(ctx, poolManager);
					}
				case "toggle":
					return handlePoolToggle(ctx, poolManager);
				case "remove":
				case "rm":
				case "delete":
					return handlePoolRemove(ctx, poolManager);
				case "status":
				case "info":
					return handlePoolStatus(ctx, poolManager);
				case "trace":
					return handlePoolTrace(ctx, poolManager, traceSubcommand || undefined);
				case "preview":
					return handlePoolPreview(ctx, poolManager);
				case "weights":
					return handlePoolWeights(ctx, poolManager);
				case "project":
					return handlePoolProject(ctx, poolManager);
				default:
					return handlePoolMenu(ctx, poolManager);
			}
		},
	});

	// Register /mp-preset command (namespaced to avoid collision with pi's built-in /preset)
	pi.registerCommand("mp-preset", {
		description: "Manage multi-pass model presets (named routing shortcuts across providers)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["activate", "create", "list", "toggle", "remove"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			if (filtered.length > 0) {
				return filtered.map((s) => ({ value: s, label: s }));
			}
			// Also complete preset names for quick activation
			const config = loadGlobalConfig();
			const presetNames = config.presets
				.filter((p) => p.enabled && p.name.startsWith(prefix))
				.map((p) => ({ value: p.name, label: p.name }));
			return presetNames.length > 0 ? presetNames : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "activate":
				case "use":
					return handlePresetActivate(pi, ctx, rest || undefined);
				case "create":
				case "new":
					return handlePresetCreate(ctx);
				case "list":
				case "ls":
					return handlePresetList(ctx);
				case "toggle":
					return handlePresetToggle(ctx);
				case "remove":
				case "rm":
				case "delete":
					return handlePresetRemove(ctx);
				default:
					// If the argument matches a preset name, activate it directly
					if (subcommand) {
						const config = loadGlobalConfig();
						const preset = config.presets.find(
							(p) => p.name.toLowerCase() === subcommand && p.enabled,
						);
						if (preset) {
							return handlePresetActivate(pi, ctx, preset.name);
						}
					}
					return handlePresetMenu(pi, ctx);
			}
		},
	});
}
