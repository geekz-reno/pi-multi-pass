/** Host-owned modules: OMP remaps the historical Pi scope to its bundled API. */
import * as agent from "@earendil-works/pi-coding-agent";

export const { BorderedLoader, CustomEditor, DynamicBorder, getAgentDir, keyHint } = agent;
export type CustomEditor = InstanceType<typeof agent.CustomEditor>;
export const isOmp = typeof (agent as any).discoverAuthStorage === "function";
export const projectConfigDir = isOmp ? ".omp" : ".pi";

// Keep the Pi-only providers/all entry out of OMP's module graph.
const runtime = isOmp ? await import("./host-omp.ts") : await import("./host-pi.ts");
export const { builtinProviders, getModels, readStoredCredential, oauthProvider, setModelRegistry } = runtime;
export const ompAuth = isOmp ? runtime.ompAuth : undefined;
