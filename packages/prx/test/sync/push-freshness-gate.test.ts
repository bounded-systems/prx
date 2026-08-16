import { describe, expect, test } from "bun:test";

import {
  shouldSkipPush,
  pushFullySucceeded,
  advanceLastPushedHead,
} from "../../src/sync/push-freshness-gate.ts";

describe("shouldSkipPush", () => {
  test("skips only when both heads are known and equal", () => {
    expect(shouldSkipPush("h1", "h1")).toBe(true);
  });

  test("runs the push when the bead store moved", () => {
    expect(shouldSkipPush("h2", "h1")).toBe(false);
  });

  test("runs the push when freshness can't be proven (unknown etag or no prior push)", () => {
    expect(shouldSkipPush(undefined, "h1")).toBe(false); // no current etag wired
    expect(shouldSkipPush("h1", undefined)).toBe(false); // never pushed before
    expect(shouldSkipPush(undefined, undefined)).toBe(false);
  });
});

describe("pushFullySucceeded", () => {
  test("true only with zero deferrals and zero errors", () => {
    expect(pushFullySucceeded({ pushDeferred: 0, pushErrors: 0 })).toBe(true);
    expect(pushFullySucceeded({ pushDeferred: 2, pushErrors: 0 })).toBe(false); // --limit deferral
    expect(pushFullySucceeded({ pushDeferred: 0, pushErrors: 1 })).toBe(false); // a push errored
  });
});

describe("advanceLastPushedHead — retry-safety", () => {
  test("advances to current head on a full success", () => {
    expect(
      advanceLastPushedHead({
        previous: "h1",
        currentHead: "h2",
        outcome: { pushDeferred: 0, pushErrors: 0 },
      }),
    ).toBe("h2");
  });

  test("keeps the previous watermark on a deferred push (so next tick retries)", () => {
    expect(
      advanceLastPushedHead({
        previous: "h1",
        currentHead: "h2",
        outcome: { pushDeferred: 3, pushErrors: 0 },
      }),
    ).toBe("h1");
  });

  test("keeps the previous watermark on an errored push", () => {
    expect(
      advanceLastPushedHead({
        previous: "h1",
        currentHead: "h2",
        outcome: { pushDeferred: 0, pushErrors: 1 },
      }),
    ).toBe("h1");
  });

  test("keeps the previous watermark when the current etag is unknown", () => {
    expect(
      advanceLastPushedHead({
        previous: "h1",
        currentHead: undefined,
        outcome: { pushDeferred: 0, pushErrors: 0 },
      }),
    ).toBe("h1");
  });
});
