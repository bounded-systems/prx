import { describe, expect, test } from "bun:test";

import {
  __test as promoteChildrenInternals,
  runPromoteChildrenActor,
  runTriagePromoteChildren,
} from "../../src/triage/promote-children.ts";
import type { TriagePromoteChildrenDeps } from "../../src/triage/promote-children.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import { buildBeadsLookup } from "../../src/issues/dedupe.ts";
import type { PromoteChildrenFiledRow } from "../../src/triage/schemas/promote-children.ts";
import {
  promoteChildBodySchema,
  type PromoteChildrenManifest,
} from "../../src/triage/schemas/promote-children.ts";

const NOW = new Date("2026-05-03T12:00:00.000Z");

function makeOutput() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    output: { log: (l: string) => log.push(l), error: (l: string) => error.push(l) },
    log,
    error,
  };
}

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-fixture",
    title: "stub",
    description: "",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function manifestFixture(
  overrides: Partial<PromoteChildrenManifest> = {},
): PromoteChildrenManifest {
  return {
    parentUnit: "GH-1290",
    parentBead: "ai-home-1290",
    generatedAt: "2026-05-02T00:00:00.000Z",
    bodies: [
      {
        slot: "view",
        file: "01-view.md",
        type: "feature",
        title: "feat: view layer",
        scope: "prx",
      },
      { slot: "comment", file: "02-comment.md", type: "feature", title: "feat: comment helper" },
    ],
    deps: [
      { type: "parent-child", from: "view", to: "GH-1290" },
      { type: "blocks", from: "view", to: "comment" },
    ],
    ...overrides,
  };
}

/**
 * Build a deps stub backed by an in-memory FS map. The manifest is keyed at
 * `<dir>/manifest.json`; body files live at `<dir>/<file>` and don't need
 * real content (intake is mocked). `.filed.json` is read/written through the
 * same FS map so re-runs see prior state.
 */
function makeDeps(args: {
  dir: string;
  manifest: PromoteChildrenManifest | null;
  preFiled?: Array<{ slot: string; number: number; url: string }>;
  intakeImpl?: TriagePromoteChildrenDeps["runIntake"];
  execBdImpl?: TriagePromoteChildrenDeps["execBd"];
  runImpl?: TriagePromoteChildrenDeps["run"];
  beads?: BeadsRecord[];
}): {
  deps: TriagePromoteChildrenDeps;
  audit: string[];
  fs: Map<string, string>;
  bdCalls: Array<{ subcommand: string; args: string[] }>;
  intakeCalls: number;
} {
  const audit: string[] = [];
  const fs = new Map<string, string>();
  const bdCalls: Array<{ subcommand: string; args: string[] }> = [];
  let intakeCalls = 0;

  if (args.manifest) {
    fs.set(`${args.dir}/manifest.json`, JSON.stringify(args.manifest));
  }
  if (args.preFiled && args.preFiled.length > 0) {
    fs.set(`${args.dir}/.filed.json`, JSON.stringify({ rows: args.preFiled }));
  }

  const execBdImpl: TriagePromoteChildrenDeps["execBd"] =
    args.execBdImpl ??
    ((opts) => {
      bdCalls.push({ subcommand: opts.subcommand, args: opts.args });
      return { exitCode: 0, stdout: "", stderr: "", policy: null } as BdExecResult;
    });

  const intakeImpl: TriagePromoteChildrenDeps["runIntake"] =
    args.intakeImpl ??
    ((opts, output) => {
      intakeCalls += 1;
      const number = 2000 + intakeCalls;
      const url = `https://github.com/bdelanghe/ai-home/issues/${number}`;
      output.log(
        JSON.stringify({
          ghArgs: [],
          title: opts.title,
          body: "",
          repo: null,
          surfacedFrom: null,
          dryRun: false,
          ghResult: { exitCode: 0, stdout: "", stderr: "", issueUrl: url },
          beadLink: null,
          exitCode: 0,
        }),
      );
      return 0;
    });

  // GH-296 / prx-82b: dep edges write via the daemon (`prx beads dep add …`).
  // The fake runner records the equivalent old `{subcommand:"dep", args}` shape
  // so the existing bdCalls assertions hold. `runImpl` overrides for failures.
  const run =
    args.runImpl ??
    ((cmd: string[]) => {
      bdCalls.push({ subcommand: cmd[2] ?? "", args: cmd.slice(3) });
      return { status: 0, stdout: "", stderr: "" };
    });

  const deps: TriagePromoteChildrenDeps = {
    runIntake: intakeImpl,
    execBd: execBdImpl,
    run: run as never,
    loadAllBeads: () => args.beads ?? [],
    readFileSync: (path) => {
      const data = fs.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return data;
    },
    writeFileSyncFn: (path, data) => fs.set(path, data),
    existsSyncFn: (path) => fs.has(path),
    auditSink: {
      stateDirOverride: "/fixtures/state",
      ensureDir: () => {},
      appendFn: (_path: string, line: string) => audit.push(line),
    },
    now: () => NOW,
  };
  return { deps, audit, fs, bdCalls, intakeCalls: 0 as never };
}

// GH-1489: spike was removed from `INTAKE_TYPES` (the bd-axis types). Manifest
// bodies enforce the narrowed enum so spike-shaped staging is mechanically
// refused — operators must come through `prx intake spike` directly so the
// GH-only `type::spike` marker is stamped on the bd-axis `type::task` issue.
describe("promoteChildBodySchema — spike refusal (GH-1489)", () => {
  test("rejects type:'spike' in a manifest body row", () => {
    const result = promoteChildBodySchema.safeParse({
      slot: "explore-x",
      file: "01-explore.md",
      type: "spike",
      title: "spike: explore X",
      scope: "prx",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("type");
      // Zod surfaces the valid options on rejection — assert the bd-axis
      // types are listed and `spike` is not among them.
      const message = JSON.stringify(result.error.issues);
      expect(message).toContain("bug");
      expect(message).toContain("task");
    }
  });

  test("accepts the four bd-axis types unchanged", () => {
    for (const type of ["bug", "task", "feature", "chore"] as const) {
      const result = promoteChildBodySchema.safeParse({
        slot: `slot-${type}`,
        file: `${type}.md`,
        type,
        title: `${type}: do it`,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("runTriagePromoteChildren — refusal contract", () => {
  test("missing manifest.json returns exit 2 with upstream pointer", () => {
    const { deps } = makeDeps({ dir: "/fixtures/staging-empty", manifest: null });
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging-empty", dryRun: false, limit: 0 },
      o.output,
      deps,
    );
    expect(code).toBe(2);
    expect(o.error.join("\n")).toMatch(/missing manifest\.json/);
    expect(o.error.join("\n")).toMatch(/GH-1186/);
  });

  test("malformed JSON manifest returns exit 2", () => {
    const fs = new Map<string, string>();
    fs.set("/fixtures/bad/manifest.json", "{ not json");
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/bad", dryRun: false, limit: 0 },
      o.output,
      {
        readFileSync: (path) => {
          const v = fs.get(path);
          if (v === undefined) throw new Error("ENOENT");
          return v;
        },
        existsSyncFn: (p) => fs.has(p),
        auditSink: {
          stateDirOverride: "/fixtures/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        now: () => NOW,
      },
    );
    expect(code).toBe(2);
    expect(o.error.join("\n")).toMatch(/not valid JSON/);
  });
});

describe("runTriagePromoteChildren — dry-run", () => {
  test("dry-run writes nothing and exits 0", () => {
    const { deps, audit, fs, bdCalls } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture(),
    });
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: true, limit: 0 },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(audit).toHaveLength(0);
    expect(bdCalls).toHaveLength(0);
    // No `.filed.json` written
    expect(fs.has("/fixtures/staging/.filed.json")).toBe(false);
    // Plan summary printed
    expect(o.log.join("\n")).toMatch(/dry-run slot=view/);
    expect(o.log.join("\n")).toMatch(/creates=2/);
    expect(o.log.join("\n")).toMatch(/deps-wired=2/);
  });
});

describe("runTriagePromoteChildren — file + wire path", () => {
  test("files all bodies, persists .filed.json, wires deps via bd dep add", () => {
    const beads: BeadsRecord[] = []; // populated by callback as filings happen
    const { deps, audit, fs, bdCalls } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture(),
      beads,
    });
    // Override loadAllBeads so the deps phase sees the just-filed children
    // mirrored into bd (simulates bd github sync having caught up).
    deps.loadAllBeads = () => [
      bead({
        id: "ai-home-2001-x",
        externalRef: "https://github.com/bdelanghe/ai-home/issues/2001",
        externalIssueNumber: 2001,
      }),
      bead({
        id: "ai-home-2002-x",
        externalRef: "https://github.com/bdelanghe/ai-home/issues/2002",
        externalIssueNumber: 2002,
      }),
      bead({
        id: "ai-home-1290-x",
        externalRef: "https://github.com/bdelanghe/ai-home/issues/1290",
        externalIssueNumber: 1290,
      }),
    ];
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: false, limit: 0 },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    // .filed.json now persisted with both slots
    const filed = JSON.parse(fs.get("/fixtures/staging/.filed.json")!);
    expect(filed.rows).toHaveLength(2);
    expect(filed.rows.map((r: { slot: string }) => r.slot).sort()).toEqual(["comment", "view"]);
    // Two body audit rows, two dep audit rows
    const entries = audit.map((l) => JSON.parse(l));
    const bodyRows = entries.filter((e) => e.kind === "body");
    const depRows = entries.filter((e) => e.kind === "dep");
    expect(bodyRows).toHaveLength(2);
    expect(depRows).toHaveLength(2);
    expect(bodyRows.every((r) => r.action === "create")).toBe(true);
    expect(depRows.every((r) => r.action === "wire")).toBe(true);
    // bd dep add called with the resolved long IDs
    expect(bdCalls).toHaveLength(2);
    expect(bdCalls[0]!.subcommand).toBe("dep");
    expect(bdCalls[0]!.args[0]!).toBe("add");
    expect(bdCalls[0]!.args).toContain("--type");
    expect(bdCalls[0]!.args).toContain("parent-child");
    expect(bdCalls[0]!.args.slice(-2)).toEqual(["ai-home-2001-x", "ai-home-1290-x"]);
    // blocks edge: view → comment
    expect(bdCalls[1]!.args).toContain("blocks");
    expect(bdCalls[1]!.args.slice(-2)).toEqual(["ai-home-2001-x", "ai-home-2002-x"]);
  });
});

describe("runTriagePromoteChildren — idempotency", () => {
  test("re-run with .filed.json skips already-filed slots", () => {
    const { deps, audit } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture(),
      preFiled: [
        { slot: "view", number: 2001, url: "https://github.com/bdelanghe/ai-home/issues/2001" },
        { slot: "comment", number: 2002, url: "https://github.com/bdelanghe/ai-home/issues/2002" },
      ],
      beads: [
        bead({
          id: "ai-home-2001-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/2001",
          externalIssueNumber: 2001,
        }),
        bead({
          id: "ai-home-2002-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/2002",
          externalIssueNumber: 2002,
        }),
        bead({
          id: "ai-home-1290-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/1290",
          externalIssueNumber: 1290,
        }),
      ],
    });
    let intakeCount = 0;
    deps.runIntake = () => {
      intakeCount += 1;
      return 0;
    };
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: false, limit: 0 },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(intakeCount).toBe(0);
    const bodyRows = audit.map((l) => JSON.parse(l)).filter((e) => e.kind === "body");
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows.every((r) => r.action === "skip")).toBe(true);
  });
});

describe("runTriagePromoteChildren — IntakeTitleMismatchError row-level continue", () => {
  test("intake exit 2 with title-prefix stderr aborts slot, continues run", () => {
    const { deps, audit, fs } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture(),
      intakeImpl: (opts, output) => {
        if (opts.title.includes("view layer")) {
          output.error(
            "prx intake: title prefix 'fix' disagrees with intake type 'feature' — re-run as 'prx intake bug ...'",
          );
          return 2;
        }
        const url = `https://github.com/bdelanghe/ai-home/issues/2042`;
        output.log(
          JSON.stringify({
            ghArgs: [],
            title: opts.title,
            body: "",
            repo: null,
            surfacedFrom: null,
            dryRun: false,
            ghResult: { exitCode: 0, stdout: "", stderr: "", issueUrl: url },
            beadLink: null,
            exitCode: 0,
          }),
        );
        return 0;
      },
      beads: [
        bead({
          id: "ai-home-2042-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/2042",
          externalIssueNumber: 2042,
        }),
        bead({
          id: "ai-home-1290-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/1290",
          externalIssueNumber: 1290,
        }),
      ],
    });
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: false, limit: 0 },
      o.output,
      deps,
    );
    // Title mismatch → 1 body error AND a dep skipped (view unfiled), so exit 1
    expect(code).toBe(1);
    const bodyRows = audit.map((l) => JSON.parse(l)).filter((e) => e.kind === "body");
    expect(bodyRows).toHaveLength(2);
    const mismatch = bodyRows.find((r) => r.slot === "view");
    expect(mismatch.action).toBe("title-mismatch");
    expect(mismatch.exitCode).toBe(2);
    const ok = bodyRows.find((r) => r.slot === "comment");
    expect(ok.action).toBe("create");
    expect(ok.url).toContain("/issues/2042");
    // Comment slot got persisted; view did not.
    const filed = JSON.parse(fs.get("/fixtures/staging/.filed.json")!);
    expect(filed.rows).toHaveLength(1);
    expect(filed.rows[0].slot).toBe("comment");
  });
});

describe("runTriagePromoteChildren — dep ref forms", () => {
  test("literal ai-home-* ref is passed through to bd dep add unchanged", () => {
    const { deps, audit, bdCalls } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture({
        bodies: [{ slot: "view", file: "01-view.md", type: "feature", title: "feat: view" }],
        deps: [
          // Literal long-form bd id should pass straight through.
          { type: "blocks", from: "view", to: "ai-home-1777747197453-642-b5d5d951" },
        ],
      }),
      beads: [
        bead({
          id: "ai-home-9000-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/9000",
          externalIssueNumber: 9000,
        }),
      ],
      intakeImpl: (opts, output) => {
        output.log(
          JSON.stringify({
            ghArgs: [],
            title: opts.title,
            body: "",
            repo: null,
            surfacedFrom: null,
            dryRun: false,
            ghResult: {
              exitCode: 0,
              stdout: "",
              stderr: "",
              issueUrl: "https://github.com/bdelanghe/ai-home/issues/9000",
            },
            beadLink: null,
            exitCode: 0,
          }),
        );
        return 0;
      },
    });
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: false, limit: 0 },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.args.slice(-2)).toEqual([
      "ai-home-9000-x",
      "ai-home-1777747197453-642-b5d5d951",
    ]);
    const depRows = audit.map((l) => JSON.parse(l)).filter((e) => e.kind === "dep");
    expect(depRows[0].action).toBe("wire");
    expect(depRows[0].toBead).toBe("ai-home-1777747197453-642-b5d5d951");
  });

  test("GH-N ref with no matching beads row records skip (sync-lag case)", () => {
    const { deps, audit, bdCalls } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture({
        bodies: [{ slot: "view", file: "01-view.md", type: "feature", title: "feat: view" }],
        deps: [{ type: "parent-child", from: "view", to: "GH-9999" }],
      }),
      beads: [
        bead({
          id: "ai-home-9000-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/9000",
          externalIssueNumber: 9000,
        }),
      ],
      intakeImpl: (opts, output) => {
        output.log(
          JSON.stringify({
            ghArgs: [],
            title: opts.title,
            body: "",
            repo: null,
            surfacedFrom: null,
            dryRun: false,
            ghResult: {
              exitCode: 0,
              stdout: "",
              stderr: "",
              issueUrl: "https://github.com/bdelanghe/ai-home/issues/9000",
            },
            beadLink: null,
            exitCode: 0,
          }),
        );
        return 0;
      },
    });
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: false, limit: 0 },
      o.output,
      deps,
    );
    // dep-skipped → exit 1 (re-run will retry once sync catches up)
    expect(code).toBe(1);
    expect(bdCalls).toHaveLength(0);
    const depRows = audit.map((l) => JSON.parse(l)).filter((e) => e.kind === "dep");
    expect(depRows[0].action).toBe("skip");
    expect(depRows[0].stderr).toMatch(/no beads row found for GH-9999/);
  });
});

describe("runTriagePromoteChildren — --only filter", () => {
  test("--only restricts to a single slot and skips deps whose other endpoint is unfiled", () => {
    const { deps, audit, fs } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture(),
      beads: [
        bead({
          id: "ai-home-2001-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/2001",
          externalIssueNumber: 2001,
        }),
        bead({
          id: "ai-home-1290-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/1290",
          externalIssueNumber: 1290,
        }),
      ],
      intakeImpl: (opts, output) => {
        // Only `view` slot reaches intake; mock returns GH-2001
        output.log(
          JSON.stringify({
            ghArgs: [],
            title: opts.title,
            body: "",
            repo: null,
            surfacedFrom: null,
            dryRun: false,
            ghResult: {
              exitCode: 0,
              stdout: "",
              stderr: "",
              issueUrl: "https://github.com/bdelanghe/ai-home/issues/2001",
            },
            beadLink: null,
            exitCode: 0,
          }),
        );
        return 0;
      },
    });
    const o = makeOutput();
    const code = runTriagePromoteChildren(
      { dir: "/fixtures/staging", dryRun: false, limit: 0, only: "view" },
      o.output,
      deps,
    );
    // view→GH-1290 wires; view→comment edge skipped (comment unfiled), exit 1.
    expect(code).toBe(1);
    const bodyRows = audit.map((l) => JSON.parse(l)).filter((e) => e.kind === "body");
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0].slot).toBe("view");
    const filed = JSON.parse(fs.get("/fixtures/staging/.filed.json")!);
    expect(filed.rows).toHaveLength(1);
    const depRows = audit.map((l) => JSON.parse(l)).filter((e) => e.kind === "dep");
    const wired = depRows.filter((r) => r.action === "wire");
    const skipped = depRows.filter((r) => r.action === "skip");
    expect(wired).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});

// GH-1473: a short `ai-home-N` dep ref must resolve through beads
// `byIssueNumber.get(N)` — never pass verbatim to bd, whose prefix-ID resolver
// substring-matches the short number against the timestamp segment of an
// unrelated long id and silently miswires the edge. The three pairs below are
// the documented wrong matches: the buggy bd resolver mapped `ai-home-1463` →
// GH-482's long id (1463 ⊂ 482's bd timestamp), etc. The fix must pick the
// issue-1463 bead by number, never the GH-482 bead.
describe("resolveDepRef — short ai-home-N never reaches bd (GH-1473)", () => {
  const { resolveDepRef } = promoteChildrenInternals;
  const emptyFiled = new Map<string, PromoteChildrenFiledRow>();

  // [short ref, the GH issue its N actually denotes, the GH issue bd wrongly
  //  fuzzy-matched it to]
  const documentedMiswires: Array<[string, number, number]> = [
    ["ai-home-1463", 1463, 482],
    ["ai-home-1464", 1464, 1419],
    ["ai-home-1404", 1404, 767],
  ];

  function lookupFor(pairs: Array<[number, number]>) {
    // Seed both the correct issue (by number) and the wrong-match issue so the
    // assertion proves resolution is by issue number, not fuzzy substring.
    const records: BeadsRecord[] = [];
    for (const [correct, wrong] of pairs) {
      records.push(
        bead({
          id: `ai-home-correct-${correct}`,
          externalRef: `https://github.com/bdelanghe/ai-home/issues/${correct}`,
          externalIssueNumber: correct,
        }),
        bead({
          id: `ai-home-wrongmatch-${wrong}`,
          externalRef: `https://github.com/bdelanghe/ai-home/issues/${wrong}`,
          externalIssueNumber: wrong,
        }),
      );
    }
    return buildBeadsLookup(records);
  }

  test("resolves each short ref to the issue-N bead, not the fuzzy-match bead", () => {
    const lookup = lookupFor(documentedMiswires.map(([, c, w]) => [c, w]));
    for (const [ref, correct, wrong] of documentedMiswires) {
      const resolved = resolveDepRef(ref, emptyFiled, lookup, false);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.bdId).toBe(`ai-home-correct-${correct}`);
        expect(resolved.bdId).not.toBe(`ai-home-wrongmatch-${wrong}`);
        expect(resolved.ghNumber).toBe(correct);
      }
    }
  });

  test("errors (does not pass short id through) when no beads row exists", () => {
    const lookup = buildBeadsLookup([]);
    const resolved = resolveDepRef("ai-home-1463", emptyFiled, lookup, false);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toMatch(/no beads row found for ai-home-1463/);
    }
  });

  test("dry-run yields a synthetic placeholder, never the raw short id", () => {
    const lookup = buildBeadsLookup([]);
    const resolved = resolveDepRef("ai-home-1463", emptyFiled, lookup, true);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.bdId).toBe("(dry-run:ai-home-1463)");
      expect(resolved.bdId).not.toBe("ai-home-1463");
    }
  });

  test("canonical long ids still pass through verbatim (no regression)", () => {
    const lookup = buildBeadsLookup([]);
    const longId = "ai-home-1777747197453-642-b5d5d951";
    const resolved = resolveDepRef(longId, emptyFiled, lookup, false);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.bdId).toBe(longId);
      expect(resolved.ghNumber).toBeNull();
    }
  });
});

describe("runPromoteChildrenActor", () => {
  test("captures stdout/stderr, audit, and filed[] envelope", () => {
    const { deps } = makeDeps({
      dir: "/fixtures/staging",
      manifest: manifestFixture({
        bodies: [{ slot: "view", file: "01-view.md", type: "feature", title: "feat: view" }],
        deps: [],
      }),
      beads: [
        bead({
          id: "ai-home-2001-x",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/2001",
          externalIssueNumber: 2001,
        }),
      ],
      intakeImpl: (opts, output) => {
        output.log(
          JSON.stringify({
            ghArgs: [],
            title: opts.title,
            body: "",
            repo: null,
            surfacedFrom: null,
            dryRun: false,
            ghResult: {
              exitCode: 0,
              stdout: "",
              stderr: "",
              issueUrl: "https://github.com/bdelanghe/ai-home/issues/2001",
            },
            beadLink: null,
            exitCode: 0,
          }),
        );
        return 0;
      },
    });
    const result = runPromoteChildrenActor(
      { dir: "/fixtures/staging", dryRun: false, limit: 0 },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(result.filed).toEqual([
      { slot: "view", number: 2001, url: "https://github.com/bdelanghe/ai-home/issues/2001" },
    ]);
    expect(result.audit.length).toBeGreaterThan(0);
  });
});
