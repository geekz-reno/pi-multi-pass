/** OMP 18.x uses its native registry and broker-aware credential store. */
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";

// A single discovery shares OMP's SQLite/broker semantics; no auth.json mirror.
export const ompAuth = await discoverAuthStorage();
let modelRegistry: { getAll(): any[] } | undefined;
export function setModelRegistry(registry: typeof modelRegistry): void { modelRegistry = registry; }
export function getModels(provider: string): any[] {
	const live = modelRegistry?.getAll().filter(model => model.provider === provider);
	return live?.length ? live : getBundledModels(provider as any);
}
export const readStoredCredential = (provider: string) => ompAuth.credentials.get(provider);
export const builtinProviders = () => [];

export function oauthProvider(provider: string) {
	const definition = getProviderDefinition(provider);
	if (!definition?.login) throw new Error(`No built-in OAuth flow available for provider "${provider}"`);
	return {
		login: definition.login as (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
		refreshToken: definition.refreshToken ?? (async (credential: OAuthCredentials) => credential),
		getApiKey(credential: OAuthCredentials): string {
			if (authPolicyFor(provider)?.apiKeyFormat !== "structured") return credential.access;
			return JSON.stringify({
				token: credential.access, refreshToken: credential.refresh,
				expiresAt: credential.expires, projectId: credential.projectId,
				accountId: credential.accountId, enterpriseUrl: credential.enterpriseUrl,
				apiEndpoint: credential.apiEndpoint, email: credential.email,
			});
		},
	};
}
