// GH-1194 — CLI parser + handler coverage for `prx <actor> dispatch …`.
// The argv parser owns rewrite-correctness; the handler owns
// machine-driven exit code + stdout shape. Subprocess execution is stubbed
// via injected actors so tests stay hermetic.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fromPromise } from "xstate";

import {
  DispatchParseError,
  parseDispatchCommand,
} from "../../src/pr-state/dispatch/parse.ts";
import {
  dispatchChildEnv,
  renderDispatchOutcome,
  runDispatch,
} from "../../src/pr-state/dispatch/handler.ts";
import {
  DISPATCH_SOURCE_ENV,
  readDispatchSource,
} from "../../src/machine/dispatch.ts";
import {
  isDispatchSuccess,
  type InvokeTargetVerbInput,
  type InvokeTargetVerbOutput,
  type WriteCasBlobInput,
  type WriteCasBlobOutput,
} from "../../src/machine/machines/dispatch.ts";
import {
  readBlob,
} from "../../src/plan-store/cas.ts";

// ── parser ─────────────────────────────────────────────────────────────────

describe("parseDispatchCommand — flag walk", () => {
  test("cross-actor with --actor= and -- separator", () => {
    const parsed = parseDispatchCommand([
      "--source=plan",
      "--actor=scout",
      "--",
      "grep",
      "mkdtemp",
      "--in",
      "GH-1174",
    ]);
    expect(parsed.source).toBe("plan");
    expect(parsed.target).toBe("scout");
    expect(parsed.action).toBe("grep");
    expect(parsed.argv).toEqual(["mkdtemp", "--in", "GH-1174"]);
  });

  test("cross-actor with --target=", () => {
    const parsed = parseDispatchCommand([
      "--source=triage",
      "--target=scout",
      "--",
      "grep",
      "foo",
    ]);
    expect(parsed.target).toBe("scout");
  });

  test("self-dispatch defaults target to source when no --actor/--target", () => {
    const parsed = parseDispatchCommand([
      "--source=triage",
      "status",
      "--json",
    ]);
    expect(parsed.source).toBe("triage");
    expect(parsed.target).toBe("triage");
    expect(parsed.action).toBe("status");
    expect(parsed.argv).toEqual(["--json"]);
  });

  test("self-dispatch with -- separator", () => {
    const parsed = parseDispatchCommand([
      "--source=plan",
      "--",
      "save",
      "--unit",
      "GH-1194",
    ]);
    expect(parsed.target).toBe("plan");
    expect(parsed.action).toBe("save");
    expect(parsed.argv).toEqual(["--unit", "GH-1194"]);
  });

  test("--source flag accepts space-separated value", () => {
    const parsed = parseDispatchCommand([
      "--source",
      "plan",
      "--",
      "save",
    ]);
    expect(parsed.source).toBe("plan");
    expect(parsed.action).toBe("save");
  });

  test("missing --source rejected", () => {
    let caught: unknown = null;
    try {
      parseDispatchCommand(["--actor=scout", "--", "grep", "x"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchParseError);
    expect((caught as DispatchParseError).code).toBe("MISSING_SOURCE");
  });

  test("missing action rejected", () => {
    let caught: unknown = null;
    try {
      parseDispatchCommand(["--source=plan", "--actor=scout"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchParseError);
    expect((caught as DispatchParseError).code).toBe("MISSING_ACTION");
  });

  test("unknown source rejected", () => {
    let caught: unknown = null;
    try {
      parseDispatchCommand(["--source=ghost", "--", "grep"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchParseError);
    expect((caught as DispatchParseError).code).toBe("INVALID_SOURCE");
  });

  test("unknown target rejected", () => {
    let caught: unknown = null;
    try {
      parseDispatchCommand(["--source=plan", "--actor=ghost", "--", "grep"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchParseError);
    expect((caught as DispatchParseError).code).toBe("INVALID_TARGET");
  });

  // GH-2418 — typed-input (OCAP) capability flags.
  test("--input-artifact-type threads into inputArtifact", () => {
    const parsed = parseDispatchCommand([
      "--source=implement",
      "--actor=scout",
      "--input-artifact-type=query",
      "--",
      "grep",
      "mkdtemp",
    ]);
    expect(parsed.target).toBe("scout");
    expect(parsed.action).toBe("grep");
    expect(parsed.inputArtifact).toEqual({ type: "query" });
  });

  test("--input-artifact-type + --input-cas carry the backing handle", () => {
    const handle = `scout://sha256:${"a".repeat(64)}`;
    const parsed = parseDispatchCommand([
      "--source=implement",
      "--actor=plan",
      "--input-artifact-type=uow",
      "--input-cas",
      handle,
      "--",
      "save",
    ]);
    expect(parsed.inputArtifact).toEqual({ type: "uow", casHandle: handle });
  });

  test("--input-cas without --input-artifact-type rejected", () => {
    let caught: unknown = null;
    try {
      parseDispatchCommand([
        "--source=implement",
        "--actor=scout",
        "--input-cas",
        `scout://sha256:${"a".repeat(64)}`,
        "--",
        "grep",
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchParseError);
    expect((caught as DispatchParseError).code).toBe("INVALID_INPUT_ARTIFACT");
  });

  test("malformed --input-artifact-type rejected at the boundary", () => {
    let caught: unknown = null;
    try {
      parseDispatchCommand([
        "--source=implement",
        "--actor=scout",
        "--input-artifact-type=Bad-Type",
        "--",
        "grep",
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchParseError);
    expect((caught as DispatchParseError).code).toBe("INVALID_INPUT_ARTIFACT");
  });
});

// ── handler success path with stub actors ──────────────────────────────────

const ENV_KEYS = [
  "PRX_PLAN_STORE",
  "PRX_CAS_ROOT",
  "PRX_AI_HOME_ROOT",
  "BAKED_AI_HOME_ROOT",
  "PRX_OPERATOR_CONFIG_ROOT",
  "BAKED_OPERATOR_CONFIG_ROOT",
  "PRX_DISPATCH_DEPTH",
  "PRX_DISPATCH_PARENT",
] as const;
type EnvSnap = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnap {
  const snap: EnvSnap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnap): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("runDispatch — handler integration", () => {
  let envSnap: EnvSnap;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-dispatch-cli-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("success path writes CAS blob in target domain and prints handle", async () => {
    const stdoutBytes = Buffer.from(
      '{"path":"src/x.ts","line":12,"content":"mkdtemp"}\n',
    );
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => ({ stdout: stdoutBytes, exitCode: 0, durationMs: 7 }),
    );
    // Real writeCas — exercises the cas substrate end-to-end with the new
    // domain parameter from sub-ticket A.
    const result = await runDispatch({
      parsed: {
        source: "plan",
        target: "scout",
        action: "grep",
        argv: ["mkdtemp", "--in", "GH-1174"],
      },
      actors: {
        invokeTargetVerb: fakeInvoke,
      },
    });

    expect(isDispatchSuccess(result.outcome)).toBe(true);
    if (!isDispatchSuccess(result.outcome)) return;
    expect(result.state).toBe("done");
    expect(result.outcome.casHandle).toMatch(/^scout:\/\/sha256:[0-9a-f]{64}$/);
    expect(result.outcome.target).toBe("scout");

    // CAS round-trip: handle resolves to the captured stdout in scout domain.
    const sha = result.outcome.casHandle.replace("scout://", "");
    const stored = await readBlob(sha, { domain: "scout" });
    expect(stored.equals(stdoutBytes)).toBe(true);
  });

  test("ref dispatch:<source>:<id> set in target domain", async () => {
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => ({ stdout: Buffer.from("body"), exitCode: 0, durationMs: 1 }),
    );
    const result = await runDispatch({
      parsed: {
        source: "plan",
        target: "scout",
        action: "grep",
        argv: [],
      },
      actors: { invokeTargetVerb: fakeInvoke },
    });
    expect(isDispatchSuccess(result.outcome)).toBe(true);
    // We don't know the dispatch id, but we know the prefix.
    const refs = await import("../../src/plan-store/cas.ts").then((m) =>
      m.listRefs("dispatch:plan:", { domain: "scout" }),
    );
    expect(refs.length).toBe(1);
    expect(refs[0]?.name.startsWith("dispatch:plan:")).toBe(true);
  });

  test("capability deny short-circuits — no invoke, no CAS write", async () => {
    let invokeCalls = 0;
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => {
        invokeCalls += 1;
        return { stdout: Buffer.alloc(0), exitCode: 0, durationMs: 0 };
      },
    );
    let writeCalls = 0;
    const fakeWrite = fromPromise<WriteCasBlobOutput, WriteCasBlobInput>(
      async () => {
        writeCalls += 1;
        return { sha: `sha256:${"0".repeat(64)}`, refName: "n/a" };
      },
    );
    const result = await runDispatch({
      parsed: {
        source: "triage",
        target: "implement",
        action: "session",
        argv: [],
      },
      actors: {
        invokeTargetVerb: fakeInvoke,
        writeCasBlob: fakeWrite,
      },
    });
    expect(result.state).toBe("failed");
    expect(invokeCalls).toBe(0);
    expect(writeCalls).toBe(0);
    if (!isDispatchSuccess(result.outcome)) {
      expect(result.outcome.reason).toBe("capability_denied");
    }
  });

  // GH-2418 — the implement profile flips the OCAP gate on (per-profile, no
  // env flag needed). A bare implement→scout dispatch is now denied; presenting
  // the typed `query` artifact authorizes it. This is claims 2+3 end-to-end
  // through the real handler, parser-shaped input, and CAS substrate.
  test("implement profile: untyped dispatch denied (typedDispatchRejection on)", async () => {
    let invokeCalls = 0;
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => {
        invokeCalls += 1;
        return { stdout: Buffer.alloc(0), exitCode: 0, durationMs: 0 };
      },
    );
    const result = await runDispatch({
      parsed: {
        source: "implement",
        target: "scout",
        action: "grep",
        argv: ["mkdtemp"],
      },
      actors: { invokeTargetVerb: fakeInvoke },
    });
    expect(result.state).toBe("failed");
    expect(invokeCalls).toBe(0);
    if (!isDispatchSuccess(result.outcome)) {
      expect(result.outcome.reason).toBe("capability_denied");
      expect(result.outcome.detail).toContain("query");
    }
  });

  test("implement profile: typed dispatch (--input-artifact-type=query) proceeds", async () => {
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => ({ stdout: Buffer.from("hit"), exitCode: 0, durationMs: 2 }),
    );
    const result = await runDispatch({
      parsed: {
        source: "implement",
        target: "scout",
        action: "grep",
        argv: ["mkdtemp"],
        inputArtifact: { type: "query" },
      },
      actors: { invokeTargetVerb: fakeInvoke },
    });
    expect(result.state).toBe("done");
    expect(isDispatchSuccess(result.outcome)).toBe(true);
  });

  test("non-implement source unaffected by implement's flip (plan stays untyped-open)", async () => {
    // plan has no per-profile flip and the env flag is unset, so an untyped
    // plan→scout dispatch still proceeds — the flip is confined to implement.
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => ({ stdout: Buffer.from("hit"), exitCode: 0, durationMs: 1 }),
    );
    const result = await runDispatch({
      parsed: { source: "plan", target: "scout", action: "grep", argv: [] },
      actors: { invokeTargetVerb: fakeInvoke },
    });
    expect(result.state).toBe("done");
    expect(isDispatchSuccess(result.outcome)).toBe(true);
  });

  // GH-2418 claim 4 — a dispatch's output is a content-addressed artifact:
  // dispatch A's output casHandle feeds dispatch B's inputArtifact.casHandle,
  // chaining the closure. Both hops run under the implement OCAP gate.
  test("closure chaining: dispatch A's output casHandle becomes dispatch B's typed input", async () => {
    const aOutput = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => ({ stdout: Buffer.from("scout findings"), exitCode: 0, durationMs: 3 }),
    );
    const a = await runDispatch({
      parsed: {
        source: "implement",
        target: "scout",
        action: "grep",
        argv: ["mkdtemp"],
        inputArtifact: { type: "query" },
      },
      actors: { invokeTargetVerb: aOutput },
    });
    expect(isDispatchSuccess(a.outcome)).toBe(true);
    if (!isDispatchSuccess(a.outcome)) return;
    const handleA = a.outcome.casHandle;
    expect(handleA).toMatch(/^scout:\/\/sha256:[0-9a-f]{64}$/);

    // Feed A's content-addressed output as the backing CAS pointer for B's
    // typed input. B (implement→plan) expects a `uow`; the handle is just the
    // closure pointer, and the OCAP gate authorizes on the declared type.
    const bOutput = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => ({ stdout: Buffer.from("plan saved"), exitCode: 0, durationMs: 2 }),
    );
    const b = await runDispatch({
      parsed: {
        source: "implement",
        target: "plan",
        action: "save",
        argv: ["--unit", "GH-2418"],
        inputArtifact: { type: "uow", casHandle: handleA },
      },
      actors: { invokeTargetVerb: bOutput },
    });
    expect(b.state).toBe("done");
    expect(isDispatchSuccess(b.outcome)).toBe(true);
  });

  test("depth from PRX_DISPATCH_DEPTH propagates and triggers depth_exceeded at MAX", async () => {
    process.env.PRX_DISPATCH_DEPTH = "2";
    let invokeCalls = 0;
    const fakeInvoke = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
      async () => {
        invokeCalls += 1;
        return { stdout: Buffer.alloc(0), exitCode: 0, durationMs: 0 };
      },
    );
    const result = await runDispatch({
      parsed: {
        source: "plan",
        target: "scout",
        action: "grep",
        argv: [],
      },
      actors: { invokeTargetVerb: fakeInvoke },
    });
    expect(result.state).toBe("failed");
    expect(invokeCalls).toBe(0);
    if (!isDispatchSuccess(result.outcome)) {
      expect(result.outcome.reason).toBe("depth_exceeded");
    }
  });
});

// ── outcome rendering ──────────────────────────────────────────────────────

describe("renderDispatchOutcome — exit-code map", () => {
  test("success → stdout = casHandle, exit 0", () => {
    const r = renderDispatchOutcome({
      casHandle: `scout://sha256:${"a".repeat(64)}`,
      target: "scout",
      exitCode: 0,
      durationMs: 5,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(`scout://sha256:${"a".repeat(64)}`);
    expect(r.stderr).toBe("");
  });

  test("capability_denied → exit 64", () => {
    const r = renderDispatchOutcome({
      reason: "capability_denied",
      detail: "triage cannot dispatch to implement",
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain("capability_denied");
  });

  test("depth_exceeded → exit 65", () => {
    const r = renderDispatchOutcome({
      reason: "depth_exceeded",
      detail: "depth 2 >= 2",
    });
    expect(r.exitCode).toBe(65);
  });

  test("execution_failed → exit 65", () => {
    const r = renderDispatchOutcome({
      reason: "execution_failed",
      detail: "rg exited 2",
    });
    expect(r.exitCode).toBe(65);
  });
});

// ── source propagation (GH-352) ─────────────────────────────────────────────

describe("dispatchChildEnv — propagates the dispatch source to the target", () => {
  test("stamps PRX_DISPATCH_SOURCE (+ depth/parent) so the child attributes to the leg", () => {
    const childEnv = dispatchChildEnv(
      { PATH: "/usr/bin", EXISTING: "kept" },
      { childDepth: 1, parentDispatchId: "abcd1234", source: "implement" },
    );
    expect(childEnv[DISPATCH_SOURCE_ENV]).toBe("implement");
    expect(childEnv.PRX_DISPATCH_DEPTH).toBe("1");
    expect(childEnv.PRX_DISPATCH_PARENT).toBe("abcd1234");
    // Parent env is preserved.
    expect(childEnv.EXISTING).toBe("kept");
    // …and the child reads it back as its source authority.
    expect(readDispatchSource(childEnv)).toBe("implement");
  });

  test("readDispatchSource is null for a direct (non-dispatched) call", () => {
    expect(readDispatchSource({})).toBeNull();
    expect(readDispatchSource({ [DISPATCH_SOURCE_ENV]: "" })).toBeNull();
  });
});
