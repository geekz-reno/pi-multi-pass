/** Dependency-free routing diagnostics and accounting shared by the host adapters. */
export interface RoutingDiagnostic {
	level: "error" | "warning";
	path: string;
	message: string;
}

export interface RoutingDiagnosticOptions {
	project?: boolean;
	knownProviders?: readonly string[];
	modelsByProvider?: Readonly<Record<string, readonly string[]>>;
	inheritedPools?: readonly { name: string; baseProvider?: string; members?: readonly string[] }[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Inspect raw JSON before normalization can hide malformed fields. Never changes it. */
export function validateRoutingConfig(raw: unknown, options: RoutingDiagnosticOptions = {}): RoutingDiagnostic[] {
	const issues: RoutingDiagnostic[] = [];
	const add = (path: string, message: string, level: RoutingDiagnostic["level"] = "error") => issues.push({ level, path, message });
	if (!record(raw)) {
		add("$", "Expected a JSON object. Restore the config backup or correct this file.");
		return issues;
	}
	const array = (key: string): unknown[] => {
		if (raw[key] === undefined) return [];
		if (!Array.isArray(raw[key])) {
			add(key, "Expected an array.");
			return [];
		}
		return raw[key] as unknown[];
	};
	const providers = options.knownProviders && new Set(options.knownProviders);
	const bases = new Map<string, string>();
	for (const provider of options.knownProviders ?? []) {
		const base = provider.match(/^(.+)-\d+$/)?.[1];
		bases.set(provider, base && providers?.has(base) ? base : provider);
	}
	const subscriptionAccounts = new Set<string>();
	const provider = (value: unknown, path: string) => {
		if (!nonempty(value)) add(path, "Expected a nonempty provider name.");
		else if (providers && !providers.has(value)) add(path, `Unknown provider "${value}". Check the host catalog or add this subscription.`);
	};
	const model = (value: unknown, providerName: unknown, path: string) => {
		if (!nonempty(value)) return add(path, "Expected a nonempty model ID.");
		if (!nonempty(providerName) || !options.modelsByProvider) return;
		const catalog = options.modelsByProvider[providerName] ?? options.modelsByProvider[bases.get(providerName) ?? ""];
		if (catalog && !catalog.includes(value)) add(path, `Model "${value}" is unavailable for ${providerName}. Refresh the catalog or choose another model.`);
	};
	const named = (items: unknown[], key: string): Map<string, Record<string, unknown>> => {
		const names = new Map<string, Record<string, unknown>>();
		items.forEach((item, index) => {
			const path = `${key}[${index}]`;
			if (!record(item)) return add(path, "Expected an object.");
			if (!nonempty(item.name)) add(`${path}.name`, "Expected a nonempty name.");
			else if (names.has(item.name)) add(`${path}.name`, `Duplicate name "${item.name}".`);
			else names.set(item.name, item);
			if (item.enabled !== undefined && typeof item.enabled !== "boolean") add(`${path}.enabled`, "Expected true or false.");
		});
		return names;
	};

	array("subscriptions").forEach((entry, index) => {
		const path = `subscriptions[${index}]`;
		if (!record(entry)) return add(path, "Expected an object.");
		provider(entry.provider, `${path}.provider`);
		if (entry.index !== undefined && (!Number.isInteger(entry.index) || Number(entry.index) < 0)) add(`${path}.index`, "Expected a nonnegative integer subscription index.");
		if (entry.label !== undefined && typeof entry.label !== "string") add(`${path}.label`, "Expected a string label.");
		if (nonempty(entry.provider) && Number.isInteger(entry.index) && Number(entry.index) > 0) {
			const account = `${entry.provider}-${entry.index}`;
			if (subscriptionAccounts.has(account)) add(path, `Duplicate subscription "${account}".`);
			subscriptionAccounts.add(account);
			providers?.add(account);
			bases.set(account, entry.provider);
		}
	});
	for (const key of ["statusBar", "interceptModel", "tokenKeeper"]) {
		if (raw[key] !== undefined && typeof raw[key] !== "boolean") add(key, "Expected true or false.");
	}
	array("allowedSubs").forEach((value, index) => provider(value, `allowedSubs[${index}]`));
	if (Array.isArray(raw.allowedSubs) && raw.allowedSubs.length === 0) add("allowedSubs", "An empty list allows all providers; add exact account names to restrict this project.", "warning");

	const poolItems = array("pools");
	const pools = named(poolItems, "pools");
	if (options.project && raw.pools === undefined) {
		for (const pool of options.inheritedPools ?? []) pools.set(pool.name, { ...pool });
	}
	poolItems.forEach((pool, index) => {
		if (!record(pool)) return;
		const path = `pools[${index}]`;
		provider(pool.baseProvider, `${path}.baseProvider`);
		if (!Array.isArray(pool.members) || pool.members.length === 0) add(`${path}.members`, "Choose at least one provider account.");
		const members = new Set<string>();
		for (const [memberIndex, member] of (Array.isArray(pool.members) ? pool.members : []).entries()) {
			provider(member, `${path}.members[${memberIndex}]`);
			if (!nonempty(member)) continue;
			if (members.has(member)) add(`${path}.members[${memberIndex}]`, `Duplicate pool member "${member}".`);
			members.add(member);
			const base = bases.get(member);
			if (base && nonempty(pool.baseProvider) && base !== pool.baseProvider && member !== pool.baseProvider) add(`${path}.members[${memberIndex}]`, `Account "${member}" belongs to ${base}, not ${pool.baseProvider}.`);
		}
		if (pool.strategy !== undefined && !["round-robin", "per-turn", "quota-first", "scheduled", "custom", "weighted"].includes(String(pool.strategy))) add(`${path}.strategy`, "Use round-robin, per-turn, quota-first, scheduled, custom, or weighted.");
		if (pool.strategy === "custom" && !nonempty(pool.selectorScript)) add(`${path}.selectorScript`, "Custom routing needs a selector script path.");
		if (pool.memberWeights !== undefined) {
			if (!record(pool.memberWeights)) add(`${path}.memberWeights`, "Expected an object mapping account names to positive weights.");
			else for (const [member, weight] of Object.entries(pool.memberWeights)) {
				if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) add(`${path}.memberWeights.${member}`, "Weights must be finite numbers greater than zero.");
				if (!members.has(member)) add(`${path}.memberWeights.${member}`, "This weighted account is not a member of the pool.", "warning");
			}
		}
		if (pool.memberSchedule !== undefined) {
			if (!record(pool.memberSchedule)) add(`${path}.memberSchedule`, "Expected an object mapping pool members to schedules.");
			else for (const [member, schedule] of Object.entries(pool.memberSchedule)) {
				const schedulePath = `${path}.memberSchedule.${member}`;
				if (!members.has(member)) add(schedulePath, "This scheduled account is not a member of the pool.", "warning");
				if (!record(schedule)) { add(schedulePath, "Expected a schedule object."); continue; }
				if (schedule.role !== undefined && !["preferred", "default", "overflow"].includes(String(schedule.role))) add(`${schedulePath}.role`, "Use preferred, default, or overflow.");
				if (schedule.windows !== undefined && !Array.isArray(schedule.windows)) add(`${schedulePath}.windows`, "Expected an array of schedule windows.");
				for (const [windowIndex, window] of (Array.isArray(schedule.windows) ? schedule.windows : []).entries()) {
					const windowPath = `${schedulePath}.windows[${windowIndex}]`;
					if (!record(window)) { add(windowPath, "Expected a schedule window object."); continue; }
					if (window.hours !== undefined && (!Array.isArray(window.hours) || window.hours.length !== 2 || !window.hours.every(Number.isInteger) || window.hours[0] < 0 || window.hours[0] > 23 || window.hours[1] < 0 || window.hours[1] > 24)) add(`${windowPath}.hours`, "Use [start, end] hours: start 0–23 and end 0–24. Overnight ranges are allowed.");
					if (window.days !== undefined && (!Array.isArray(window.days) || !window.days.every((day) => ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(day)))) add(`${windowPath}.days`, "Use weekday names mon through sun.");
					if (window.dateRange !== undefined) {
						if (!record(window.dateRange)) add(`${windowPath}.dateRange`, "Expected an object with optional from/to dates.");
						else {
							for (const key of ["from", "to"]) {
								const value = window.dateRange[key];
								if (value !== undefined && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) add(`${windowPath}.dateRange.${key}`, "Use a valid YYYY-MM-DD date.");
							}
							if (typeof window.dateRange.from === "string" && typeof window.dateRange.to === "string" && window.dateRange.from > window.dateRange.to) add(`${windowPath}.dateRange`, "The from date must be on or before the to date.");
						}
					}
				}
			}
		}
	});
	for (const key of ["chains", "presets"] as const) {
		const items = array(key);
		named(items, key);
		items.forEach((item, index) => {
			if (!record(item)) return;
			const path = `${key}[${index}]`;
			if (!Array.isArray(item.entries) || item.entries.length === 0) { add(`${path}.entries`, "Choose at least one routing entry."); return; }
			item.entries.forEach((entry, entryIndex) => {
				const entryPath = `${path}.entries[${entryIndex}]`;
				if (!record(entry)) return add(entryPath, "Expected a routing entry object.");
				if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") add(`${entryPath}.enabled`, "Expected true or false.");
				if (key === "chains") {
					if (!nonempty(entry.pool) || !pools.has(entry.pool)) add(`${entryPath}.pool`, `Pool "${String(entry.pool)}" is missing. Create it or update this chain.`);
					else model(entry.model, pools.get(entry.pool)?.baseProvider, `${entryPath}.model`);
				} else {
					provider(entry.provider, `${entryPath}.provider`);
					model(entry.model, entry.provider, `${entryPath}.model`);
				}
			});
		});
	}
	return issues;
}

function finiteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
}

/** Prefer all explicit provider hints; a later known quota reset is never shortened. */
export function parseCooldownMs(error: string, nowMs: number, fallbackMs = 300_000, resetAtSeconds?: number): number {
	const now = Number.isFinite(nowMs) ? nowMs : Date.now();
	const delays: number[] = [];
	const add = (delay: number) => { if (Number.isFinite(delay) && delay >= 0) delays.push(Math.max(1_000, delay)); };
	const reset = (value: string | number) => {
		const numeric = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
		const timestamp = Number.isFinite(numeric) ? numeric > 1e12 ? numeric : numeric * 1_000 : Date.parse(String(value));
		if (timestamp > now) add(timestamp - now);
	};
	for (const match of String(error).matchAll(/["']?(retry[-_ ]?after|reset_at|resets_at|resetAt)["']?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^,\r\n}\s]+))/gi)) {
		const value = (match[2] ?? match[3] ?? match[4]).trim();
		if (/^retry/i.test(match[1]) && /^\d+(?:\.\d+)?$/.test(value)) add(Number(value) * 1_000);
		else reset(value);
	}
	for (const match of String(error).matchAll(/retry[-_ ]?after\s*:\s*([A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/gi)) reset(match[1]);
	if (delays.length === 0) {
		const prose = String(error).match(/(?:retry|try\s+again|reset)(?:\s+again)?\s+(?:in|after)\s+([\d\s.a-z]+)/i)?.[1];
		if (prose) {
			let duration = 0;
			let end = 0;
			for (const part of prose.matchAll(/(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/gi)) {
				if (!/^[\s,]*(?:and[\s,]*)?$/i.test(prose.slice(end, part.index))) break;
				const unit = part[2].toLowerCase();
				const scale = unit === "ms" || unit.startsWith("millisecond") ? 1 : unit.startsWith("s") ? 1_000 : unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
				duration += Number(part[1]) * scale;
				end = part.index + part[0].length;
			}
			if (duration > 0) add(duration);
			else if (/^\d+(?:\.\d+)?\s*$/.test(prose)) add(Number(prose) * 1_000);
		}
	}
	if (typeof resetAtSeconds === "number" && Number.isFinite(resetAtSeconds)) reset(resetAtSeconds);
	if (delays.length) return Math.min(Number.MAX_SAFE_INTEGER - Math.max(0, now), Math.max(...delays));
	return Math.max(1_000, Math.min(7 * 86_400_000, Number.isFinite(fallbackMs) ? fallbackMs : 300_000));
}

export interface AccountUsage {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/** Add one finalized provider request. Host input excludes cache reads/writes. */
export function addUsage(existing: Partial<AccountUsage> | undefined, normalizedUsage: unknown): AccountUsage {
	const usage = record(normalizedUsage) ? normalizedUsage : {};
	const input = typeof usage.inputTokens === "number" ? finiteCount(usage.inputTokens)
		: typeof usage.input === "number" ? finiteCount(usage.input) + finiteCount(usage.cacheRead) + finiteCount(usage.cacheWrite)
			: finiteCount(usage.input_tokens);
	const output = finiteCount(usage.outputTokens ?? usage.output ?? usage.output_tokens);
	const total = Math.max(input + output, finiteCount(usage.totalTokens ?? usage.total_tokens));
	const sum = (left: unknown, right: number) => Math.min(Number.MAX_SAFE_INTEGER, finiteCount(left) + right);
	return {
		requests: sum(existing?.requests, 1),
		inputTokens: sum(existing?.inputTokens, input),
		outputTokens: sum(existing?.outputTokens, output),
		totalTokens: sum(existing?.totalTokens, total),
	};
}

/** Opt-in weighted request balancing; ties preserve round-robin order. */
export function weightedNextMember(
	members: readonly string[],
	current: string,
	usable: readonly string[],
	weights: Readonly<Record<string, number>> = {},
	usage: Readonly<Record<string, Partial<AccountUsage>>> = {},
): string | undefined {
	const available = new Set(usable);
	const start = members.indexOf(current);
	let best: string | undefined;
	let score = Infinity;
	for (let step = 1; step <= members.length; step++) {
		const member = members[(Math.max(-1, start) + step) % members.length];
		if (!available.has(member)) continue;
		const weight = Object.hasOwn(weights, member) ? weights[member] : 1;
		if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) continue;
		const nextScore = finiteCount(usage[member]?.requests) / weight;
		if (best === undefined || nextScore < score) { best = member; score = nextScore; }
	}
	return best;
}
