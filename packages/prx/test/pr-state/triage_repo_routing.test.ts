// GH-1697 — `--repo <slug>` routes every triage-* verb through the
// shared repo-target resolver, the same path `prx triage session --repo`
// proved out in GH-1689. These tests pin three invariants per verb:
//
//   1. Unknown slug → `CliError`; handler never runs.
//   2. Known slug → `deps.cwd?.() === targetCwd` passed to the handler.
//   3. Known slug → `opts.repo === undefined` (the slug never leaks into the
//      gh `owner/repo` filter; the handler derives the identity from cwd).
//
// Plus a regression for `triage-status` specifically: the output label
// reports the target's `repoNameWithOwner`, not the operator's input.
//
// Stubs follow `test/pr-state/triage_session.test.ts`: a fake
// `resolveTargetRepoCwd` returns a synthetic `targetCwd`; per-verb runner
// deps are intercepted to capture the handed-off `opts` and `deps`.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import type { ResolveTargetRepoResult } from "../../src/pr-state/repo-target.ts";
import type { LocalRepo } from "../../src/pr-state/repos.ts";
import type { BeadsWorkspaceMode } from "../../src/beads/workspace_mode.ts";
import type { TriageStatusResult } from "../../src/triage/triage.ts";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

const TARGET_CWD = "/scratch/wt/target/mainx";

function fakeRepo(name: string, githubRepo: string): LocalRepo {
  return {
    name,
    commonDir: `/scratch/bare/${name}.git`,
    kind: "bare",
    mainWorktree: TARGET_CWD,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: {
      name: "origin",
      url: `git@github.com:${githubRepo}.git`,
      githubRepo,
    },
    upstreamRemote: null,
  };
}

function routingDeps(slug: string) {
  return {
    resolveTargetRepoCwd: (input: { slug: string }): ResolveTargetRepoResult => {
      expect(input.slug).toBe(slug);
      return { targetCwd: TARGET_CWD, repo: fakeRepo(slug, `owner/${slug}`), materialize: null };
    },
    classifyBeadsWorkspace: (cwd: string): BeadsWorkspaceMode => {
      expect(cwd).toBe(TARGET_CWD);
      return { kind: "per_project", doltDir: `${cwd}/.beads/dolt` };
    },
  };
}

type Capture = {
  called: boolean;
  repo?: string | undefined;
  routedCwd?: string | undefined;
};

function newCapture(): Capture {
  return { called: false };
}

// Per-verb argv + runner-dep injection so each test exercises the same
// invariant with the verb's actual handler shape.
type VerbProbe = {
  name: string;
  argv: (repo?: string) => string[];
  /**
   * Returns CliDeps overrides containing exactly the verb's `run…` runner.
   * The runner records the `opts` it was called with and the resolved
   * `deps.cwd?.()` for assertions, plus flips `called` so callers can prove
   * the handler ran (or didn't, on the unknown-slug path).
   */
  injectRunner: (capture: Capture) => Record<string, unknown>;
};

function syncProbe(capture: Capture) {
  return (opts: { repo?: string }, _out: Output, deps?: { cwd?: () => string }): number => {
    capture.called = true;
    capture.repo = opts.repo;
    capture.routedCwd = deps?.cwd?.();
    return 0;
  };
}

function asyncProbe(capture: Capture) {
  return async (
    opts: { repo?: string },
    _out: Output,
    deps?: { cwd?: () => string },
  ): Promise<number> => {
    capture.called = true;
    capture.repo = opts.repo;
    capture.routedCwd = deps?.cwd?.();
    return 0;
  };
}

const VERBS: VerbProbe[] = [
  {
    name: "triage-status",
    argv: (repo) => ["triage", "status", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriageStatus: syncProbe(capture) }),
  },
  {
    name: "triage-classify",
    argv: (repo) => ["triage", "classify", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriageClassify: syncProbe(capture) }),
  },
  {
    name: "triage-apply",
    argv: (repo) => ["triage", "apply", "--plan", "plan.json", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriageApply: syncProbe(capture) }),
  },
  {
    name: "triage-promote",
    argv: (repo) => ["triage", "promote", "--dry-run", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriagePromote: syncProbe(capture) }),
  },
  {
    name: "triage-drift-fix",
    argv: (repo) => ["triage", "drift-fix", "--dry-run", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriageDriftFix: syncProbe(capture) }),
  },
  {
    name: "triage-migrate-axis-value",
    argv: (repo) => [
      "triage",
      "migrate-axis-value",
      "--axis",
      "priority",
      "--from",
      "p2",
      "--to",
      "high",
      ...(repo ? ["--repo", repo] : []),
    ],
    injectRunner: (capture) => ({ runTriageMigrateAxisValue: syncProbe(capture) }),
  },
  {
    name: "triage-prioritize",
    argv: (repo) => ["triage", "prioritize", "--dry-run", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriagePrioritize: asyncProbe(capture) }),
  },
  {
    name: "triage-type-pass",
    argv: (repo) => ["triage", "type-pass", "--dry-run", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriageTypePass: asyncProbe(capture) }),
  },
  {
    name: "triage-prioritize-bulk",
    argv: (repo) => ["triage", "prioritize-bulk", "--dry-run", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriagePrioritizeBulk: asyncProbe(capture) }),
  },
  {
    name: "triage-prime",
    // GH-1734: prime now joins the routed-cwd cohort. The CLI handler passes
    // `{ cwd: cwdFn }` into `runTriagePrime`, and the default `loadStatus`
    // factory forwards it to the inter-iteration `runStatusActor` so beads
    // reads target the routed mainx, not `process.cwd()`.
    argv: (repo) => ["triage", "prime", "--dry-run", ...(repo ? ["--repo", repo] : [])],
    injectRunner: (capture) => ({ runTriagePrime: asyncProbe(capture) }),
  },
];

describe("triage `--repo <slug>` routing (GH-1697)", () => {
  for (const verb of VERBS) {
    describe(verb.name, () => {
      test("unknown slug rejects with the `prx repo add` hint; handler never runs", async () => {
        const { errors, output } = captureOutput();
        const capture = newCapture();

        const exit = await runCli(verb.argv("not-a-real-slug"), output, {
          loadRepoInventoryConfig: () => ({
            repoRoot: null,
            bareRoot: null,
            roots: [],
            everywhereRoots: [],
            globalConfigPath: null,
            configPath: null,
            indexPath: null,
          }),
          discoverLocalRepos: () => ({ roots: [], repos: [] }),
          ...verb.injectRunner(capture),
        });

        expect(exit).not.toBe(0);
        expect(capture.called).toBe(false);
        const joined = errors.join("\n");
        expect(joined).toContain("not-a-real-slug");
        expect(joined).toContain("prx repo add");
      });

      test("known slug routes cwd to the target's mainWorktree and clears opts.repo", async () => {
        const { output } = captureOutput();
        const capture = newCapture();

        const exit = await runCli(verb.argv("foo"), output, {
          ...routingDeps("foo"),
          ...verb.injectRunner(capture),
        });

        expect(exit).toBe(0);
        expect(capture.called).toBe(true);
        // Step 3: opts.repo MUST be undefined when routing — the slug is a
        // workspace pin, not a gh `owner/repo` filter.
        expect(capture.repo).toBeUndefined();
        // Step 2: routed cwd reaches the handler.
        expect(capture.routedCwd).toBe(TARGET_CWD);
      });

      test("no --repo: handler runs without a routed cwd; opts.repo stays undefined", async () => {
        const { output } = captureOutput();
        const capture = newCapture();

        const exit = await runCli(verb.argv(), output, verb.injectRunner(capture));

        expect(exit).toBe(0);
        expect(capture.called).toBe(true);
        // No --repo at all → no routing, no cwd override; opts.repo is the
        // CLI-parsed value (also undefined when --repo is omitted).
        expect(capture.repo).toBeUndefined();
        expect(capture.routedCwd).toBeUndefined();
      });
    });
  }
});

describe("triage-status `--repo <slug>` output label (GH-1697 regression)", () => {
  test("routed run formats the label from the target's identity, not the operator's slug", async () => {
    const { logs, output } = captureOutput();
    const result: TriageStatusResult = {
      // The handler under test derives this from `repoNameWithOwner(targetCwd)`;
      // the fake runner here simulates that by returning the target's identity.
      repo: "owner/foo",
      canonical: "gh",
      totalOpen: 5,
      totalUntriaged: 2,
      totalReverseOrphans: 0,
      totalDrift: 0,
      totalStale: 0,
      totalAxisConflicts: 0,
      issues: [],
      reverseOrphans: [],
      drift: [],
      stale: [],
      axisConflicts: [],
    };

    const exit = await runCli(
      ["triage", "status", "--repo", "bdelanghe/foo", "--format", "json"],
      output,
      {
        ...routingDeps("bdelanghe/foo"),
        runTriageStatus: (opts, out, deps) => {
          // The CLI must have cleared opts.repo so the handler resolves
          // identity from cwd — not echoed the operator's slug.
          expect(opts.repo).toBeUndefined();
          expect(deps?.cwd?.()).toBe(TARGET_CWD);
          out.log(JSON.stringify(result));
          return 0;
        },
      },
    );

    expect(exit).toBe(0);
    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[0]!) as TriageStatusResult;
    // The dangerous symptom from the GH-1697 issue body was the operator's
    // slug echoing into `result.repo`. The routed run reports the target's
    // gh identity, not the input slug.
    expect(parsed.repo).toBe("owner/foo");
    expect(parsed.repo).not.toBe("bdelanghe/foo");
  });
});
