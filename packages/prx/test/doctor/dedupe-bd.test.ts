import { describe, expect, test } from "bun:test";

import {
  annotateIncomingEdges,
  dedupeBdOptionsSchema,
  findPinCollisions,
  formatRender,
  isAutoSyncedBdId,
  planDedupe,
  runDedupeBd,
} from "../../src/doctor/dedupe-bd.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import {
  isCanonicalDupClose,
  type BeadsDependency,
  type BeadsRecord,
} from "../../src/triage/triage.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-mock",
    title: "fixture",
    description: "",
    status: "open",
    priority: null,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    updatedAt: null,
    dependencies: [],
    notes: null,
    createdAt: null,
    startedAt: null,
    assignee: null,
    ...overrides,
  };
}

const GH_PIN = "https://github.com/bdelanghe/ai-home/issues/1453";

function autoId(suffix = "abcdef01"): string {
  return `ai-home-1778002085658-8-${suffix}`;
}

function manualId(slug = "1463"): string {
  return `ai-home-${slug}`;
}

function makeOutput() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    output: {
      log: (line: string) => log.push(line),
      error: (line: string) => error.push(line),
    },
    log,
    error,
  };
}

type BdCall = { subcommand: string; args: string[] };

// GH-296 / prx-82b: dep + close writes now run `prx beads dep …` / `prx beads
// update …` through the daemon (a sync runner). The fake records the equivalent
// old `{subcommand, args}` shape from the prx argv (cmd[2] = the bd subcommand,
// cmd.slice(3) = its args) so the existing `calls` assertions hold.
function makeRun(results: BdExecResult[] = []) {
  const calls: BdCall[] = [];
  let idx = 0;
  const run = ((cmd: string[]) => {
    calls.push({ subcommand: cmd[2] ?? "", args: cmd.slice(3) });
    const r = results[idx] ?? { exitCode: 0, stdout: "", stderr: "", policy: null };
    idx += 1;
    return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }) as never;
  return { run, calls };
}

// ─── isAutoSyncedBdId ────────────────────────────────────────────────────────

describe("isAutoSyncedBdId", () => {
  test("recognizes the auto-synced timestamp+hash shape", () => {
    expect(isAutoSyncedBdId(autoId())).toBe(true);
    expect(isAutoSyncedBdId("ai-home-1778002085658-8-144ffa40")).toBe(true);
  });

  test("rejects manual short-hash shapes", () => {
    expect(isAutoSyncedBdId("ai-home-1463")).toBe(false);
    expect(isAutoSyncedBdId("ai-home-mgwqw")).toBe(false);
  });
});

// ─── dedupeBdOptionsSchema ───────────────────────────────────────────────────

describe("dedupeBdOptionsSchema", () => {
  test("defaults apply=false and format=plain", () => {
    const parsed = dedupeBdOptionsSchema.parse({});
    expect(parsed.apply).toBe(false);
    expect(parsed.format).toBe("plain");
  });

  test("only defaults to [] (GH-2379)", () => {
    const parsed = dedupeBdOptionsSchema.parse({});
    expect(parsed.only).toEqual([]);
  });

  test("rejects unknown formats", () => {
    expect(() => dedupeBdOptionsSchema.parse({ format: "csv" })).toThrow();
  });
});

// ─── Fixture (a): auto-synced + manual on same GH pin ────────────────────────

describe("planDedupe — fixture (a): auto+manual cluster", () => {
  const auto = bead({
    id: autoId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
  });
  const manual = bead({
    id: manualId("1463"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
    dependencies: [{ issueId: manualId("1463"), dependsOnId: "ai-home-other", type: "blocks" }],
  });

  test("picks the auto-synced id as canonical despite earlier manual created_at", () => {
    const { clusters } = planDedupe([auto, manual]);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.status).toBe("plan");
    expect(cluster.canonicalId).toBe(auto.id);
    expect(cluster.duplicateIds).toEqual([manual.id]);
    expect(cluster.domain).toBe("gh");
    expect(cluster.externalId).toBe(GH_PIN);
  });

  test("close note carries the §6 marker so isCanonicalDupClose matches", () => {
    const { clusters } = planDedupe([auto, manual]);
    const cluster = clusters[0]!;
    expect(isCanonicalDupClose(cluster.closeNote)).toBe(true);
    expect(cluster.closeNote).toContain(`duplicate of ${auto.id}`);
    expect(cluster.closeNote).toContain("ADR §6");
  });

  test("close argv targets `bd update <dup> -s closed --notes <§6>`", () => {
    const { clusters } = planDedupe([auto, manual]);
    const cluster = clusters[0]!;
    expect(cluster.closeArgv).toHaveLength(1);
    const argv = cluster.closeArgv[0]!;
    expect(argv[0]).toBe(manual.id);
    expect(argv.slice(1, 3)).toEqual(["--status", "closed"]);
    expect(argv[3]).toBe("--notes");
    expect(isCanonicalDupClose(argv[4]!)).toBe(true);
  });

  test("re-anchors the duplicate's outgoing edge to the canonical (remove+add argv)", () => {
    const { clusters } = planDedupe([auto, manual]);
    const cluster = clusters[0]!;
    const out = cluster.edges.filter((e) => e.direction === "outgoing");
    expect(out).toHaveLength(1);
    const edge = out[0]!;
    expect(edge.removeArgv).toEqual(["remove", manual.id, "ai-home-other"]);
    expect(edge.addArgv).toEqual(["add", "--type", "blocks", auto.id, "ai-home-other"]);
  });
});

// ─── Fixture (a): incoming edge re-anchor ─────────────────────────────────────

describe("annotateIncomingEdges — fixture (a): Y → dup re-anchor", () => {
  const auto = bead({
    id: autoId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
  });
  const manual = bead({
    id: manualId("1463"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
  });
  const sibling = bead({
    id: "ai-home-sib",
    dependencies: [{ issueId: "ai-home-sib", dependsOnId: manualId("1463"), type: "parent-child" }],
  });

  test("an incoming `sibling → dup` edge is re-anchored to `sibling → canonical`", () => {
    const { clusters } = planDedupe([auto, manual, sibling]);
    const annotated = annotateIncomingEdges(clusters, [auto, manual, sibling]);
    expect(annotated).toHaveLength(1);
    const cluster = annotated[0]!;
    const incoming = cluster.edges.filter((e) => e.direction === "incoming");
    expect(incoming).toHaveLength(1);
    const edge = incoming[0]!;
    expect(edge.removeArgv).toEqual(["remove", "ai-home-sib", manual.id]);
    expect(edge.addArgv).toEqual(["add", "--type", "parent-child", "ai-home-sib", auto.id]);
  });
});

// ─── Fixture (b): two auto-synced — tie-break on created_at ──────────────────

describe("planDedupe — fixture (b): two auto-synced cluster", () => {
  const earlier = bead({
    id: autoId("00000001"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-14T09:00:00Z",
  });
  const later = bead({
    id: autoId("00000002"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T11:00:00Z",
  });

  test("the earlier-created_at record wins when both ids are auto-synced", () => {
    const { clusters } = planDedupe([later, earlier]);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.canonicalId).toBe(earlier.id);
    expect(cluster.duplicateIds).toEqual([later.id]);
    expect(cluster.status).toBe("plan");
  });
});

// ─── Fixture (c): both with execution state — §6 conflict-abort ──────────────

describe("planDedupe — fixture (c): conflict-abort", () => {
  const a = bead({
    id: autoId("11111111"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
    startedAt: "2026-05-16T09:00:00Z",
    assignee: "Alice <alice@example.com>",
    status: "in_progress",
  });
  const b = bead({
    id: manualId("9999"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
    startedAt: "2026-05-16T10:00:00Z",
    assignee: "Bob <bob@example.com>",
    status: "in_progress",
  });

  test("cluster status flips to `conflict` and emits a reason", () => {
    const { clusters } = planDedupe([a, b]);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.status).toBe("conflict");
    expect(cluster.canonicalId).toBeNull();
    expect(cluster.duplicateIds).toHaveLength(0);
    expect(cluster.closeArgv).toHaveLength(0);
    expect(cluster.edges).toHaveLength(0);
    expect(cluster.conflictReason).toContain("execution state");
    expect(cluster.conflictReason).toContain(a.id);
    expect(cluster.conflictReason).toContain(b.id);
  });
});

// ─── GH-1863: clusters already drained by --apply are suppressed ─────────────

describe("planDedupe — closed-as-dup clusters are suppressed (GH-1863)", () => {
  // §6 close-note shape (matches buildClosedNotePrefixed output and
  // isCanonicalDupClose's regex anchors: `duplicate of … ADR §6`).
  const dupNote = "[prx doctor dedupe-bd] duplicate: duplicate of ai-home-canonical per ADR §6";

  test("auto canonical + closed-§6 manual is not surfaced", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const manual = bead({
      id: manualId("1463"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T09:00:00Z",
      status: "closed",
      notes: dupNote,
    });
    expect(isCanonicalDupClose(manual.notes)).toBe(true);
    const { clusters } = planDedupe([auto, manual]);
    expect(clusters).toEqual([]);
  });

  test("canonical + two closed-§6 manual dups is not surfaced", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const dupA = bead({
      id: manualId("1463"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T09:00:00Z",
      status: "closed",
      notes: dupNote,
    });
    const dupB = bead({
      id: manualId("1464"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T08:00:00Z",
      status: "closed",
      notes: dupNote,
    });
    const { clusters } = planDedupe([auto, dupA, dupB]);
    expect(clusters).toEqual([]);
  });

  test("two open records still surface a cluster (filter doesn't over-fire)", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const manual = bead({
      id: manualId("1463"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T09:00:00Z",
    });
    const { clusters } = planDedupe([auto, manual]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.status).toBe("plan");
  });

  test("closed-but-not-§6 record still surfaces the cluster", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const closedManual = bead({
      id: manualId("1463"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T09:00:00Z",
      status: "closed",
      notes: "closed manually, not a dup",
    });
    expect(isCanonicalDupClose(closedManual.notes)).toBe(false);
    const { clusters } = planDedupe([auto, closedManual]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.status).toBe("plan");
    expect(clusters[0]!.duplicateIds).toEqual([closedManual.id]);
  });

  test("runDedupeBd dry-run reports `0 cluster(s) planned` after --apply drained the cluster", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const manual = bead({
      id: manualId("1463"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T09:00:00Z",
      status: "closed",
      notes: dupNote,
    });
    const { run, calls } = makeRun();
    const { output, log, error } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: false, only: [], format: "plain" }, output, {
      run,
      loadAllBeads: () => [auto, manual],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(error).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]!).toContain("0 cluster(s) planned");
  });
});

// ─── GH-2254: recycled-short-id phantom quarantine ───────────────────────────

describe("planDedupe — recycled-short-id phantom quarantine (GH-2254)", () => {
  // The phantom is a manual short-id closed *before* this run with no §6
  // marker, colliding on the open auto-synced canonical's GH pin.
  const auto = bead({
    id: autoId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
  });
  const phantom = bead({
    id: manualId("2p2ki"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
    status: "closed",
    notes: "closed as GH-136/GH-138 dup",
  });

  test("plans the [open canonical, closed-non-§6 phantom] cluster, phantom is the duplicate", () => {
    const { clusters } = planDedupe([auto, phantom]);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.status).toBe("plan");
    expect(cluster.canonicalId).toBe(auto.id);
    expect(cluster.duplicateIds).toEqual([phantom.id]);
  });

  test("phantom close note keeps the §6 anchors AND names the recycled-id case", () => {
    const { clusters } = planDedupe([auto, phantom]);
    const argv = clusters[0]!.closeArgv[0]!;
    expect(argv[0]).toBe(phantom.id);
    expect(argv.slice(1, 4)).toEqual(["--status", "closed", "--notes"]);
    const note = argv[4]!;
    // §6 anchors preserved → isCanonicalDupClose matches → findDrift/I-DEDUPE-3
    // suppression fires after --apply.
    expect(isCanonicalDupClose(note)).toBe(true);
    expect(note).toContain(`duplicate of ${auto.id}`);
    expect(note).toContain("ADR §6");
    // …and the collision is named so the quarantine is legible.
    expect(note).toContain("recycled short-id phantom");
    expect(note).toContain("GH-2254");
  });

  test("a deliberate (open) duplicate is NOT labelled recycled", () => {
    const openDup = bead({
      ...phantom,
      id: manualId("openish"),
      status: "open",
      notes: null,
    });
    const { clusters } = planDedupe([auto, openDup]);
    const note = clusters[0]!.closeArgv[0]![4]!;
    expect(isCanonicalDupClose(note)).toBe(true);
    expect(note).not.toContain("recycled short-id phantom");
  });

  test("idempotent drain: once the phantom carries the §6 marker the cluster is gone", () => {
    const stamped = bead({
      ...phantom,
      notes:
        "[prx doctor dedupe-bd] duplicate: duplicate of " +
        `${auto.id} per ADR §6 (recycled short-id phantom — GH-2254)`,
    });
    expect(isCanonicalDupClose(stamped.notes)).toBe(true);
    expect(planDedupe([auto, stamped]).clusters).toEqual([]);
  });
});

// ─── findPinCollisions — standing collision detector (GH-2254) ───────────────

describe("findPinCollisions", () => {
  test("flags a pin with an open canonical + closed-non-§6 phantom (>1 unresolved)", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
    });
    const phantom = bead({
      id: manualId("2p2ki"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      status: "closed",
      notes: "closed as a dup, no §6 marker",
    });
    const collisions = findPinCollisions([auto, phantom]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.domain).toBe("gh");
    expect(collisions[0]!.externalId).toBe(GH_PIN);
    expect(collisions[0]!.beadIds).toEqual([auto.id, phantom.id].sort());
  });

  test("a §6-quarantined phantom is resolved → no collision (drains after --apply)", () => {
    const auto = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
    });
    const stamped = bead({
      id: manualId("2p2ki"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      status: "closed",
      notes:
        "[prx doctor dedupe-bd] duplicate: duplicate of " +
        `${auto.id} per ADR §6 (recycled short-id phantom — GH-2254)`,
    });
    expect(findPinCollisions([auto, stamped])).toEqual([]);
  });

  test("a single bead on a pin is not a collision", () => {
    const auto = bead({ id: autoId(), externalRef: GH_PIN, externalRefs: { gh: GH_PIN } });
    expect(findPinCollisions([auto])).toEqual([]);
  });

  test("pin-zero (no external ref) records never collide", () => {
    expect(findPinCollisions([bead({ id: "a" }), bead({ id: "b" })])).toEqual([]);
  });
});

// ─── Pin-zero records are excluded ───────────────────────────────────────────

describe("planDedupe — pin-zero exclusion", () => {
  test("records with no external pins do not form a cluster", () => {
    const a = bead({ id: "ai-home-x1" });
    const b = bead({ id: "ai-home-x2" });
    const { clusters } = planDedupe([a, b]);
    expect(clusters).toHaveLength(0);
  });

  test("a single bead on a unique pin does not form a cluster", () => {
    const solo = bead({
      id: autoId(),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
    });
    const { clusters } = planDedupe([solo]);
    expect(clusters).toHaveLength(0);
  });
});

// ─── runDedupeBd end-to-end: dry-run + apply ─────────────────────────────────

describe("runDedupeBd — dry-run is read-only", () => {
  const auto = bead({
    id: autoId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
  });
  const manual = bead({
    id: manualId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
  });

  test("dry-run emits no bd writes and exits 0", () => {
    const { run, calls } = makeRun();
    const { output, log, error } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: false, only: [], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto, manual],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(error).toEqual([]);
    expect(log).toHaveLength(1);
    const render = JSON.parse(log[0]!);
    expect(render.dryRun).toBe(true);
    expect(render.summary.planned).toBe(1);
    expect(render.summary.applied).toBe(0);
    // dry-run still emits audit rows
    expect(audit.length).toBeGreaterThan(0);
    for (const line of audit) {
      const row = JSON.parse(line);
      expect(row.dryRun).toBe(true);
    }
  });
});

describe("runDedupeBd — --apply writes bd update + dep argv", () => {
  const auto = bead({
    id: autoId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
  });
  const dep: BeadsDependency = {
    issueId: manualId(),
    dependsOnId: "ai-home-target",
    type: "blocks",
  };
  const manual = bead({
    id: manualId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
    dependencies: [dep],
  });

  test("emits dep-remove + dep-add (re-anchor) BEFORE the bd update -s closed", () => {
    const { run, calls } = makeRun();
    const { output } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [], format: "plain" }, output, {
      run,
      loadAllBeads: () => [auto, manual],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(3);

    expect(calls[0]).toEqual({
      subcommand: "dep",
      args: ["remove", manual.id, "ai-home-target"],
    });
    expect(calls[1]).toEqual({
      subcommand: "dep",
      args: ["add", "--type", "blocks", auto.id, "ai-home-target"],
    });

    const closeCall = calls[2]!;
    expect(closeCall.subcommand).toBe("update");
    expect(closeCall.args[0]).toBe(manual.id);
    expect(closeCall.args.slice(1, 3)).toEqual(["--status", "closed"]);
    expect(closeCall.args[3]).toBe("--notes");
    expect(isCanonicalDupClose(closeCall.args[4]!)).toBe(true);
  });
});

describe("runDedupeBd — conflict cluster exits non-zero", () => {
  const a = bead({
    id: autoId("11111111"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
    startedAt: "2026-05-16T09:00:00Z",
    assignee: "Alice",
  });
  const b = bead({
    id: manualId("9999"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
    startedAt: "2026-05-16T10:00:00Z",
    assignee: "Bob",
  });

  test("dry-run with conflict cluster: exit=1, no bd writes, conflict surfaced in render", () => {
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: false, only: [], format: "json" }, output, {
      run,
      loadAllBeads: () => [a, b],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    const render = JSON.parse(log[0]!);
    expect(render.summary.conflicts).toBe(1);
    expect(render.summary.planned).toBe(0);
    expect(render.clusters[0].status).toBe("conflict");
    // conflict audit row was emitted
    const conflictRow = audit
      .map((l) => JSON.parse(l))
      .find((r: { action: string }) => r.action === "conflict");
    expect(conflictRow).toBeDefined();
  });
});

// ─── runDedupeBd — report-only pin collisions wired to the render (GH-2254) ──

describe("runDedupeBd — surfaces pin collisions (GH-2254)", () => {
  const auto = bead({
    id: autoId(),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T10:00:00Z",
  });
  // closed-non-§6 phantom: unresolved per findPinCollisions, collides on the pin.
  const phantom = bead({
    id: manualId("2p2ki"),
    externalRef: GH_PIN,
    externalRefs: { gh: GH_PIN },
    createdAt: "2026-05-15T09:00:00Z",
    status: "closed",
    notes: "closed as GH-136/GH-138 dup",
  });

  test("dry-run surfaces the collision in render; collisions do not bump exitCode; no bd writes", () => {
    const { run, calls } = makeRun();
    const { output, log, error } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: false, only: [], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto, phantom],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(error).toEqual([]);
    const render = JSON.parse(log[0]!);
    expect(render.collisions).toHaveLength(1);
    expect(render.collisions[0].domain).toBe("gh");
    expect(render.collisions[0].externalId).toBe(GH_PIN);
    expect(render.collisions[0].beadIds).toEqual([auto.id, phantom.id].sort());
    expect(render.summary.collisions).toBe(1);
  });

  test("--apply still mutates only the dedupe cluster; collision is reported alongside", () => {
    // The phantom cluster IS a legitimate dedupe (auto canonical + closed-non-§6
    // dup), so --apply closes the phantom. The collision report is additive and
    // adds no extra bd writes of its own.
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto, phantom],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    expect(exitCode).toBe(0);
    // Exactly one write: the §6 close of the phantom. No edges → no dep calls.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subcommand).toBe("update");
    expect(calls[0]!.args[0]).toBe(phantom.id);
    const render = JSON.parse(log[0]!);
    expect(render.collisions).toHaveLength(1);
    expect(render.summary.collisions).toBe(1);
  });

  test("collision-only path under --apply performs NO mutation (conflict cluster)", () => {
    // Both records carry execution state → §6 conflict-abort: planDedupe yields
    // no plannable cluster, so --apply writes nothing. The pin still collides
    // (>1 unresolved) and is reported. Proves the collision report is read-only.
    const inflightA = bead({
      id: autoId("11111111"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T09:00:00Z",
      startedAt: "2026-05-16T09:00:00Z",
      assignee: "Alice",
    });
    const inflightB = bead({
      id: manualId("9999"),
      externalRef: GH_PIN,
      externalRefs: { gh: GH_PIN },
      createdAt: "2026-05-15T10:00:00Z",
      startedAt: "2026-05-16T10:00:00Z",
      assignee: "Bob",
    });
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [], format: "json" }, output, {
      run,
      loadAllBeads: () => [inflightA, inflightB],
      auditSink: {
        stateDirOverride: "/tmp/state",
        appendFn: (_p: string, line: string) => audit.push(line),
        ensureDir: () => {},
      },
    });
    // exit=1 comes from the conflict, NOT the collision.
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    const render = JSON.parse(log[0]!);
    expect(render.summary.planned).toBe(0);
    expect(render.summary.conflicts).toBe(1);
    expect(render.collisions).toHaveLength(1);
    expect(render.collisions[0].beadIds).toEqual([inflightA.id, inflightB.id].sort());
    expect(render.summary.collisions).toBe(1);
  });
});

// ─── formatRender — plain text shape ─────────────────────────────────────────

describe("formatRender", () => {
  test("plain summary calls out plan, conflicts, applied counts", () => {
    const render = {
      apply: false,
      dryRun: true,
      clusters: [],
      collisions: [],
      summary: {
        scanned: 0,
        planned: 0,
        applied: 0,
        conflicts: 0,
        collisions: 0,
        errors: 0,
        skipped: 0,
      },
      exitCode: 0,
    };
    const out = formatRender(render, "plain");
    expect(out).toContain("dry-run");
    expect(out).toContain("0 cluster(s) planned");
    expect(out).toContain("no duplicate clusters detected");
  });

  test("plain summary highlights conflict clusters", () => {
    const render = {
      apply: false,
      dryRun: true,
      clusters: [
        {
          domain: "gh",
          externalId: GH_PIN,
          canonicalId: null,
          duplicateIds: [] as string[],
          status: "conflict" as const,
          conflictReason: "two records in flight",
          closeNote: "",
          closeArgv: [] as string[][],
          edges: [] as never[],
        },
      ],
      collisions: [],
      summary: {
        scanned: 1,
        planned: 0,
        applied: 0,
        conflicts: 1,
        collisions: 0,
        errors: 0,
        skipped: 0,
      },
      exitCode: 1,
    };
    const out = formatRender(render, "plain");
    expect(out).toContain("CONFLICT");
    expect(out).toContain("two records in flight");
  });

  test("plain render lists a report-only collision section (GH-2254)", () => {
    const render = {
      apply: false,
      dryRun: true,
      clusters: [],
      collisions: [
        { domain: "gh", externalId: GH_PIN, beadIds: ["ai-home-canonical", "ai-home-phantom"] },
      ],
      summary: {
        scanned: 0,
        planned: 0,
        applied: 0,
        conflicts: 0,
        collisions: 1,
        errors: 0,
        skipped: 0,
      },
      exitCode: 0,
    };
    const out = formatRender(render, "plain");
    expect(out).toContain("1 pin collision(s)");
    expect(out).toContain("pin collisions (report-only — GH-2254)");
    expect(out).toContain("COLLISION (gh,");
    expect(out).toContain("ai-home-canonical");
    expect(out).toContain("ai-home-phantom");
  });
});

// ─── GH-2379: `--only` scopes the apply set ──────────────────────────────────

describe("runDedupeBd — --only selector scopes the apply set", () => {
  // Three distinct pins, each a 2-record auto(canonical)+manual(dup) cluster.
  // Cluster 1's dup carries one outgoing edge so its apply fires
  // dep-remove + dep-add + close (3 bd writes); clusters 2/3 are close-only.
  const PIN1 = "https://github.com/bdelanghe/ai-home/issues/2001";
  const PIN2 = "https://github.com/bdelanghe/ai-home/issues/2002";
  const PIN3 = "https://github.com/bdelanghe/ai-home/issues/2003";

  function fixture() {
    const auto1 = bead({
      id: autoId("c1c1c1c1"),
      externalRef: PIN1,
      externalRefs: { gh: PIN1 },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const manual1 = bead({
      id: manualId("c1"),
      externalRef: PIN1,
      externalRefs: { gh: PIN1 },
      createdAt: "2026-05-15T09:00:00Z",
      dependencies: [{ issueId: manualId("c1"), dependsOnId: "ai-home-target1", type: "blocks" }],
    });
    const auto2 = bead({
      id: autoId("c2c2c2c2"),
      externalRef: PIN2,
      externalRefs: { gh: PIN2 },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const manual2 = bead({
      id: manualId("c2"),
      externalRef: PIN2,
      externalRefs: { gh: PIN2 },
      createdAt: "2026-05-15T09:00:00Z",
    });
    const auto3 = bead({
      id: autoId("c3c3c3c3"),
      externalRef: PIN3,
      externalRefs: { gh: PIN3 },
      createdAt: "2026-05-15T10:00:00Z",
    });
    const manual3 = bead({
      id: manualId("c3"),
      externalRef: PIN3,
      externalRefs: { gh: PIN3 },
      createdAt: "2026-05-15T09:00:00Z",
    });
    return { auto1, manual1, auto2, manual2, auto3, manual3 };
  }

  function makeSink(audit: string[]) {
    return {
      stateDirOverride: "/tmp/state",
      appendFn: (_p: string, line: string) => audit.push(line),
      ensureDir: () => {},
    };
  }

  test("--apply --only <pin> applies only the selected cluster (required AC)", () => {
    const { auto1, manual1, auto2, manual2, auto3, manual3 } = fixture();
    const { run, calls } = makeRun();
    const { output, log, error } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [PIN1], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto1, manual1, auto2, manual2, auto3, manual3],
      auditSink: makeSink(audit),
    });
    expect(exitCode).toBe(0);
    expect(error).toEqual([]);

    // Exactly cluster 1's three writes fire, in re-anchor-before-close order.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      subcommand: "dep",
      args: ["remove", manual1.id, "ai-home-target1"],
    });
    expect(calls[1]).toEqual({
      subcommand: "dep",
      args: ["add", "--type", "blocks", auto1.id, "ai-home-target1"],
    });
    expect(calls[2]!.subcommand).toBe("update");
    expect(calls[2]!.args[0]).toBe(manual1.id);

    // The other two clusters' ids never appear in any bd write.
    const flat = calls.flatMap((c) => c.args);
    for (const id of [auto2.id, manual2.id, auto3.id, manual3.id]) {
      expect(flat).not.toContain(id);
    }

    const render = JSON.parse(log[0]!);
    expect(render.summary.planned).toBe(3);
    expect(render.summary.applied).toBe(2); // 1 edge re-anchor + 1 close
    expect(render.summary.skipped).toBe(2);
    expect(render.summary.conflicts).toBe(0);
  });

  test("--only resolves a cluster by its canonical bd id", () => {
    const { auto1, manual1, auto2, manual2, auto3, manual3 } = fixture();
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [auto1.id], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto1, manual1, auto2, manual2, auto3, manual3],
      auditSink: makeSink(audit),
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.args[0]).toBe(manual1.id);
    expect(JSON.parse(log[0]!).summary.skipped).toBe(2);
  });

  test("--only resolves a cluster by a duplicate bd id", () => {
    const { auto1, manual1, auto2, manual2, auto3, manual3 } = fixture();
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [manual1.id], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto1, manual1, auto2, manual2, auto3, manual3],
      auditSink: makeSink(audit),
    });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.args[0]).toBe(manual1.id);
    expect(JSON.parse(log[0]!).summary.skipped).toBe(2);
  });

  test("multiple --only flags apply the union", () => {
    const { auto1, manual1, auto2, manual2, auto3, manual3 } = fixture();
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [PIN1, PIN2], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto1, manual1, auto2, manual2, auto3, manual3],
      auditSink: makeSink(audit),
    });
    expect(exitCode).toBe(0);
    // cluster1: remove+add+close (3); cluster2: close-only (1) = 4 writes.
    expect(calls).toHaveLength(4);
    const flat = calls.flatMap((c) => c.args);
    expect(flat).toContain(manual1.id);
    expect(flat).toContain(manual2.id);
    expect(flat).not.toContain(manual3.id);
    const render = JSON.parse(log[0]!);
    expect(render.summary.applied).toBe(3); // (1 edge + 1 close) + 1 close
    expect(render.summary.skipped).toBe(1);
  });

  test("unmatched --only selector surfaces an error, exits non-zero, writes nothing", () => {
    const { auto1, manual1, auto2, manual2, auto3, manual3 } = fixture();
    const { run, calls } = makeRun();
    const { output, error } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd(
      { apply: true, only: ["ai-home-does-not-exist"], format: "json" },
      output,
      {
        run,
        loadAllBeads: () => [auto1, manual1, auto2, manual2, auto3, manual3],
        auditSink: makeSink(audit),
      },
    );
    expect(exitCode).toBe(1);
    expect(error.length).toBeGreaterThan(0);
    expect(error.some((l) => l.includes("matched no cluster"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("--only without --apply is rejected at the verb (belt-and-suspenders)", () => {
    const { auto1, manual1 } = fixture();
    const { run, calls } = makeRun();
    const { output, error } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: false, only: [PIN1], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto1, manual1],
      auditSink: makeSink(audit),
    });
    expect(exitCode).toBe(1);
    expect(error.some((l) => l.includes("--only requires --apply"))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("regression — --apply with no --only applies every cluster, skipped=0", () => {
    const { auto1, manual1, auto2, manual2, auto3, manual3 } = fixture();
    const { run, calls } = makeRun();
    const { output, log } = makeOutput();
    const audit: string[] = [];
    const exitCode = runDedupeBd({ apply: true, only: [], format: "json" }, output, {
      run,
      loadAllBeads: () => [auto1, manual1, auto2, manual2, auto3, manual3],
      auditSink: makeSink(audit),
    });
    expect(exitCode).toBe(0);
    // cluster1: 3 writes; clusters 2 & 3: 1 close each = 5 total.
    expect(calls).toHaveLength(5);
    const render = JSON.parse(log[0]!);
    expect(render.summary.planned).toBe(3);
    expect(render.summary.applied).toBe(4); // (1 edge + 1 close) + 1 + 1
    expect(render.summary.skipped).toBe(0);
  });
});
