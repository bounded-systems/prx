// GH-1397 — bd-memory handoff store. Tests cover the four shapes the plan
// calls out:
//
//   1. enqueueHandoff (created / duplicate / bd-unprovisioned / cross-repo)
//   2. CAS spillover when intent.args exceeds the inline threshold
//   3. computeDedupKey canonicalization across re-ordered keys
//   4. claimHandoff CAS — already-claimed rejects a second claim
//
// All bd I/O is injected via the `execBd` seam; CAS spillover is injected
// via `casWriteBlob`.

import { describe, expect, test } from "bun:test";

import type { WorkUnitId } from "@bounded-systems/machine-schema";
import {
  HANDOFF_ARGS_INLINE_THRESHOLD_BYTES,
  claimHandoff,
  computeDedupKey,
  enqueueHandoff,
  handoffMemoryKey,
  handoffMemoryKeyPrefix,
  listHandoffs,
  type HandoffStoreDeps,
} from "../../src/handoff/store.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";

type Capture = {
  remembers: Array<{ key: string; body: string }>;
  memoriesCalls: string[];
  casBlobs: Array<{ content: string; domain: string }>;
};

function makeCapture(): Capture {
  return { remembers: [], memoriesCalls: [], casBlobs: [] };
}

function makeFakeBd(
  cap: Capture,
  inMemoryRows: Map<string, string> = new Map(),
): HandoffStoreDeps["execBd"] {
  return (opts: BdExecOptions): BdExecResult => {
    if (opts.subcommand === "remember") {
      const body = opts.args[0] as string;
      const keyIdx = opts.args.indexOf("--key");
      const key = (keyIdx >= 0 ? opts.args[keyIdx + 1] : "") as string;
      cap.remembers.push({ key, body });
      inMemoryRows.set(key, body);
      return { exitCode: 0, stdout: "{}", stderr: "", policy: null };
    }
    if (opts.subcommand === "memories") {
      const prefix = opts.args[0] as string;
      cap.memoriesCalls.push(prefix);
      const rows: Array<{ key: string; body: string }> = [];
      for (const [k, v] of inMemoryRows) {
        if (k.startsWith(prefix)) rows.push({ key: k, body: v });
      }
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "", policy: null };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `unexpected subcommand: ${opts.subcommand}`,
      policy: null,
    };
  };
}

function makeUnprovisionedBd(): HandoffStoreDeps["execBd"] {
  return (): BdExecResult => ({
    exitCode: 1,
    stdout: "",
    stderr: "bd: workspace not provisioned",
    policy: null,
  });
}

function baseEnqueueInput(overrides: Record<string, unknown> = {}) {
  return {
    workUnitId: "GH-1397" as WorkUnitId,
    repoSlug: "bdelanghe/ai-home",
    sourceActor: "executor",
    targetActor: "noop" as const,
    intent: { verb: "test.verb", args: { a: 1 } },
    denialReason: "not-allowlisted-for-role" as const,
    ...overrides,
  };
}

describe("handoffMemoryKey", () => {
  test("uses target/work/id shape with workUnitId", () => {
    const key = handoffMemoryKey({
      id: "H1",
      targetActor: "publisher",
      workUnitId: "GH-9",
    } as never);
    expect(key).toBe("handoff/publisher/GH-9/H1");
  });

  test("uses 'none' when workUnitId is null", () => {
    const key = handoffMemoryKey({
      id: "H1",
      targetActor: "triage",
      workUnitId: null,
    } as never);
    expect(key).toBe("handoff/triage/none/H1");
  });

  test("handoffMemoryKeyPrefix scopes to target + work", () => {
    expect(handoffMemoryKeyPrefix("publisher")).toBe("handoff/publisher/");
    expect(handoffMemoryKeyPrefix("publisher", "GH-9")).toBe("handoff/publisher/GH-9/");
  });
});

describe("computeDedupKey", () => {
  test("collides on differently-ordered keys", () => {
    const a = computeDedupKey({
      workUnitId: "GH-1",
      targetActor: "publisher",
      verb: "git.push",
      args: { a: 1, b: 2 },
    });
    const b = computeDedupKey({
      workUnitId: "GH-1",
      targetActor: "publisher",
      verb: "git.push",
      args: { b: 2, a: 1 },
    });
    expect(a).toBe(b);
  });

  test("differs when verb changes", () => {
    const a = computeDedupKey({
      workUnitId: "GH-1",
      targetActor: "publisher",
      verb: "git.push",
      args: {},
    });
    const b = computeDedupKey({
      workUnitId: "GH-1",
      targetActor: "publisher",
      verb: "git.commit",
      args: {},
    });
    expect(a).not.toBe(b);
  });
});

describe("enqueueHandoff", () => {
  test("creates a new envelope on first call", async () => {
    const cap = makeCapture();
    const exec = makeFakeBd(cap);
    const r = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    expect(r.envelope.targetActor).toBe("noop");
    expect(r.envelope.status).toBe("pending");
    expect(cap.remembers.length).toBe(1);
    expect(cap.remembers[0]?.key.startsWith("handoff/noop/GH-1397/")).toBe(true);
  });

  test("is idempotent on dedupKey — second enqueue is a duplicate", async () => {
    const cap = makeCapture();
    const exec = makeFakeBd(cap);
    const first = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    const second = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("duplicate");
    if (second.kind === "duplicate" && first.kind === "created") {
      expect(second.existingId).toBe(first.envelope.id);
    }
    // Only one write — the second call resolves via bd memories scan.
    expect(cap.remembers.length).toBe(1);
  });

  test("fails closed when bd is unprovisioned (I-HQ5)", async () => {
    const r = await enqueueHandoff(baseEnqueueInput(), {
      execBd: makeUnprovisionedBd(),
    });
    expect(r.kind).toBe("bd-unprovisioned");
  });

  test("refuses cross-repo enqueue", async () => {
    const cap = makeCapture();
    const exec = makeFakeBd(cap);
    const r = await enqueueHandoff(baseEnqueueInput({ repoSlug: "other/repo" }), {
      execBd: exec,
      currentRepoSlug: () => "bdelanghe/ai-home",
    });
    expect(r.kind).toBe("cross-repo-refused");
    if (r.kind === "cross-repo-refused") {
      expect(r.expected).toBe("bdelanghe/ai-home");
      expect(r.got).toBe("other/repo");
    }
    expect(cap.remembers.length).toBe(0);
  });

  test("spills large intent.args to CAS, populating inputRefs", async () => {
    const cap = makeCapture();
    const exec = makeFakeBd(cap);
    const bigArgs = { blob: "x".repeat(HANDOFF_ARGS_INLINE_THRESHOLD_BYTES + 100) };
    const r = await enqueueHandoff(
      baseEnqueueInput({ intent: { verb: "test.verb", args: bigArgs } }),
      {
        execBd: exec,
        casWriteBlob: async (content, domain) => {
          cap.casBlobs.push({ content, domain });
          return { sha: "sha256:" + "f".repeat(64) };
        },
      },
    );
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    expect(cap.casBlobs.length).toBe(1);
    expect(cap.casBlobs[0]?.domain).toBe("handoff");
    expect(r.envelope.inputRefs).toEqual(["cas://sha256:" + "f".repeat(64)]);
    // The persisted intent.args is the CAS handle, not the original blob.
    expect(r.envelope.intent.args).toEqual({
      $ref: "cas://sha256:" + "f".repeat(64),
    });
  });

  test("small args stay inline (no spillover)", async () => {
    const cap = makeCapture();
    const exec = makeFakeBd(cap);
    let casWrites = 0;
    const r = await enqueueHandoff(
      baseEnqueueInput({ intent: { verb: "test.verb", args: { a: 1 } } }),
      {
        execBd: exec,
        casWriteBlob: async () => {
          casWrites += 1;
          return { sha: "sha256:" + "0".repeat(64) };
        },
      },
    );
    expect(r.kind).toBe("created");
    expect(casWrites).toBe(0);
  });
});

describe("listHandoffs", () => {
  test("returns oldest-first by enqueuedAt", async () => {
    const cap = makeCapture();
    const inMemory = new Map<string, string>();
    const exec = makeFakeBd(cap, inMemory);
    let tick = 0;
    const now = () => new Date(2026, 4, 19, 12, 0, tick++);
    await enqueueHandoff(baseEnqueueInput({ intent: { verb: "v.a", args: {} } }), {
      execBd: exec,
      now,
    });
    await enqueueHandoff(baseEnqueueInput({ intent: { verb: "v.b", args: {} } }), {
      execBd: exec,
      now,
    });
    await enqueueHandoff(baseEnqueueInput({ intent: { verb: "v.c", args: {} } }), {
      execBd: exec,
      now,
    });
    const list = await listHandoffs({ target: "noop" }, { execBd: exec });
    expect(list.length).toBe(3);
    expect(list[0]?.intent.verb).toBe("v.a");
    expect(list[2]?.intent.verb).toBe("v.c");
  });

  test("filters by status when requested", async () => {
    const cap = makeCapture();
    const inMemory = new Map<string, string>();
    const exec = makeFakeBd(cap, inMemory);
    await enqueueHandoff(baseEnqueueInput({ intent: { verb: "v.a", args: {} } }), {
      execBd: exec,
    });
    const all = await listHandoffs({}, { execBd: exec });
    expect(all.length).toBe(1);
    const done = await listHandoffs({ status: "done" }, { execBd: exec });
    expect(done.length).toBe(0);
  });
});

describe("claimHandoff", () => {
  test("first claim wins; second is rejected with already-claimed", async () => {
    const cap = makeCapture();
    const inMemory = new Map<string, string>();
    const exec = makeFakeBd(cap, inMemory);
    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    const first = await claimHandoff(created.envelope.id, "drainer-A", 60, {
      execBd: exec,
    });
    expect(first.kind).toBe("claimed");

    const second = await claimHandoff(created.envelope.id, "drainer-B", 60, {
      execBd: exec,
    });
    expect(second.kind).toBe("already-claimed");
    if (second.kind === "already-claimed") {
      expect(second.by).toBe("drainer-A");
    }
  });

  test("not-found when id does not exist", async () => {
    const cap = makeCapture();
    const exec = makeFakeBd(cap);
    const r = await claimHandoff("H_does_not_exist", "drainer-A", 60, {
      execBd: exec,
    });
    expect(r.kind).toBe("not-found");
  });
});
