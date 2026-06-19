// GH-2078 / epic ai-home-udqx2 (GH-2074) PR-1, step .1.3 — failing tests for
// the `PRX_TRACE=1` JSONL tracer.
//
// These pin the contract the implementation step (.1.4 / ai-home-udqx2.5) must
// satisfy: `traceMs` emits one JSONL record per traced IO call when tracing is
// enabled, the record shape is the one locked by
// docs/perf/validate-work-session.md ({ts, kind, target, ms, cache}), emission
// is stderr-only so `--format=json` stdout stays clean, and `runStep` gets a
// summary line on exit.
//
// These were authored `test.failing` against the .1.3 no-op stub; .1.4
// (ai-home-udqx2.5) implemented the `trace.ts` helper bodies, so they now pass
// and have been flipped to plain `test`. They remain the regression guard for
// the locked JSONL contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { deleteEnv, getEnv, setEnv } from "@bounded-systems/env";

import {
  classifyTraceCmd,
  formatTraceEvent,
  formatTraceSummary,
  traceMs,
  traceSync,
  type TraceEvent,
} from "../../src/pr-state/trace.ts";

/** Monotonic epoch-ms clock; `tick` advances it inside the traced fn. */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("PRX_TRACE JSONL tracer", () => {
  let savedTrace: string | undefined;

  beforeEach(() => {
    savedTrace = getEnv("PRX_TRACE");
    deleteEnv("PRX_TRACE");
  });

  afterEach(() => {
    if (savedTrace === undefined) deleteEnv("PRX_TRACE");
    else setEnv("PRX_TRACE", savedTrace);
  });

  test("formatTraceEvent serializes one JSONL line in locked {ts,kind,target,ms,cache} key order", () => {
    const event: TraceEvent = {
      ts: "2026-05-19T17:23:01.310Z",
      kind: "gh-issue-view",
      target: "GH-1960",
      ms: 612,
      cache: "miss",
    };
    expect(formatTraceEvent(event)).toBe(
      '{"ts":"2026-05-19T17:23:01.310Z","kind":"gh-issue-view","target":"GH-1960","ms":612,"cache":"miss"}\n',
    );
  });

  test("traceMs (enabled) emits exactly one JSONL record with measured elapsed ms", async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await traceMs(
      "gh-issue-view",
      "GH-1960",
      async () => {
        clock.tick(612);
        return "ok";
      },
      {
        enabled: true,
        cache: "miss",
        now: clock.now,
        write: (line) => writes.push(line),
      },
    );

    // Observation-only: the wrapped fn's result passes through untouched.
    expect(result).toBe("ok");

    expect(writes.length).toBe(1);
    const line = writes[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    const record = JSON.parse(line) as TraceEvent;
    expect(record).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      kind: "gh-issue-view",
      target: "GH-1960",
      ms: 612,
      cache: "miss",
    });
  });

  test("traceMs defaults cache to 'n/a' when the caller omits it", async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    await traceMs(
      "git-ls-remote",
      "origin/GH-2078",
      async () => {
        clock.tick(7);
        return undefined;
      },
      { enabled: true, now: clock.now, write: (line) => writes.push(line) },
    );
    const record = JSON.parse(writes[0] ?? "{}") as TraceEvent;
    expect(record.cache).toBe("n/a");
    expect(record.ms).toBe(7);
  });

  test("traceMs honors PRX_TRACE=1 from the environment when `enabled` is not passed", async () => {
    setEnv("PRX_TRACE", "1");
    const clock = makeClock(0);
    const writes: string[] = [];
    await traceMs(
      "bd-show",
      "ai-home-udqx2.4",
      async () => {
        clock.tick(3);
        return 0;
      },
      { now: clock.now, write: (line) => writes.push(line) },
    );
    expect(writes.length).toBe(1);
  });

  test("traceMs is silent by default (PRX_TRACE unset, no `enabled`) and still returns fn's result", async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await traceMs(
      "gh-pr-list",
      "GH-1960",
      async () => {
        clock.tick(500);
        return 42;
      },
      { now: clock.now, write: (line) => writes.push(line) },
    );
    expect(result).toBe(42);
    expect(writes).toEqual([]);
  });

  test("traceMs (enabled) writes to stderr, never stdout, so --format=json payloads stay clean", async () => {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const clock = makeClock(0);
      // No `write` override → exercises the default stderr sink.
      await traceMs(
        "gh-api-project",
        "GH-1960",
        async () => {
          clock.tick(120);
          return null;
        },
        { enabled: true, cache: "n/a", now: clock.now },
      );
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(outChunks.join("")).toBe("");
    const stderr = errChunks.join("");
    expect(stderr).toContain('"target":"GH-1960"');
    expect(stderr.endsWith("\n")).toBe(true);
  });

  test("formatTraceSummary renders one JSONL summary line aggregating traced calls", () => {
    const events: TraceEvent[] = [
      {
        ts: "2026-05-19T17:23:01.310Z",
        kind: "gh-issue-view",
        target: "GH-1960",
        ms: 612,
        cache: "miss",
      },
      {
        ts: "2026-05-19T17:23:01.930Z",
        kind: "bd-show",
        target: "ai-home-udqx2.4",
        ms: 88,
        cache: "hit",
      },
    ];
    const line = formatTraceSummary(events);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean).length).toBe(1);
    const summary = JSON.parse(line) as {
      ts: string;
      kind: string;
      calls: number;
      ms: number;
    };
    expect(summary.kind).toBe("summary");
    expect(summary.calls).toBe(2);
    expect(summary.ms).toBe(700);
    expect(Number.isNaN(Date.parse(summary.ts))).toBe(false);
  });
});

describe("traceSync (synchronous CommandRunner seam)", () => {
  let savedTrace: string | undefined;
  beforeEach(() => {
    savedTrace = getEnv("PRX_TRACE");
    deleteEnv("PRX_TRACE");
  });
  afterEach(() => {
    if (savedTrace === undefined) deleteEnv("PRX_TRACE");
    else setEnv("PRX_TRACE", savedTrace);
  });

  test("enabled: emits one measured JSONL record and returns fn's result", () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = traceSync(
      "git-rev-list",
      "origin/main...local/GH-2078",
      () => {
        clock.tick(42);
        return { status: 0 };
      },
      { enabled: true, now: clock.now, write: (line) => writes.push(line) },
    );
    expect(result).toEqual({ status: 0 });
    expect(writes.length).toBe(1);
    const record = JSON.parse(writes[0] ?? "{}") as TraceEvent;
    expect(record).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      kind: "git-rev-list",
      target: "origin/main...local/GH-2078",
      ms: 42,
      cache: "n/a",
    });
  });

  test("disabled by default: zero emission, no clock read, passes result through", () => {
    let nowCalls = 0;
    const writes: string[] = [];
    const result = traceSync("bd-show", "ai-home-udqx2.4", () => 7, {
      now: () => {
        nowCalls += 1;
        return 0;
      },
      write: (line) => writes.push(line),
    });
    expect(result).toBe(7);
    expect(writes).toEqual([]);
    // Early-return path must not even read the clock (hot-path invariant).
    expect(nowCalls).toBe(0);
  });

  test("enabled: still emits when the traced fn throws (attributes slow failures)", () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    expect(() =>
      traceSync(
        "gh-issue-view",
        "GH-1960",
        () => {
          clock.tick(900);
          throw new Error("boom");
        },
        { enabled: true, now: clock.now, write: (line) => writes.push(line) },
      ),
    ).toThrow("boom");
    expect(writes.length).toBe(1);
    expect(JSON.parse(writes[0] ?? "{}").ms).toBe(900);
  });
});

describe("classifyTraceCmd (argv → {kind, target})", () => {
  test.each([
    [["gh", "issue", "view", "1960", "--json", "state"], "gh-issue-view", "1960"],
    [["gh", "pr", "list", "--head", "GH-2078", "--state", "all"], "gh-pr-list", "GH-2078"],
    [["gh", "api", "graphql", "-f", "query=…"], "gh-api", "graphql"],
    [["bd", "show", "ai-home-udqx2.4", "--json"], "bd-show", "ai-home-udqx2.4"],
    [
      ["git", "-C", "/repo", "rev-list", "--count", "origin/main...x"],
      "git-rev-list",
      "origin/main...x",
    ],
    [
      ["git", "-C", "/repo", "for-each-ref", "refs/remotes/origin/"],
      "git-for-each-ref",
      "refs/remotes/origin/",
    ],
  ] as const)("classifies %j", (cmd, kind, target) => {
    expect(classifyTraceCmd([...cmd])).toEqual({ kind, target });
  });

  test("unknown binary falls back to the binary name", () => {
    expect(classifyTraceCmd(["python3", "render.py"])).toEqual({
      kind: "python3",
      target: "",
    });
  });
});

describe("trace span placement vs a gate (GH-2355 fidelity fix)", () => {
  // A gate that does `waitMs` of work BEFORE delegating to its inner runner —
  // models withBucketGate's gateGhArgv rate-limit wait, which runs before the
  // gated command executes.
  function gateWith(waitMs: number, clock: { now: () => number; tick: (ms: number) => void }) {
    return <T>(inner: () => T): T => {
      clock.tick(waitMs);
      return inner();
    };
  }

  test("trace INSIDE the gate measures exec-only (gate-wait excluded) — the fixed order", () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const gate = gateWith(100, clock); // 100ms gate-wait
    // defaultRunner = withBucketGate(withTrace(raw)): trace wraps only the exec.
    gate(() =>
      traceSync(
        "gh-api",
        "graphql",
        () => {
          clock.tick(5); // 5ms exec
          return "ok";
        },
        { enabled: true, now: clock.now, write: (l) => writes.push(l) },
      ),
    );
    expect(JSON.parse(writes[0] ?? "{}").ms).toBe(5);
  });

  test("trace OUTSIDE the gate conflates gate-wait into ms — the PR-1 bug it replaces", () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const gate = gateWith(100, clock);
    // PR-1 order withTrace(withBucketGate(raw)): trace wraps the whole gate call.
    traceSync(
      "gh-api",
      "graphql",
      () =>
        gate(() => {
          clock.tick(5);
          return "ok";
        }),
      { enabled: true, now: clock.now, write: (l) => writes.push(l) },
    );
    expect(JSON.parse(writes[0] ?? "{}").ms).toBe(105); // 100 wait + 5 exec
  });
});
