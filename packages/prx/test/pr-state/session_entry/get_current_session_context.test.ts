// GH-977: getCurrentSessionContext reads the PRX_SESSION_CONTEXT env carrier
// (seeded by `dispatchSessionEntryEvent`) so child `prx` invocations launched
// from inside a Claude session report the right surface.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  PRX_SESSION_CONTEXT_ENV,
  getCurrentSessionContext,
} from "../../../src/pr-state/session-entry/get-current-session-context.ts";

const ORIGINAL = process.env[PRX_SESSION_CONTEXT_ENV];

beforeEach(() => {
  delete process.env[PRX_SESSION_CONTEXT_ENV];
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env[PRX_SESSION_CONTEXT_ENV];
  } else {
    process.env[PRX_SESSION_CONTEXT_ENV] = ORIGINAL;
  }
});

describe("getCurrentSessionContext", () => {
  test("returns 'mainx' when the env var is unset", () => {
    expect(getCurrentSessionContext()).toBe("mainx");
  });

  test("returns the env value for each known SessionContext", () => {
    process.env[PRX_SESSION_CONTEXT_ENV] = "plan";
    expect(getCurrentSessionContext()).toBe("plan");

    process.env[PRX_SESSION_CONTEXT_ENV] = "intake";
    expect(getCurrentSessionContext()).toBe("intake");

    process.env[PRX_SESSION_CONTEXT_ENV] = "triage";
    expect(getCurrentSessionContext()).toBe("triage");

    process.env[PRX_SESSION_CONTEXT_ENV] = "mainx";
    expect(getCurrentSessionContext()).toBe("mainx");
  });

  test("falls back to 'mainx' when the env value is unrecognized", () => {
    process.env[PRX_SESSION_CONTEXT_ENV] = "audit";
    expect(getCurrentSessionContext()).toBe("mainx");

    process.env[PRX_SESSION_CONTEXT_ENV] = "";
    expect(getCurrentSessionContext()).toBe("mainx");
  });
});
