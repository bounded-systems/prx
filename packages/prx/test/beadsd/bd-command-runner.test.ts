// The door-gated proc wrappers used by the direct bd-read sites. In the box
// profile (PRX_BEADS_DOOR set) a `bd` command routes through the registered
// dialer; otherwise the wrapped runner runs unchanged. The dialer + env are
// process-global, so each door-mode test sets and restores them.

import { afterEach, describe, expect, test } from "bun:test";

import { registerBdDoorDialer } from "@bounded-systems/bd";
import type {
  CommandResult,
  CommandRunner,
  SpawnCaptureResult,
  SpawnCaptureFn,
} from "@bounded-systems/proc";

import {
  doorGatedCommandRunner,
  doorGatedSpawnCapture,
} from "../../src/beadsd/bd-command-runner.ts";

function withDoor<T>(fn: () => T): T {
  const prev = process.env.PRX_BEADS_DOOR;
  process.env.PRX_BEADS_DOOR = "host.sock";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PRX_BEADS_DOOR;
    else process.env.PRX_BEADS_DOOR = prev;
  }
}

afterEach(() => {
  registerBdDoorDialer(undefined);
  delete process.env.PRX_BEADS_DOOR;
});

describe("doorGatedCommandRunner", () => {
  test("off-profile: pure passthrough to the inner runner", () => {
    const calls: string[][] = [];
    const inner: CommandRunner = (cmd) => {
      calls.push([...cmd]);
      return { stdout: "inner", stderr: "", status: 0 } satisfies CommandResult;
    };
    const r = doorGatedCommandRunner(inner)(["bd", "list", "--json"], { check: false });
    expect(r.stdout).toBe("inner");
    expect(calls).toEqual([["bd", "list", "--json"]]);
  });

  test("door mode: a bd read dials the door, inner runner is never called", () => {
    registerBdDoorDialer((opts) => ({
      exitCode: 0,
      stdout: `door:${opts.subcommand}`,
      stderr: "",
      policy: null,
    }));
    let innerCalled = false;
    const inner: CommandRunner = () => {
      innerCalled = true;
      return { stdout: "", stderr: "", status: 0 };
    };
    const r = withDoor(() => doorGatedCommandRunner(inner)(["bd", "list"], { check: false }));
    expect(r).toEqual({ stdout: "door:list", stderr: "", status: 0 });
    expect(innerCalled).toBe(false);
  });

  test("door mode: a non-bd command still passes through to the inner runner", () => {
    let innerCalled = false;
    const inner: CommandRunner = () => {
      innerCalled = true;
      return { stdout: "tok", stderr: "", status: 0 };
    };
    const r = withDoor(() =>
      doorGatedCommandRunner(inner)(["gh", "auth", "token"], { check: false }),
    );
    expect(innerCalled).toBe(true);
    expect(r.stdout).toBe("tok");
  });
});

describe("doorGatedSpawnCapture", () => {
  const okCapture = (stdout: string): SpawnCaptureResult => ({
    status: 0,
    signal: null,
    stdout,
    stderr: "",
  });

  test("off-profile: pure passthrough", () => {
    const inner: SpawnCaptureFn = () => okCapture("inner");
    const r = doorGatedSpawnCapture(inner)(["bd", "list", "--json", "--limit", "1"]);
    expect(r.stdout).toBe("inner");
  });

  test("door mode: a dialed read yields a clean (status 0) capture result", () => {
    registerBdDoorDialer(() => ({ exitCode: 0, stdout: "[{}]", stderr: "", policy: null }));
    const inner: SpawnCaptureFn = () => okCapture("should-not-run");
    const r = withDoor(() =>
      doorGatedSpawnCapture(inner)(["bd", "list", "--json", "--limit", "1"]),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("[{}]");
  });

  test("door mode: a fail-closed op reads as a capture failure (status≠0)", () => {
    registerBdDoorDialer(() => null);
    const inner: SpawnCaptureFn = () => okCapture("should-not-run");
    const r = withDoor(() =>
      doorGatedSpawnCapture(inner)(["bd", "list", "--json", "--limit", "1"]),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not wired for 'bd list'/);
  });
});
