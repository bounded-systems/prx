import { z } from "zod";

export const usagePhases = ["ok", "warning", "critical", "blocked", "unknown"] as const;
export type UsagePhase = (typeof usagePhases)[number];

export const usageSurfaces = ["claude_ai", "claude_code", "claude_desktop", "api"] as const;
export type UsageSurface = (typeof usageSurfaces)[number];

export const usageModels = ["opus", "sonnet", "haiku", "other"] as const;
export type UsageModel = (typeof usageModels)[number];

export const usagePlanTiers = [
  "free",
  "pro",
  "max",
  "team",
  "enterprise",
  "api",
  "unknown",
] as const;
export type UsagePlanTier = (typeof usagePlanTiers)[number];

export const usageSources = ["settings_page", "manual", "headers", "unknown"] as const;
export type UsageSource = (typeof usageSources)[number];

export const usageDimensions = [
  "session",
  "weekly",
  "capacity",
  "api_rpm",
  "api_itpm",
  "api_otpm",
] as const;
export type UsageDimension = (typeof usageDimensions)[number];

export const USAGE_PHASE_THRESHOLDS = { warning: 0.75, critical: 0.9, blocked: 1.0 } as const;

const rfc3339String = z.string().datetime({ offset: true });

const rateLimitBucketSchema = z
  .object({
    limit: z.number().int().min(0).nullable(),
    remaining: z.number().int().min(0).nullable(),
    resetAt: rfc3339String.nullable(),
  })
  .strict();

export const usageStateV1Schema = z
  .object({
    kind: z.literal("UsageStateV1"),

    session: z
      .object({
        startedAt: rfc3339String.nullable(),
        resetAt: rfc3339String.nullable(),
        usedFraction: z.number().min(0).max(1).nullable(),
        source: z.enum(usageSources),
      })
      .strict(),

    weekly: z.array(
      z
        .object({
          model: z.enum(usageModels),
          resetAt: rfc3339String.nullable(),
          usedFraction: z.number().min(0).max(1).nullable(),
          source: z.enum(usageSources),
        })
        .strict(),
    ),

    capacity: z
      .object({
        contextWindowTokens: z.union([z.literal(200_000), z.literal(500_000)]).nullable(),
        currentConversationTokens: z.number().int().min(0).nullable(),
        autoSummarizeEnabled: z.boolean().nullable(),
      })
      .strict(),

    apiRateLimits: z.array(
      z
        .object({
          tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
          model: z.enum(usageModels),
          rpm: rateLimitBucketSchema,
          itpm: rateLimitBucketSchema,
          otpm: rateLimitBucketSchema,
        })
        .strict(),
    ),

    derived: z
      .object({
        phase: z.enum(usagePhases),
        mostConstrainedDimension: z.enum(usageDimensions).nullable(),
        nearestResetAt: rfc3339String.nullable(),
      })
      .strict(),

    meta: z
      .object({
        observedAt: rfc3339String.nullable(),
        surfaces: z.array(z.enum(usageSurfaces)),
        planTier: z.enum(usagePlanTiers),
      })
      .strict(),
  })
  .strict();

export type UsageStateV1 = z.infer<typeof usageStateV1Schema>;

type UsageRawInput = Pick<UsageStateV1, "session" | "weekly" | "capacity" | "apiRateLimits">;

type DimensionFraction = { dimension: UsageDimension; fraction: number };

function collectDimensionFractions(raw: UsageRawInput): DimensionFraction[] {
  const entries: DimensionFraction[] = [];

  if (raw.session.usedFraction !== null) {
    entries.push({ dimension: "session", fraction: raw.session.usedFraction });
  }

  for (const weekly of raw.weekly) {
    if (weekly.usedFraction !== null) {
      entries.push({ dimension: "weekly", fraction: weekly.usedFraction });
    }
  }

  const { contextWindowTokens, currentConversationTokens } = raw.capacity;
  if (
    contextWindowTokens !== null &&
    currentConversationTokens !== null &&
    contextWindowTokens > 0
  ) {
    entries.push({
      dimension: "capacity",
      fraction: currentConversationTokens / contextWindowTokens,
    });
  }

  for (const api of raw.apiRateLimits) {
    for (const [key, dim] of [
      ["rpm", "api_rpm"],
      ["itpm", "api_itpm"],
      ["otpm", "api_otpm"],
    ] as const) {
      const bucket = api[key];
      if (bucket.limit !== null && bucket.remaining !== null && bucket.limit > 0) {
        const used = Math.max(0, bucket.limit - bucket.remaining);
        entries.push({ dimension: dim, fraction: used / bucket.limit });
      }
    }
  }

  return entries;
}

function hasZeroRemainingRateLimit(raw: UsageRawInput): boolean {
  for (const api of raw.apiRateLimits) {
    if (api.rpm.remaining === 0 || api.itpm.remaining === 0 || api.otpm.remaining === 0) {
      return true;
    }
  }
  return false;
}

export function deriveUsagePhase(raw: UsageRawInput): UsagePhase {
  const fractions = collectDimensionFractions(raw);
  const zeroRemaining = hasZeroRemainingRateLimit(raw);

  if (fractions.length === 0 && !zeroRemaining) {
    return "unknown";
  }

  const max = fractions.reduce((acc, entry) => Math.max(acc, entry.fraction), 0);

  if (zeroRemaining || max >= USAGE_PHASE_THRESHOLDS.blocked) return "blocked";
  if (max >= USAGE_PHASE_THRESHOLDS.critical) return "critical";
  if (max >= USAGE_PHASE_THRESHOLDS.warning) return "warning";
  return "ok";
}

export function deriveMostConstrainedDimension(raw: UsageRawInput): UsageDimension | null {
  const fractions = collectDimensionFractions(raw);

  // Rate-limit buckets with `remaining === 0` are fully consumed even if limit
  // fields are missing — synthesize a fraction of 1 so they outrank everything.
  for (const api of raw.apiRateLimits) {
    for (const [key, dim] of [
      ["rpm", "api_rpm"],
      ["itpm", "api_itpm"],
      ["otpm", "api_otpm"],
    ] as const) {
      const bucket = api[key];
      if (bucket.remaining === 0 && (bucket.limit === null || bucket.limit === 0)) {
        fractions.push({ dimension: dim, fraction: 1 });
      }
    }
  }

  if (fractions.length === 0) return null;

  let best = fractions[0]!;
  for (const entry of fractions.slice(1)) {
    if (entry.fraction > best.fraction) best = entry;
  }
  return best.dimension;
}

export function deriveNearestResetAt(raw: UsageRawInput): string | null {
  const candidates: string[] = [];

  if (raw.session.resetAt !== null) candidates.push(raw.session.resetAt);
  for (const weekly of raw.weekly) {
    if (weekly.resetAt !== null) candidates.push(weekly.resetAt);
  }
  for (const api of raw.apiRateLimits) {
    if (api.rpm.resetAt !== null) candidates.push(api.rpm.resetAt);
    if (api.itpm.resetAt !== null) candidates.push(api.itpm.resetAt);
    if (api.otpm.resetAt !== null) candidates.push(api.otpm.resetAt);
  }

  if (candidates.length === 0) return null;

  let earliest = candidates[0]!;
  let earliestMs = Date.parse(earliest);
  for (const value of candidates.slice(1)) {
    const ms = Date.parse(value);
    if (ms < earliestMs) {
      earliest = value;
      earliestMs = ms;
    }
  }
  return earliest;
}

export function createEmptyUsageState(): UsageStateV1 {
  return usageStateV1Schema.parse({
    kind: "UsageStateV1",
    session: {
      startedAt: null,
      resetAt: null,
      usedFraction: null,
      source: "unknown",
    },
    weekly: [],
    capacity: {
      contextWindowTokens: null,
      currentConversationTokens: null,
      autoSummarizeEnabled: null,
    },
    apiRateLimits: [],
    derived: {
      phase: "unknown",
      mostConstrainedDimension: null,
      nearestResetAt: null,
    },
    meta: {
      observedAt: null,
      surfaces: [],
      planTier: "unknown",
    },
  });
}

export function refreshUsageDerived(stateInput: UsageStateV1): UsageStateV1 {
  const state = usageStateV1Schema.parse(stateInput);
  const raw: UsageRawInput = {
    session: state.session,
    weekly: state.weekly,
    capacity: state.capacity,
    apiRateLimits: state.apiRateLimits,
  };

  return usageStateV1Schema.parse({
    ...state,
    derived: {
      phase: deriveUsagePhase(raw),
      mostConstrainedDimension: deriveMostConstrainedDimension(raw),
      nearestResetAt: deriveNearestResetAt(raw),
    },
    meta: {
      ...state.meta,
      observedAt: new Date().toISOString(),
    },
  });
}
