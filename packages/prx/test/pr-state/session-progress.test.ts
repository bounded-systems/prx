// GH-2014: runStep — start banner, heartbeat at 5s silent intervals, finish
// line with elapsed ms. Clock + interval are injected so the test does not
// wait wall-clock seconds.

import { describe, expect, test } from "bun:test";

import { runStep } from "../../src/pr-state/session-progress.ts";

type FakeClock = {
  now: () => number;
  tick: (ms: number) => void;
};

function makeClock(start = 0): FakeClock {
  let t = start;
  return {
    now: () => t,
    tick: (ms) => {
      t += ms;
    },
  };
}

type FakeTimer = {
  fire: () => void;
  cleared: boolean;
};

function makeIntervalRunner() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setInterval: (cb: () => void) => {
      const timer: FakeTimer = {
        fire: () => cb(),
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearInterval: (h: unknown) => {
      const t = h as FakeTimer;
      t.cleared = true;
    },
  };
}

describe("runStep", () => {
  test("emits start banner and finish line with elapsed ms on success", async () => {
    const writes: string[] = [];
    const clock = makeClock(1000);
    const runner = makeIntervalRunner();
    const result = await runStep(
      "validate-work-session",
      async () => {
        clock.tick(42);
        return "ok";
      },
      {
        write: (line) => writes.push(line),
        silent: false,
        now: clock.now,
        setInterval: runner.setInterval,
        clearInterval: runner.clearInterval,
      },
    );
    expect(result).toBe("ok");
    expect(writes).toEqual([
      "▸ validate-work-session\n",
      "✓ validate-work-session (42ms)\n",
    ]);
    expect(runner.timers.every((t) => t.cleared)).toBe(true);
  });

  test("ticks heartbeat lines at the configured cadence while work is in flight", async () => {
    const writes: string[] = [];
    const clock = makeClock(0);
    const runner = makeIntervalRunner();
    await runStep(
      "hydrate-beads",
      async () => {
        // Simulate three silent 5s windows: heartbeat would fire 3 times.
        clock.tick(5_000);
        runner.timers[0]?.fire();
        clock.tick(5_000);
        runner.timers[0]?.fire();
        clock.tick(5_000);
        runner.timers[0]?.fire();
        clock.tick(123);
      },
      {
        write: (line) => writes.push(line),
        silent: false,
        now: clock.now,
        heartbeatMs: 5_000,
        setInterval: runner.setInterval,
        clearInterval: runner.clearInterval,
      },
    );
    expect(writes).toEqual([
      "▸ hydrate-beads\n",
      "  …still running (5s elapsed)\n",
      "  …still running (10s elapsed)\n",
      "  …still running (15s elapsed)\n",
      "✓ hydrate-beads (15123ms)\n",
    ]);
    expect(runner.timers[0]?.cleared).toBe(true);
  });

  test("emits a failure line and propagates the error", async () => {
    const writes: string[] = [];
    const clock = makeClock(0);
    const runner = makeIntervalRunner();
    let caught: unknown;
    try {
      await runStep(
        "materialize-worktree",
        async () => {
          clock.tick(7);
          throw new Error("boom");
        },
        {
          write: (line) => writes.push(line),
          silent: false,
          now: clock.now,
          setInterval: runner.setInterval,
          clearInterval: runner.clearInterval,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
    expect(writes).toEqual([
      "▸ materialize-worktree\n",
      "✗ materialize-worktree (7ms): boom\n",
    ]);
    expect(runner.timers[0]?.cleared).toBe(true);
  });

  test("silent: true suppresses all writes and skips the heartbeat timer", async () => {
    const writes: string[] = [];
    const clock = makeClock(0);
    const runner = makeIntervalRunner();
    const result = await runStep(
      "claude-allowlist",
      async () => {
        clock.tick(99);
        return 42;
      },
      {
        write: (line) => writes.push(line),
        silent: true,
        now: clock.now,
        setInterval: runner.setInterval,
        clearInterval: runner.clearInterval,
      },
    );
    expect(result).toBe(42);
    expect(writes).toEqual([]);
    // No timer is set when silent
    expect(runner.timers).toEqual([]);
  });
});
