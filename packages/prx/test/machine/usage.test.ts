import { describe, expect, test } from "bun:test";

import {
  createEmptyUsageState,
  deriveNearestResetAt,
  deriveUsagePhase,
  refreshUsageDerived,
  usageStateV1Schema,
  type UsageStateV1,
} from "../../src/machine/usage.ts";

describe("UsageStateV1 schema + derive", () => {
  test("createEmptyUsageState parses and reports unknown phase", () => {
    const empty = createEmptyUsageState();
    const parsed = usageStateV1Schema.parse(empty);
    expect(parsed.kind).toBe("UsageStateV1");
    expect(parsed.derived.phase).toBe("unknown");
    expect(parsed.meta.planTier).toBe("unknown");
  });

  test("outer strict() rejects unknown top-level keys", () => {
    const empty = createEmptyUsageState();
    expect(() =>
      usageStateV1Schema.parse({ ...empty, bogus: 1 } as unknown),
    ).toThrow();
  });

  test("nested strict() rejects unknown keys inside session", () => {
    const empty = createEmptyUsageState();
    expect(() =>
      usageStateV1Schema.parse({
        ...empty,
        session: { ...empty.session, bogus: 1 },
      } as unknown),
    ).toThrow();
  });

  test("nested strict() rejects unknown keys inside capacity", () => {
    const empty = createEmptyUsageState();
    expect(() =>
      usageStateV1Schema.parse({
        ...empty,
        capacity: { ...empty.capacity, bogus: "x" },
      } as unknown),
    ).toThrow();
  });

  test("deriveUsagePhase returns unknown when no dimensions populated", () => {
    expect(deriveUsagePhase(createEmptyUsageState())).toBe("unknown");
  });

  test("refreshUsageDerived flags critical session usage and names the dimension", () => {
    const empty = createEmptyUsageState();
    const state: UsageStateV1 = {
      ...empty,
      session: { ...empty.session, usedFraction: 0.95, source: "manual" },
    };
    const refreshed = refreshUsageDerived(state);
    expect(refreshed.derived.phase).toBe("critical");
    expect(refreshed.derived.mostConstrainedDimension).toBe("session");
  });

  test("refreshUsageDerived marks fully-consumed weekly budget as blocked", () => {
    const empty = createEmptyUsageState();
    const state: UsageStateV1 = {
      ...empty,
      weekly: [
        { model: "opus", resetAt: null, usedFraction: 1.0, source: "manual" },
      ],
    };
    const refreshed = refreshUsageDerived(state);
    expect(refreshed.derived.phase).toBe("blocked");
    expect(refreshed.derived.mostConstrainedDimension).toBe("weekly");
  });

  test("refreshUsageDerived blocks on zero-remaining rate-limit bucket", () => {
    const empty = createEmptyUsageState();
    const state: UsageStateV1 = {
      ...empty,
      apiRateLimits: [
        {
          tier: 1,
          model: "sonnet",
          rpm: { limit: 50, remaining: 0, resetAt: null },
          itpm: { limit: 1000, remaining: 1000, resetAt: null },
          otpm: { limit: 1000, remaining: 1000, resetAt: null },
        },
      ],
    };
    const refreshed = refreshUsageDerived(state);
    expect(refreshed.derived.phase).toBe("blocked");
    expect(refreshed.derived.mostConstrainedDimension).toBe("api_rpm");
  });

  test("refreshUsageDerived stamps meta.observedAt as a parseable RFC3339 string", () => {
    const empty = createEmptyUsageState();
    const refreshed = refreshUsageDerived(empty);
    expect(refreshed.meta.observedAt).not.toBeNull();
    const parsedMs = Date.parse(refreshed.meta.observedAt!);
    expect(Number.isFinite(parsedMs)).toBeTrue();
    expect(parsedMs).toBeGreaterThan(0);
  });

  test("deriveNearestResetAt picks the earliest populated reset", () => {
    const empty = createEmptyUsageState();
    const laterIso = "2030-01-01T00:00:00.000Z";
    const earlierIso = "2027-06-15T12:34:56.000Z";
    const state: UsageStateV1 = {
      ...empty,
      session: { ...empty.session, resetAt: laterIso, source: "manual" },
      weekly: [
        { model: "opus", resetAt: earlierIso, usedFraction: null, source: "manual" },
      ],
    };
    expect(deriveNearestResetAt(state)).toBe(earlierIso);
    expect(deriveNearestResetAt(createEmptyUsageState())).toBeNull();
  });
});
