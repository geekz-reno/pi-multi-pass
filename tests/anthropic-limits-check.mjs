import assert from "node:assert/strict";

// Mirrors parseAnthropicUsageSnapshot / classifyAnthropicQuotaKind in
// extensions/multi-sub.ts (anthropic oauth usage endpoint).

function getRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function parseIsoTimestampSeconds(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

function normalizeAnthropicUsageWindow(label, raw) {
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

function parseAnthropicUsageSnapshot(data) {
  const raw = getRecord(data);
  const windows = [
    normalizeAnthropicUsageWindow("5h", raw?.five_hour),
    normalizeAnthropicUsageWindow("7d", raw?.seven_day),
  ].filter(Boolean);

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

function classifyAnthropicQuotaKind(snapshot) {
  if (snapshot.windows.length === 0) return { kind: "error", score: 0 };
  const bottleneck = Math.min(...snapshot.windows.map((window) => window.remainingPercent));
  if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

// --- fixtures (shape from api.anthropic.com/api/oauth/usage) ---------------

const usageFixture = {
  five_hour: { utilization: 24.0, resets_at: "2026-10-12T21:59:59.826028+00:00" },
  seven_day: { utilization: 59.0, resets_at: "2026-10-14T20:59:59.826063+00:00" },
  seven_day_opus: null,
  limits: [
    { kind: "session", group: "session", percent: 24, resets_at: "2026-10-12T21:59:59.826028+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 59, resets_at: "2026-10-14T20:59:59.826063+00:00", scope: null },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 84,
      severity: "warning",
      resets_at: "2026-10-14T20:59:59.826439+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

{
  const snapshot = parseAnthropicUsageSnapshot(usageFixture);
  assert.equal(snapshot.windows.length, 3, "expected 5h + 7d + scoped windows");

  const [fiveHour, weekly, scoped] = snapshot.windows;
  assert.equal(fiveHour.label, "5h");
  assert.equal(fiveHour.remainingPercent, 76);
  assert.equal(fiveHour.resetAt, Math.floor(Date.parse(usageFixture.five_hour.resets_at) / 1000));

  assert.equal(weekly.label, "7d");
  assert.equal(weekly.remainingPercent, 41);

  assert.equal(scoped.label, "7d Fable");
  assert.equal(scoped.remainingPercent, 16);

  const classification = classifyAnthropicQuotaKind(snapshot);
  assert.equal(classification.kind, "watch", "16% scoped bottleneck lands in the watch band");
  assert.equal(classification.score, 16);
}

{
  // Session window exhausted -> blocked
  const snapshot = parseAnthropicUsageSnapshot({
    five_hour: { utilization: 97.5, resets_at: "2026-10-12T21:59:59Z" },
    seven_day: { utilization: 59.0, resets_at: "2026-10-14T20:59:59Z" },
  });
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0].remainingPercent, 2.5);
  assert.equal(classifyAnthropicQuotaKind(snapshot).kind, "blocked");
}

{
  // Clamping and malformed limits entries
  const snapshot = parseAnthropicUsageSnapshot({
    five_hour: { utilization: 150 },
    limits: [
      { kind: "weekly_scoped", percent: "not-a-number" },
      { kind: "weekly_scoped", percent: 10, scope: {} },
      "garbage",
    ],
  });
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0].remainingPercent, 0, "utilization above 100 clamps to 0 remaining");
  assert.equal(snapshot.windows[1].label, "7d scoped", "missing display_name falls back to scoped");
  assert.equal(snapshot.windows[1].remainingPercent, 90);
}

{
  // No usable windows -> error
  const snapshot = parseAnthropicUsageSnapshot({});
  assert.equal(classifyAnthropicQuotaKind(snapshot).kind, "error");
}

console.log("anthropic-limits-check: all assertions passed");
