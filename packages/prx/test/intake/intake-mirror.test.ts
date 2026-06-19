import { describe, expect, test } from "bun:test";
import {
  formatIntakeMirrorRender,
  intakeMirrorOptionsSchema,
  runIntakeMirror,
  type IntakeMirrorOptions,
} from "../../src/intake/intake-mirror.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../../src/triage/triage.ts";

type GhCallTag = { kind: "gh"; group?: string | undefined; subcommand: string; args: string[] };
type BdCallTag = { kind: "bd"; subcommand: string; args: string[] };
type CallTag = GhCallTag | BdCallTag;

function makeOpts(overrides: Partial<IntakeMirrorOptions> = {}): IntakeMirrorOptions {
  return intakeMirrorOptionsSchema.parse({
    ghId: "GH-100",
    ...overrides,
  });
}

function ghOk(stdout = ""): GhExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

function ghFail(stderr: string, code = 1): GhExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}

// GH-296 / prx-82b: bd create now runs `prx beads create …` through the daemon
// (a sync runner) which echoes the created record as JSON. These helpers record
// the equivalent old `{kind:"bd", subcommand, args}` shape from the prx argv.
type RunResult = { status: number; stdout: string; stderr: string };
const createdJson = (id: string): string => JSON.stringify({ id });
function recordingRun(calls: CallTag[], stdout = "", status = 0) {
  return ((cmd: string[]) => {
    calls.push({ kind: "bd", subcommand: cmd[2] ?? "", args: cmd.slice(3) });
    return { status, stdout, stderr: status === 0 ? "" : stdout } as RunResult;
  }) as never;
}
const runOk = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const runFail = (stderr: string, status = 1): RunResult => ({ status, stdout: "", stderr });

function makeBead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-abc123",
    title: "Existing bead",
    description: "",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: "https://github.com/bdelanghe/ai-home/issues/100",
    externalRefs: { gh: "https://github.com/bdelanghe/ai-home/issues/100" },
    metadata: null,
    externalIssueNumber: 100,
    sourceSystem: null,
    ...overrides,
  };
}

function ghTitleStdout(title: string, url: string): string {
  return JSON.stringify({ title, url });
}

const REPO = "bdelanghe/ai-home";

describe("runIntakeMirror — happy path (creates new bd)", () => {
  test("no existing record → calls gh issue view, then bd create, prints created bd id", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { group?: string; subcommand: string; args: string[] }) => {
          calls.push({
            kind: "gh",
            group: opts.group,
            subcommand: opts.subcommand,
            args: opts.args,
          });
          return ghOk(
            ghTitleStdout("Hello world", "https://github.com/bdelanghe/ai-home/issues/100"),
          );
        }) as never,
        run: recordingRun(calls, createdJson("ai-home-new123")),
      },
    );

    expect(exitCode).toBe(0);
    expect(calls.filter((c) => c.kind === "gh")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "bd")).toHaveLength(1);
    const ghCall = calls.find((c) => c.kind === "gh") as GhCallTag;
    expect(ghCall.subcommand).toBe("view");
    expect(ghCall.group).toBe("issue");
    expect(ghCall.args[0]).toBe("100");
    expect(ghCall.args).toContain("--json");
    const bdCall = calls.find((c) => c.kind === "bd") as BdCallTag;
    expect(bdCall.subcommand).toBe("create");
    expect(bdCall.args).toContain("--external-ref");
    expect(bdCall.args[bdCall.args.indexOf("--external-ref") + 1]).toBe(
      "https://github.com/bdelanghe/ai-home/issues/100",
    );
    expect(bdCall.args).toContain("--title");
    expect(bdCall.args[bdCall.args.indexOf("--title") + 1]).toBe("Hello world");
    // GH-296: mirrored issues create as type `task` (no more `--silent` id-line —
    // the daemon echoes the record as JSON and we parse its id).
    expect(bdCall.args).toContain("--type");
    expect(bdCall.args[bdCall.args.indexOf("--type") + 1]).toBe("task");
    expect(logs[0]).toBe("ai-home-new123");
  });
  // GH-296: the planning/planner policy slot is now the daemon's concern
  // (handleBeadsRequest dispatches under planner) — covered in beadsd/daemon.test.
});

describe("runIntakeMirror — idempotent no-op (existing external_ref)", () => {
  test("existing record → no gh call, no bd create, prints existing bd id", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        loadAllBeads: (() => [makeBead({ id: "ai-home-existing" })]) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(ghTitleStdout("t", "u"));
        }) as never,
        run: recordingRun(calls),
      },
    );

    expect(exitCode).toBe(0);
    // No gh fetch, no bd create — both branches skipped.
    expect(calls).toHaveLength(0);
    expect(logs[0]).toBe("ai-home-existing");
  });
});

describe("runIntakeMirror — recycled-short-id phantom (GH-2254)", () => {
  test("no-op binds to the OPEN canonical, not a closed phantom on the same issue number", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        // Closed recycled-short-id phantom is listed FIRST; the open canonical
        // follows. findExisting must prefer the open record regardless of order.
        loadAllBeads: (() => [
          makeBead({ id: "ai-home-phantom", status: "closed" }),
          makeBead({
            id: "ai-home-1777496041243-100-c09ad944",
            status: "open",
          }),
        ]) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(ghTitleStdout("t", "u"));
        }) as never,
        run: recordingRun(calls),
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(logs[0]).toBe("ai-home-1777496041243-100-c09ad944");
  });
});

describe("runIntakeMirror — sync race (matching by issue number, different URL form)", () => {
  test("existing record with trailing-slash URL is still matched as no-op", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        loadAllBeads: (() => [
          makeBead({
            id: "ai-home-sync-race",
            externalRef: "https://github.com/bdelanghe/ai-home/issues/100/",
            externalIssueNumber: 100,
          }),
        ]) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(ghTitleStdout("t", "u"));
        }) as never,
        run: recordingRun(calls),
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(logs[0]).toBe("ai-home-sync-race");
  });

  test("cross-repo collision on same issue number is NOT a match (creates new)", () => {
    const calls: CallTag[] = [];
    runIntakeMirror(
      makeOpts({ ghId: "GH-100", repo: "other/repo" }),
      { log: () => undefined, error: () => undefined },
      {
        loadAllBeads: (() => [
          makeBead({
            id: "ai-home-other-repo",
            externalRef: "https://github.com/bdelanghe/ai-home/issues/100",
            externalIssueNumber: 100,
          }),
        ]) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(ghTitleStdout("t", "https://github.com/other/repo/issues/100"));
        }) as never,
        run: recordingRun(calls, createdJson("ai-home-new")),
      },
    );
    // New record gets created; bd-list match was disambiguated by repo prefix.
    expect(calls.filter((c) => c.kind === "bd")).toHaveLength(1);
  });
});

describe("runIntakeMirror — id rejection", () => {
  test("bd-shaped id throws (mirror is GH-only)", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "ai-home-abc123" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() => ghOk("")) as never,
        run: (() => runOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("must be a GitHub issue");
  });

  test("shell-metachar input throws via shared resolver", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "foo;rm" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() => ghOk("")) as never,
        run: (() => runOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("invalid characters");
  });
});

describe("runIntakeMirror — URL form supplies repo", () => {
  test("URL routes lookup with the URL's repo, not the cwd's", () => {
    let resolveCalls = 0;
    const calls: CallTag[] = [];
    runIntakeMirror(
      makeOpts({ ghId: "https://github.com/o/r/issues/100" }),
      { log: () => undefined, error: () => undefined },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => {
          resolveCalls += 1;
          return "should/not-be-used";
        }) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(ghTitleStdout("t", "https://github.com/o/r/issues/100"));
        }) as never,
        run: recordingRun(calls, createdJson("ai-home-x")),
      },
    );
    expect(resolveCalls).toBe(0);
    const ghCall = calls.find((c) => c.kind === "gh") as GhCallTag;
    expect(ghCall.args).toContain("--repo");
    expect(ghCall.args[ghCall.args.indexOf("--repo") + 1]).toBe("o/r");
    const bdCall = calls.find((c) => c.kind === "bd") as BdCallTag;
    expect(bdCall.args[bdCall.args.indexOf("--external-ref") + 1]).toBe(
      "https://github.com/o/r/issues/100",
    );
  });

  test("explicit --repo wins over URL-form repo", () => {
    const calls: CallTag[] = [];
    runIntakeMirror(
      makeOpts({
        ghId: "https://github.com/o/r/issues/100",
        repo: "explicit/repo",
      }),
      { log: () => undefined, error: () => undefined },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => "should/not-be-used") as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(ghTitleStdout("t", "https://github.com/explicit/repo/issues/100"));
        }) as never,
        run: recordingRun(calls, createdJson("ai-home-x")),
      },
    );
    const ghCall = calls.find((c) => c.kind === "gh") as GhCallTag;
    expect(ghCall.args[ghCall.args.indexOf("--repo") + 1]).toBe("explicit/repo");
  });
});

describe("runIntakeMirror — --dry-run", () => {
  test("plain dry-run renders argv, no bd create call, exit 0", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk(
            ghTitleStdout("Demo title", "https://github.com/bdelanghe/ai-home/issues/100"),
          );
        }) as never,
        run: recordingRun(calls),
      },
    );

    expect(exitCode).toBe(0);
    // gh fetch happens (we need title to render), bd create does NOT.
    expect(calls.filter((c) => c.kind === "gh")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "bd")).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("(dry-run)");
    expect(out).toContain("gh:        GH-100");
    expect(out).toContain("title:     Demo title");
    expect(out).toContain("bd create");
    expect(out).toContain("--external-ref");
  });
});

describe("runIntakeMirror — --format json", () => {
  test("created branch serializes cleanly", () => {
    const logs: string[] = [];
    runIntakeMirror(
      makeOpts({ ghId: "GH-100", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() =>
          ghOk(ghTitleStdout("title", "https://github.com/bdelanghe/ai-home/issues/100"))) as never,
        run: (() => runOk(createdJson("ai-home-new"))) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      ghNumber: number;
      createdBdId?: string;
      existingBdId?: string;
      dryRun: boolean;
    };
    expect(parsed.ghNumber).toBe(100);
    expect(parsed.createdBdId).toBe("ai-home-new");
    expect(parsed.existingBdId).toBeUndefined();
    expect(parsed.dryRun).toBe(false);
  });

  test("existing branch serializes cleanly", () => {
    const logs: string[] = [];
    runIntakeMirror(
      makeOpts({ ghId: "GH-100", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        loadAllBeads: (() => [makeBead({ id: "ai-home-existing" })]) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() => ghOk("never")) as never,
        run: (() => runOk()) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      ghNumber: number;
      existingBdId?: string;
      createdBdId?: string;
    };
    expect(parsed.existingBdId).toBe("ai-home-existing");
    expect(parsed.createdBdId).toBeUndefined();
  });
});

describe("runIntakeMirror — failures", () => {
  test("loadAllBeads throwing → friendly error, exit 1", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        loadAllBeads: (() => {
          throw new Error("triage status: bd list --json failed");
        }) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() => ghOk("")) as never,
        run: (() => runOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("bd list --json failed");
    expect(errors[0]!.startsWith("prx intake mirror:")).toBe(true);
  });

  test("bd create failure → propagates exit code, error contains stderr", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() =>
          ghOk(ghTitleStdout("title", "https://github.com/bdelanghe/ai-home/issues/100"))) as never,
        run: (() => runFail("dolt offline", 7)) as never,
      },
    );
    expect(exitCode).toBe(7);
    expect(errors[0]).toContain("dolt offline");
  });

  test("gh issue view failure → friendly error, propagates exit code", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() => ghFail("HTTP 404", 4)) as never,
        run: (() => runOk()) as never,
      },
    );
    expect(exitCode).toBe(4);
    expect(errors[0]).toContain("HTTP 404");
  });

  test("bd create returns unparseable stdout → error, exit 1", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMirror(
      makeOpts({ ghId: "GH-100" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        loadAllBeads: (() => []) as never,
        repoNameWithOwner: (() => REPO) as never,
        cwd: () => "/tmp/cwd",
        execGh: (() =>
          ghOk(ghTitleStdout("t", "https://github.com/bdelanghe/ai-home/issues/100"))) as never,
        run: (() => runOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("unparseable output");
  });
});

describe("formatIntakeMirrorRender", () => {
  test("plain dry-run includes 'would run:' header and bd create line", () => {
    const out = formatIntakeMirrorRender(
      {
        ghNumber: 100,
        repo: "bdelanghe/ai-home",
        issueUrl: "https://github.com/bdelanghe/ai-home/issues/100",
        title: "Demo",
        bdCreate: {
          argv: [
            "--silent",
            "--external-ref",
            "https://github.com/bdelanghe/ai-home/issues/100",
            "--title",
            "Demo",
          ],
        },
        dryRun: true,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toContain("(dry-run)");
    expect(out).toContain("would run:");
    expect(out).toContain("bd create --silent --external-ref");
    expect(out).toContain("--title Demo");
  });

  test("plain non-dry-run with existing id prints just the id", () => {
    const out = formatIntakeMirrorRender(
      {
        ghNumber: 100,
        repo: "bdelanghe/ai-home",
        issueUrl: "https://github.com/bdelanghe/ai-home/issues/100",
        title: "Demo",
        existingBdId: "ai-home-abc123",
        dryRun: false,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toBe("ai-home-abc123");
  });

  test("plain non-dry-run with created id prints just the id", () => {
    const out = formatIntakeMirrorRender(
      {
        ghNumber: 100,
        repo: "bdelanghe/ai-home",
        issueUrl: "https://github.com/bdelanghe/ai-home/issues/100",
        title: "Demo",
        createdBdId: "ai-home-new",
        dryRun: false,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toBe("ai-home-new");
  });

  test("json round-trips render shape", () => {
    const render = {
      ghNumber: 100,
      repo: "bdelanghe/ai-home",
      issueUrl: "https://github.com/bdelanghe/ai-home/issues/100",
      title: "Demo",
      createdBdId: "ai-home-new",
      dryRun: false,
      exitCode: 0,
    };
    const out = formatIntakeMirrorRender(render, "json");
    expect(JSON.parse(out)).toEqual(render);
  });
});
