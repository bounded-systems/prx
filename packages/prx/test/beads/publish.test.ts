import { describe, expect, test } from "bun:test";

import {
  beadsPublishOptionsSchema,
  formatBeadsPublishRender,
  runBeadsPublish,
  runBeadsPublishUnit,
  type BeadsPublishAuditEntry,
  type BeadsPublishDeps,
  type BeadsPublishOptions,
} from "../../src/beads/publish.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { GhExecResult } from "@bounded-systems/gh";
import type { GhIssueCreateResult } from "../../src/tools/gh_issue_create.ts";
import type { execGhIssueEdit, GhIssueEditOptions } from "../../src/tools/gh_issue_edit.ts";
import { GhDomainAdapter } from "../../src/adapters/github.ts";
import type { AdapterCommandRunner } from "../../src/adapters/domain-adapter.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import type { FallbackIssue } from "../../src/pr-state/github.ts";

const REPO = "owner/repo";

function makeOpts(overrides: Partial<BeadsPublishOptions> = {}): BeadsPublishOptions {
  return beadsPublishOptionsSchema.parse({ bdId: "ai-home-target", repo: REPO, ...overrides });
}

function makeBead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-target",
    title: "Wire the publish verb",
    description: "Body text.",
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

function bdOk(stdout = ""): BdExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}
function bdFail(stderr: string, code = 1): BdExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}
function ghCreateOk(url: string): GhIssueCreateResult {
  return { exitCode: 0, stdout: `${url}\n`, stderr: "", issueUrl: url };
}
function ghCreateFail(stderr: string, code = 1): GhIssueCreateResult {
  return { exitCode: code, stdout: "", stderr, issueUrl: null };
}
function ghExecOk(): GhExecResult {
  return { exitCode: 0, stdout: "", stderr: "", policy: null };
}
function ghExecFail(stderr: string, code = 1): GhExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}

type GhCreateCall = { title: string; body?: string; repo?: string; labels?: readonly string[] };
type GhExecCall = {
  group: string;
  subcommand: string;
  args: string[];
  state?: string;
  role?: string;
};
type BdUpdateCall = { subcommand: string; args: string[]; state?: string; role?: string };

const FIXED_NOW = new Date("2026-05-13T00:00:00.000Z");

/** Live GH state the linked reconcile (Step 6) reads. Defaults make the
 *  standard `makeBead` an in-sync no-op. */
type LinkedLive = {
  title?: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
};

const DEFAULT_LINKED_LIVE: LinkedLive = {
  title: "Wire the publish verb",
  body: "Body text.",
  labels: ["type::task", "priority::medium"],
};

type Harness = {
  deps: BeadsPublishDeps;
  ghCreateCalls: GhCreateCall[];
  ghExecCalls: GhExecCall[];
  bdCalls: BdUpdateCall[];
  listIssuesCalls: Array<{ repo: string; state: string }>;
  auditRows: BeadsPublishAuditEntry[];
  /** `gh issue edit` chokepoint calls the linked reconcile issued (GH-2382). */
  reconcileEditCalls: GhIssueEditOptions[];
};

function harness(opts: {
  records: BeadsRecord[];
  issues?: FallbackIssue[];
  /** Return value of `execGhIssueCreate`; throw if called when undefined. */
  ghCreateResult?: GhIssueCreateResult;
  /** Return value of `execBd update`; throw if called when undefined. */
  bdUpdateResult?: BdExecResult;
  /** Return value of the pointer-back `gh issue comment`; defaults to OK. */
  ghCommentResult?: GhExecResult;
  /** GH-2382 — live issue state the linked reconcile (Step 6) reads. */
  linkedLive?: LinkedLive;
}): Harness {
  const ghCreateCalls: GhCreateCall[] = [];
  const ghExecCalls: GhExecCall[] = [];
  const bdCalls: BdUpdateCall[] = [];
  const listIssuesCalls: Array<{ repo: string; state: string }> = [];
  const auditRows: BeadsPublishAuditEntry[] = [];
  const reconcileEditCalls: GhIssueEditOptions[] = [];

  // GH-2382 — wire a GhDomainAdapter whose live read returns `linkedLive` and
  // whose `gh issue edit` is captured (never spawns real gh).
  const live = opts.linkedLive ?? DEFAULT_LINKED_LIVE;
  const reconcileRunner: AdapterCommandRunner = (cmd) => {
    if (cmd.includes("view")) {
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          ...(live.title !== undefined ? { title: live.title } : {}),
          ...(live.body !== undefined ? { body: live.body } : {}),
          ...(live.labels !== undefined ? { labels: live.labels.map((name) => ({ name })) } : {}),
          ...(live.state !== undefined ? { state: live.state.toUpperCase() } : {}),
        }),
      };
    }
    return { status: 0, stderr: "", stdout: "" };
  };
  const reconcileEdit = ((editOpts: GhIssueEditOptions) => {
    reconcileEditCalls.push(editOpts);
    return { exitCode: 0, stdout: "", stderr: "" };
  }) as typeof execGhIssueEdit;
  const pushAdapter = new GhDomainAdapter({
    runner: reconcileRunner,
    execGhIssueEdit: reconcileEdit,
    cwd: () => "/tmp/repo",
  });

  const deps: BeadsPublishDeps = {
    pushAdapter,
    loadAllBeads: () => opts.records,
    repoNameWithOwner: (() => REPO) as never,
    cwd: () => "/tmp/repo",
    now: () => FIXED_NOW,
    auditSink: {
      appendFn: (_path: string, line: string) => {
        try {
          auditRows.push(JSON.parse(line.trim()) as BeadsPublishAuditEntry);
        } catch {
          /* ignore */
        }
      },
      ensureDir: () => {},
      stdoutFn: () => {},
      env: {} as NodeJS.ProcessEnv,
      stateDirOverride: "/tmp/state",
    },
    listIssuesByState: ((repo: string, state: string) => {
      listIssuesCalls.push({ repo, state });
      return opts.issues ?? [];
    }) as never,
    execGhIssueCreate: ((createOpts: GhCreateCall) => {
      ghCreateCalls.push(createOpts);
      if (!opts.ghCreateResult) throw new Error("execGhIssueCreate called unexpectedly");
      return opts.ghCreateResult;
    }) as never,
    execGh: ((execOpts: GhExecCall) => {
      ghExecCalls.push(execOpts);
      return opts.ghCommentResult ?? ghExecOk();
    }) as never,
    // GH-296 / prx-82b: the external-ref write-back now runs `prx beads update
    // <id> --external-ref <url>` through the daemon (a sync runner). The fake
    // records the equivalent old `bd update` shape so the bdCalls assertions
    // hold; `bdUpdateResult` drives the exit status (exitCode → process status).
    run: ((cmd: string[]) => {
      bdCalls.push({
        subcommand: "update",
        args: cmd.slice(3),
        state: "planning",
        role: "planner",
      } as BdUpdateCall);
      if (!opts.bdUpdateResult) throw new Error("prx beads update called unexpectedly");
      const r = opts.bdUpdateResult;
      return { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    }) as never,
  };
  return {
    deps,
    ghCreateCalls,
    ghExecCalls,
    bdCalls,
    listIssuesCalls,
    auditRows,
    reconcileEditCalls,
  };
}

function capture(): {
  output: { log: (l: string) => void; error: (l: string) => void };
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (l) => logs.push(l), error: (l) => errors.push(l) }, logs, errors };
}

describe("runBeadsPublish — create + link (bd-only record)", () => {
  test("no dedup match → gh issue create with type::/priority:: labels, then bd update --external-ref", () => {
    const url = "https://github.com/owner/repo/issues/42";
    const h = harness({
      records: [makeBead({ priority: 1 })],
      issues: [],
      ghCreateResult: ghCreateOk(url),
      bdUpdateResult: bdOk(),
    });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(h.ghCreateCalls).toHaveLength(1);
    const gh = h.ghCreateCalls[0]!;
    expect(gh.title).toBe("Wire the publish verb");
    expect(gh.body).toBe("Body text.");
    expect(gh.repo).toBe(REPO);
    expect(gh.labels).toEqual(["type::task", "priority::high"]);
    expect(h.bdCalls).toHaveLength(1);
    expect(h.bdCalls[0]!.subcommand).toBe("update");
    expect(h.bdCalls[0]!.args).toEqual(["ai-home-target", "--external-ref", url]);
    expect(h.bdCalls[0]!.state).toBe("planning");
    expect(h.bdCalls[0]!.role).toBe("planner");
    expect(logs.join("\n")).toContain(url);
    // GH-1598 — pointer-back GH comment fires after the bd update succeeds.
    expect(h.ghExecCalls).toHaveLength(1);
    const cmt = h.ghExecCalls[0]!;
    expect(cmt.group).toBe("issue");
    expect(cmt.subcommand).toBe("comment");
    expect(cmt.args).toEqual([
      "42",
      "--body",
      "Published from beads record ai-home-target.",
      "--repo",
      REPO,
    ]);
    expect(cmt.role).toBe("executor");
    // GH-1598 — one audit row per terminal outcome.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toEqual({
      ts: FIXED_NOW.toISOString(),
      bdId: "ai-home-target",
      outcome: "created",
      ghNumber: 42,
      ghUrl: url,
      actor: "claude-code",
      dryRun: false,
      exitCode: 0,
    });
    expect(
      runBeadsPublishUnit(
        makeOpts(),
        harness({
          records: [makeBead()],
          issues: [],
          ghCreateResult: ghCreateOk(url),
          bdUpdateResult: bdOk(),
        }).deps,
      ),
    ).toEqual({ exitCode: 0, outcome: "created", bdId: "ai-home-target", externalRef: url });
  });

  test("issueType outside BD_TYPE_ENUM and unscored priority → type::task / priority::none", () => {
    const url = "https://github.com/owner/repo/issues/7";
    const h = harness({
      records: [makeBead({ issueType: "spike", priority: null })],
      issues: [],
      ghCreateResult: ghCreateOk(url),
      bdUpdateResult: bdOk(),
    });
    runBeadsPublish(makeOpts(), capture().output, h.deps);
    expect(h.ghCreateCalls[0]!.labels).toEqual(["type::task", "priority::none"]);
  });

  // ai-home-o55ct / GH-2313 — bd P4 (backlog) has no GH rung in the 4-rung
  // `bdPriorityToLabel` (0-3 → critical/high/medium/low). It must clamp to the
  // lowest DELIBERATE rung `priority::low` ("accepted but deferrable",
  // workflows/triage.md), NOT the GH-970 `priority::none` UNTRIAGED sentinel — a
  // backlog decision is still a triage decision, and `none` would make triage
  // prioritize re-surface it and block promote (promote.ts operator-undecided gate).
  test("P4 (backlog) clamps to priority::low, not the untriaged priority::none", () => {
    const url = "https://github.com/owner/repo/issues/8";
    const h = harness({
      records: [makeBead({ priority: 4 })],
      issues: [],
      ghCreateResult: ghCreateOk(url),
      bdUpdateResult: bdOk(),
    });
    runBeadsPublish(makeOpts(), capture().output, h.deps);
    expect(h.ghCreateCalls[0]!.labels).toEqual(["type::task", "priority::low"]);
  });
});

describe("runBeadsPublish — idempotency / refusals", () => {
  test("already linked to a GitHub issue → no-op, prints the existing link, no writes", () => {
    const ref = "https://github.com/owner/repo/issues/100";
    const h = harness({ records: [makeBead({ externalRef: ref, externalIssueNumber: 100 })] });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    expect(h.listIssuesCalls).toHaveLength(0);
    expect(logs.join("\n")).toContain(ref);
    // GH-1598 — noop path: no pointer comment, single audit row.
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      bdId: "ai-home-target",
      outcome: "noop",
      ghNumber: 100,
      ghUrl: ref,
      dryRun: false,
      exitCode: 0,
    });
    expect(runBeadsPublishUnit(makeOpts(), h.deps).outcome).toBe("noop");
  });

  test("non-GitHub external_ref pin → refusal pointing at GH-1538, no writes", () => {
    const h = harness({ records: [makeBead({ externalRef: "https://www.notion.so/page-abc" })] });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("GH-1538");
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({ outcome: "error", exitCode: 1, dryRun: false });
  });

  test("closed record → refusal, no writes", () => {
    const h = harness({ records: [makeBead({ status: "closed" })] });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n").toLowerCase()).toContain("closed");
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({ outcome: "error", exitCode: 1, dryRun: false });
  });

  test("bd record not found → exit 1", () => {
    const h = harness({ records: [] });
    const { output, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no beads record with id 'ai-home-target'");
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({ outcome: "error", exitCode: 1, dryRun: false });
  });

  test("GH-N input → refusal with the intake-mirror hint, no disk/network reads", () => {
    const h = harness({ records: [] });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts({ bdId: "GH-123" }), output, h.deps);

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("prx intake mirror GH-123");
    expect(errors.join("\n")).toContain("bd→GH");
    // No beads load / repo resolution happened — the rejection is first.
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    expect(h.listIssuesCalls).toHaveLength(0);
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      bdId: "GH-123",
      outcome: "error",
      exitCode: 1,
      dryRun: false,
    });
  });
});

describe("runBeadsPublish — dedupe (link instead of create)", () => {
  test("bd-side fingerprint: a sibling bd record already published this title → link, no create", () => {
    const siblingUrl = "https://github.com/owner/repo/issues/9";
    const h = harness({
      records: [
        makeBead({ id: "ai-home-target", title: "Same Title", externalRef: null }),
        makeBead({
          id: "ai-home-sibling",
          title: "same title",
          externalRef: siblingUrl,
          externalIssueNumber: 9,
        }),
      ],
      bdUpdateResult: bdOk(),
    });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.listIssuesCalls).toHaveLength(0); // bd-side match short-circuits before the GH-side scan
    expect(h.bdCalls).toHaveLength(1);
    expect(h.bdCalls[0]!.args).toEqual(["ai-home-target", "--external-ref", siblingUrl]);
    expect(logs.join("\n")).toContain(siblingUrl);
    // GH-1598 — linked path: no pointer comment, single audit row.
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      bdId: "ai-home-target",
      outcome: "linked",
      ghNumber: 9,
      ghUrl: siblingUrl,
      dryRun: false,
      exitCode: 0,
    });
    expect(
      runBeadsPublishUnit(
        makeOpts(),
        harness({
          records: [
            makeBead({ id: "ai-home-target", title: "Same Title", externalRef: null }),
            makeBead({
              id: "ai-home-sibling",
              title: "same title",
              externalRef: siblingUrl,
              externalIssueNumber: 9,
            }),
          ],
          bdUpdateResult: bdOk(),
        }).deps,
      ).outcome,
    ).toBe("linked");
  });

  test("GH-side title scan: an existing GitHub issue matches → adopt (link), no create", () => {
    const matchUrl = "https://github.com/owner/repo/issues/55";
    const h = harness({
      records: [makeBead({ title: "Adopt me" })],
      issues: [
        { number: 41, title: "unrelated", url: "https://github.com/owner/repo/issues/41" },
        { number: 55, title: "ADOPT ME", url: matchUrl },
      ],
      bdUpdateResult: bdOk(),
    });
    const { output, logs } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(0);
    expect(h.listIssuesCalls).toEqual([{ repo: REPO, state: "all" }]);
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(1);
    expect(h.bdCalls[0]!.args).toEqual(["ai-home-target", "--external-ref", matchUrl]);
    expect(logs.join("\n")).toContain(matchUrl);
    // GH-1598 — adopted path: no pointer comment, single audit row.
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      bdId: "ai-home-target",
      outcome: "adopted",
      ghNumber: 55,
      ghUrl: matchUrl,
      dryRun: false,
      exitCode: 0,
    });
    expect(
      runBeadsPublishUnit(
        makeOpts(),
        harness({
          records: [makeBead({ title: "Adopt me" })],
          issues: [{ number: 55, title: "ADOPT ME", url: matchUrl }],
          bdUpdateResult: bdOk(),
        }).deps,
      ).outcome,
    ).toBe("adopted");
  });

  test("--no-adopt skips the GH-side scan and creates instead", () => {
    const url = "https://github.com/owner/repo/issues/77";
    const h = harness({
      records: [makeBead({ title: "Adopt me" })],
      issues: [{ number: 55, title: "ADOPT ME", url: "https://github.com/owner/repo/issues/55" }],
      ghCreateResult: ghCreateOk(url),
      bdUpdateResult: bdOk(),
    });
    const code = runBeadsPublish(makeOpts({ noAdopt: true }), capture().output, h.deps);

    expect(code).toBe(0);
    expect(h.listIssuesCalls).toHaveLength(0);
    expect(h.ghCreateCalls).toHaveLength(1);
    expect(h.bdCalls[0]!.args).toEqual(["ai-home-target", "--external-ref", url]);
    // GH-1598 — comment-back still fires under --no-adopt.
    expect(h.ghExecCalls).toHaveLength(1);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      outcome: "created",
      ghNumber: 77,
      ghUrl: url,
      dryRun: false,
    });
  });
});

describe("runBeadsPublish — partial error & dry-run", () => {
  test("gh issue create succeeds but bd update fails → partial-error, exit 1, GH URL surfaced", () => {
    const url = "https://github.com/owner/repo/issues/88";
    const h = harness({
      records: [makeBead()],
      issues: [],
      ghCreateResult: ghCreateOk(url),
      bdUpdateResult: bdFail("permission denied"),
    });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(h.ghCreateCalls).toHaveLength(1);
    expect(h.bdCalls).toHaveLength(1);
    const msg = errors.join("\n");
    expect(msg).toContain(url);
    expect(msg).toContain("re-run");
    // GH-1598 — bd-update partial-error short-circuits before the pointer comment.
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      outcome: "partial-error",
      ghNumber: 88,
      ghUrl: url,
      dryRun: false,
      exitCode: 1,
    });
    expect(
      runBeadsPublishUnit(
        makeOpts(),
        harness({
          records: [makeBead()],
          issues: [],
          ghCreateResult: ghCreateOk(url),
          bdUpdateResult: bdFail("nope"),
        }).deps,
      ),
    ).toEqual({ exitCode: 1, outcome: "partial-error", bdId: "ai-home-target", externalRef: url });
  });

  test("gh issue comment fails → partial-error, exit 1, durable link surfaced", () => {
    const url = "https://github.com/owner/repo/issues/91";
    const h = harness({
      records: [makeBead()],
      issues: [],
      ghCreateResult: ghCreateOk(url),
      bdUpdateResult: bdOk(),
      ghCommentResult: ghExecFail("gh: 502 Bad Gateway"),
    });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    // The bd update still happened — the link is durable.
    expect(h.bdCalls).toHaveLength(1);
    expect(h.bdCalls[0]!.args).toEqual(["ai-home-target", "--external-ref", url]);
    expect(h.ghExecCalls).toHaveLength(1);
    const msg = errors.join("\n");
    expect(msg).toContain(url);
    expect(msg).toContain("ai-home-target");
    expect(msg).toContain("durable");
    expect(msg).toContain("gh: 502 Bad Gateway");
    // Audit row captures the partial-error outcome + the comment's stderr.
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      outcome: "partial-error",
      ghNumber: 91,
      ghUrl: url,
      dryRun: false,
      exitCode: 1,
    });
    expect(h.auditRows[0]!.stderr).toContain("gh: 502 Bad Gateway");
  });

  test("gh issue create fails outright → exit 1, no bd update", () => {
    const h = harness({
      records: [makeBead()],
      issues: [],
      ghCreateResult: ghCreateFail("gh: rate limited"),
    });
    const { output, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("rate limited");
    expect(h.bdCalls).toHaveLength(0);
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({ outcome: "error", exitCode: 1, dryRun: false });
  });

  test("--dry-run renders the planned gh issue create argv and writes nothing", () => {
    const h = harness({ records: [makeBead({ priority: 0 })], issues: [] });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts({ dryRun: true }), output, h.deps);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    const out = logs.join("\n");
    expect(out).toContain("dry-run");
    expect(out).toContain("gh issue create");
    expect(out).toContain("--title");
    expect(out).toContain("type::task");
    expect(out).toContain("priority::critical");
    // GH-1598 — dry-run create: no pointer comment; audit row marks dryRun: true.
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({ outcome: "created", dryRun: true, exitCode: 0 });
    expect(h.auditRows[0]!.ghUrl).toBeUndefined();
  });

  test("--dry-run with a bd-side dedupe match reports the link target but writes nothing", () => {
    const siblingUrl = "https://github.com/owner/repo/issues/3";
    const h = harness({
      records: [
        makeBead({ id: "ai-home-target", title: "Dup", externalRef: null }),
        makeBead({
          id: "ai-home-sib",
          title: "dup",
          externalRef: siblingUrl,
          externalIssueNumber: 3,
        }),
      ],
    });
    const { output, logs } = capture();
    const code = runBeadsPublish(makeOpts({ dryRun: true }), output, h.deps);
    expect(code).toBe(0);
    expect(h.bdCalls).toHaveLength(0);
    expect(logs.join("\n")).toContain(siblingUrl);
    expect(logs.join("\n")).toContain("dry-run");
    // GH-1598 — dry-run linked: no pointer comment; audit row carries dryRun: true.
    expect(h.ghExecCalls).toHaveLength(0);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({
      outcome: "linked",
      ghNumber: 3,
      ghUrl: siblingUrl,
      dryRun: true,
      exitCode: 0,
    });
  });
});

// GH-2382 — the bug repro: a linked record whose bd priority drifted from the
// GH label must reconcile (not silently no-op). Bump P3→P2 then publish: GH
// must end up with `priority::medium` and no `priority::low`.
describe("runBeadsPublish — linked reconcile (GH-2382)", () => {
  const ref = "https://github.com/owner/repo/issues/100";

  test("drifted priority → reconciled: adds priority::medium, removes priority::low", () => {
    const h = harness({
      records: [makeBead({ externalRef: ref, externalIssueNumber: 100 })], // priority 2 → medium
      linkedLive: {
        title: "Wire the publish verb",
        body: "Body text.",
        labels: ["type::task", "priority::low"],
      },
    });
    const { output, logs, errors } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    // The lossless swap reached the `gh issue edit` chokepoint.
    expect(h.reconcileEditCalls).toHaveLength(1);
    expect(h.reconcileEditCalls[0]?.addLabels).toEqual(["priority::medium"]);
    expect(h.reconcileEditCalls[0]?.removeLabels).toEqual(["priority::low"]);
    // No create, no list scan, no bd write-back on the linked path.
    expect(h.ghCreateCalls).toHaveLength(0);
    expect(h.listIssuesCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    expect(logs.join("\n")).toContain("reconciled");

    const unit = runBeadsPublishUnit(makeOpts(), h.deps);
    expect(unit.outcome).toBe("reconciled");

    // Audit: the publish row (reconciled) + the publisher-owned
    // ISSUE_UPDATE_REQUESTED catalog event (I-AUD1).
    const publishRow = h.auditRows.find(
      (r) => (r as { outcome?: string }).outcome === "reconciled",
    );
    expect(publishRow).toMatchObject({
      bdId: "ai-home-target",
      outcome: "reconciled",
      ghNumber: 100,
    });
    const intent = h.auditRows.find(
      (r) => (r as { event?: string }).event === "ISSUE_UPDATE_REQUESTED",
    ) as { actor?: string; workUnitId?: string } | undefined;
    expect(intent?.actor).toBe("publisher");
    expect(intent?.workUnitId).toBe("ai-home-target");
  });

  test("--dry-run shows the swap and writes nothing", () => {
    const h = harness({
      records: [makeBead({ externalRef: ref, externalIssueNumber: 100 })],
      linkedLive: {
        title: "Wire the publish verb",
        body: "Body text.",
        labels: ["type::task", "priority::low"],
      },
    });
    const { output, logs } = capture();
    const code = runBeadsPublish(makeOpts({ dryRun: true }), output, h.deps);

    expect(code).toBe(0);
    // Dry-run: read happened (preview) but no edit was written.
    expect(h.reconcileEditCalls).toHaveLength(0);
    expect(h.bdCalls).toHaveLength(0);
    const out = logs.join("\n");
    expect(out).toContain("dry-run");
    expect(out).toContain("priority::medium");
    expect(out).toContain("priority::low");
    // No intent event on dry-run; a single publish audit row.
    expect(
      h.auditRows.some((r) => (r as { event?: string }).event === "ISSUE_UPDATE_REQUESTED"),
    ).toBe(false);
    expect(h.auditRows).toHaveLength(1);
    expect(h.auditRows[0]!).toMatchObject({ outcome: "reconciled", dryRun: true, exitCode: 0 });
  });

  test("in sync → noop, no edit, no intent event", () => {
    const h = harness({
      records: [makeBead({ externalRef: ref, externalIssueNumber: 100 })],
      // DEFAULT_LINKED_LIVE already matches makeBead (priority::medium).
    });
    const { output } = capture();
    const code = runBeadsPublish(makeOpts(), output, h.deps);
    expect(code).toBe(0);
    expect(h.reconcileEditCalls).toHaveLength(0);
    expect(runBeadsPublishUnit(makeOpts(), h.deps).outcome).toBe("noop");
    expect(
      h.auditRows.some((r) => (r as { event?: string }).event === "ISSUE_UPDATE_REQUESTED"),
    ).toBe(false);
  });
});

describe("formatBeadsPublishRender", () => {
  test("json shape carries bdId / outcome / externalRef", () => {
    const json = formatBeadsPublishRender(
      {
        bdId: "ai-home-x",
        repo: REPO,
        title: "t",
        outcome: "created",
        externalRef: "https://github.com/owner/repo/issues/5",
        dryRun: false,
        exitCode: 0,
      },
      "json",
    );
    expect(JSON.parse(json)).toMatchObject({
      bdId: "ai-home-x",
      outcome: "created",
      externalRef: "https://github.com/owner/repo/issues/5",
      exitCode: 0,
    });
  });
});
