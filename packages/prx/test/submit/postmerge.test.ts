import { describe, expect, test } from "bun:test";

import {
  postmergeOptionsSchema,
  runPostmerge,
  type PostmergeOptions,
} from "../../src/submit/postmerge.ts";
import { canonicalWorkUnitIdPattern } from "../../src/machine/work_unit.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { GhIssueCloseResult } from "../../src/tools/gh_issue_close.ts";
import type { GhPrViewResult } from "../../src/tools/gh_pr_view.ts";
import type { BdIssueCloseResult } from "../../src/tools/bd_issue_close.ts";
import type { BdShowResult } from "@bounded-systems/bd";
import type { IdentityConfig } from "../../src/pr-state/github.ts";
import type {
  LocalRepo,
  RepoInventory,
  RepoInventoryConfig,
} from "../../src/pr-state/repos.ts";

type PrViewTag = { kind: "pr-view"; number: number };
type GhCall = { kind: "gh"; subcommand: string; args: string[] };
type CloseCall = { kind: "close"; number: number; reason?: string | undefined; repo?: string | undefined };
type BdShowCall = { kind: "bd-show"; id: string };
type BdCloseCall = { kind: "bd-close"; id: string };
type CallTag = PrViewTag | GhCall | CloseCall | BdShowCall | BdCloseCall;

const defaultIdentity: IdentityConfig = {
  sources: {
    github: {
      name: "github",
      kind: "github",
      canonicalIdPattern: canonicalWorkUnitIdPattern,
      source: "<test>",
    },
  },
  defaultSourceName: "github",
  isDefault: true,
};

function makeOpts(overrides: Partial<PostmergeOptions> = {}): PostmergeOptions {
  return postmergeOptionsSchema.parse({
    prNumber: 1313,
    ...overrides,
  });
}

function prViewOk(payload: {
  number: number;
  state?: "OPEN" | "CLOSED" | "MERGED";
  mergedAt?: string | null;
  body?: string;
  title?: string;
  closing?: number[];
}): GhPrViewResult {
  const state = payload.state ?? "MERGED";
  const mergedAt =
    payload.mergedAt === undefined
      ? state === "MERGED"
        ? "2026-05-16T22:00:00Z"
        : null
      : payload.mergedAt;
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      number: payload.number,
      state,
      mergedAt,
      title: payload.title ?? "",
      body: payload.body ?? "",
      mergeCommit: { oid: "deadbeef" },
      closingIssuesReferences: (payload.closing ?? []).map((n) => ({ number: n })),
    }),
    stderr: "",
  };
}

function ghOk(stdout = ""): GhExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

function closeOk(stdout = ""): GhIssueCloseResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function bdCloseOk(stdout = ""): BdIssueCloseResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function bdShowOk(id: string, status: string): BdShowResult {
  return {
    ok: true,
    record: { id, title: "", status },
    stdout: "",
    stderr: "",
  };
}

// GH-1806: minimal inventory stubs for the cross-workspace classification
// arm. `inventoryConfigStub` puts an in-memory indexPath so postmerge calls
// `loadRepoInventoryIndex`; `inventoryWith` returns whatever stub repo list
// the test supplies.
function inventoryConfigStub(indexPath: string | null = "/stub/index.json"): RepoInventoryConfig {
  return {
    repoRoot: null,
    bareRoot: null,
    roots: [],
    everywhereRoots: [],
    globalConfigPath: null,
    configPath: null,
    indexPath,
  };
}

function inventoryWith(repos: LocalRepo[]): RepoInventory {
  return { roots: [], repos };
}

function bareRepo(name: string, commonDir: string, prefix: string): LocalRepo {
  return {
    name,
    commonDir,
    kind: "bare",
    mainWorktree: null,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: null,
    upstreamRemote: null,
    bd_workspace_prefix: prefix,
  };
}

function makeDeps(opts: {
  calls: CallTag[];
  prView: () => GhPrViewResult;
  issueViewState?: Record<number, "OPEN" | "CLOSED">;
  perGhSubcommand?: Partial<Record<string, () => GhExecResult>>;
  close?: () => GhIssueCloseResult;
  bdShowState?: Record<string, string>;
  bdShow?: (id: string) => BdShowResult;
  bdClose?: (id: string) => BdIssueCloseResult;
  inventory?: RepoInventory | null;
  localPrefix?: string | null;
}) {
  return {
    execGhPrView: ((req: { number: number }) => {
      opts.calls.push({ kind: "pr-view", number: req.number });
      return opts.prView();
    }) as never,
    execGh: ((req: { subcommand: string; args: string[] }) => {
      opts.calls.push({ kind: "gh", subcommand: req.subcommand, args: req.args });
      const fn = opts.perGhSubcommand?.[req.subcommand];
      if (fn) return fn();
      if (req.subcommand === "view") {
        const target = Number.parseInt(req.args[0] ?? "0", 10);
        const state = opts.issueViewState?.[target] ?? "OPEN";
        return ghOk(JSON.stringify({ state }));
      }
      return ghOk();
    }) as never,
    execGhIssueClose: ((req: { number: number; reason?: string; repo?: string }) => {
      opts.calls.push({
        kind: "close",
        number: req.number,
        reason: req.reason,
        repo: req.repo,
      });
      return (opts.close ?? closeOk)();
    }) as never,
    runBdShow: ((id: string) => {
      opts.calls.push({ kind: "bd-show", id });
      if (opts.bdShow) return opts.bdShow(id);
      const status = opts.bdShowState?.[id] ?? "open";
      return bdShowOk(id, status);
    }) as never,
    execBdIssueClose: ((req: { id: string }) => {
      opts.calls.push({ kind: "bd-close", id: req.id });
      return (opts.bdClose ?? bdCloseOk)(req.id);
    }) as never,
    loadIdentityConfig: (() => defaultIdentity) as never,
    // GH-1806: inventory + local-prefix stubs threaded through the new
    // PostmergeDeps slots. Default to an empty inventory (no foreign repos)
    // so existing test cases keep their current behavior.
    loadRepoInventoryConfig: (() =>
      inventoryConfigStub(
        opts.inventory === undefined ? null : "/stub/index.json",
      )) as never,
    loadRepoInventoryIndex: (() => opts.inventory ?? null) as never,
    localWorkspacePrefixForCwd: (() => opts.localPrefix ?? null) as never,
  };
}

describe("runPostmerge — preflight", () => {
  test("exit 2 when PR is not merged", () => {
    const calls: CallTag[] = [];
    const errs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 999 }),
      { log: () => undefined, error: (l) => errs.push(l) },
      makeDeps({
        calls,
        prView: () => prViewOk({ number: 999, state: "OPEN" }),
      }),
    );
    expect(exit).toBe(2);
    expect(errs.join("\n")).toMatch(/not merged/);
    expect(errs.join("\n")).toMatch(/state=OPEN/);
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(0);
  });

  test("exit 2 when gh pr view fails", () => {
    const calls: CallTag[] = [];
    const errs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 123 }),
      { log: () => undefined, error: (l) => errs.push(l) },
      makeDeps({
        calls,
        prView: () => ({ exitCode: 1, stdout: "", stderr: "404 not found" }),
      }),
    );
    expect(exit).toBe(2);
    expect(errs.join("\n")).toMatch(/404 not found/);
  });
});

describe("runPostmerge — closingIssuesReferences subtraction", () => {
  test("skips refs already in closingIssuesReferences, no comment/close issued", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 1313 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 1313,
            title: "feat(doctor): merge (GH-885) (#1313)",
            body: "Closes #885\n\nAlso resolves GH-882.",
            closing: [885],
          }),
      }),
    );
    expect(exit).toBe(0);
    // No write calls for 885; one close pipeline for 882.
    const closeCalls = calls.filter((c) => c.kind === "close");
    expect(closeCalls).toEqual([
      { kind: "close", number: 882, reason: "completed", repo: undefined },
    ]);
  });
});

describe("runPostmerge — idempotency", () => {
  test("skips targets already CLOSED (no comment, no close)", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 1313 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        issueViewState: { 882: "CLOSED" },
        prView: () =>
          prViewOk({
            number: 1313,
            title: "feat(doctor): merge (GH-885) (#1313)",
            body: "Resolves GH-882",
            closing: [885],
          }),
      }),
    );
    expect(exit).toBe(0);
    const commentCalls = calls.filter(
      (c) => c.kind === "gh" && c.subcommand === "comment",
    );
    const closeCalls = calls.filter((c) => c.kind === "close");
    expect(commentCalls).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
  });
});

describe("runPostmerge — closes OPEN sibling", () => {
  test("comment then close, deterministic order, --repo threaded", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 1313, repo: "bdelanghe/ai-home" }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 1313,
            title: "feat: (GH-885) (#1313)",
            body: "Also: GH-882",
            closing: [885],
          }),
      }),
    );
    expect(exit).toBe(0);
    // Expected sequence: pr-view, gh view 882, gh comment 882, close 882
    expect(calls[0]).toMatchObject({ kind: "pr-view", number: 1313 });
    expect(calls[1]).toMatchObject({ kind: "gh", subcommand: "view" });
    expect((calls[1] as GhCall).args).toContain("--repo");
    expect((calls[1] as GhCall).args).toContain("bdelanghe/ai-home");
    expect(calls[2]).toMatchObject({ kind: "gh", subcommand: "comment" });
    const commentArgs = (calls[2] as GhCall).args;
    expect(commentArgs[0]).toBe("882");
    const bodyIdx = commentArgs.indexOf("--body");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(commentArgs[bodyIdx + 1]).toContain("postmerge sweep");
    expect(commentArgs[bodyIdx + 1]).toContain("#1313");
    expect(calls[3]).toEqual({
      kind: "close",
      number: 882,
      reason: "completed",
      repo: "bdelanghe/ai-home",
    });
  });
});

describe("runPostmerge — dry-run", () => {
  test("renders argv without spawning comment/close calls", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 1313, dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 1313,
            title: "feat: (GH-885) (#1313)",
            body: "Also: GH-882",
            closing: [885],
          }),
      }),
    );
    expect(exit).toBe(0);
    // Only the PR-view call should have hit a seam; no issue view, comment, or close.
    expect(calls.filter((c) => c.kind === "gh")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("dry-run");
    expect(out).toContain("GH-882");
    expect(out).toContain("would close");
  });
});

describe("runPostmerge — notion refs are filtered (no bd/gh shape)", () => {
  test("notion-only refs in the body do not trigger any close calls", () => {
    const calls: CallTag[] = [];
    runPostmerge(
      makeOpts({ prNumber: 200 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 200,
            title: "feat: cleanup (#200)",
            body: "References NOTION-1234567890abcdef1234567890abcdef but no GH/bd refs.",
            closing: [],
          }),
      }),
    );
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "gh")).toHaveLength(0);
  });
});

describe("runPostmerge — bd-canonical close loop (GH-1773)", () => {
  test("bd-only PR closes the bd record after preflight (status open)", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 400 }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 400,
            title: "feat: ship (#400)",
            body: "Refs BD-deadbeef\n",
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toEqual([
      { kind: "bd-show", id: "BD-deadbeef" },
    ]);
    expect(calls.filter((c) => c.kind === "bd-close")).toEqual([
      { kind: "bd-close", id: "BD-deadbeef" },
    ]);
  });

  test("mixed PR closes both GH and bd targets, deterministic order", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 401 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 401,
            title: "feat (GH-885) (#401)",
            body: "Closes #885\n\nRefs BD-cafebabe",
            closing: [885],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toEqual([
      { kind: "bd-show", id: "BD-cafebabe" },
    ]);
    expect(calls.filter((c) => c.kind === "bd-close")).toEqual([
      { kind: "bd-close", id: "BD-cafebabe" },
    ]);
  });

  test("idempotency: already-closed bd record is skipped", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 402 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        bdShowState: { "BD-deadbeef": "closed" },
        prView: () =>
          prViewOk({
            number: 402,
            title: "feat (#402)",
            body: "Refs BD-deadbeef",
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
  });

  test("non-canonical bd ref (no 8-hex tail) is surfaced as skip-unrecognized", () => {
    // Identity overlay that accepts a semantic-id bd shape (pin.9.4.2-style
    // workspaces have no 8-hex tail). Mirrors a real canonical=bd repo where
    // `normalizeToBdSurfaceShort` legitimately returns null.
    const semanticIdentity: IdentityConfig = {
      sources: {
        github: {
          name: "github",
          kind: "github",
          canonicalIdPattern: /^BD-[a-z]+$/,
          source: "<test>",
        },
      },
      defaultSourceName: "github",
      isDefault: false,
    };
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const deps = makeDeps({
      calls,
      prView: () =>
        prViewOk({
          number: 403,
          title: "feat (#403)",
          body: "Refs BD-semantic\n",
          closing: [],
        }),
    });
    deps.loadIdentityConfig = (() => semanticIdentity) as never;
    const exit = runPostmerge(
      makeOpts({ prNumber: 403, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      deps,
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
    const parsed = JSON.parse(logs[0]!);
    const skip = parsed.targets.find(
      (t: { kind: string }) => t.kind === "skip:bd-unrecognized",
    );
    expect(skip).toBeDefined();
    expect(skip.raw).toBe("BD-semantic");
  });

  test("bd close error → exit 1, error-bd target surfaced", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 404 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        bdClose: () => ({ exitCode: 1, stdout: "", stderr: "bd: boom" }),
        prView: () =>
          prViewOk({
            number: 404,
            title: "feat (#404)",
            body: "Refs BD-deadbeef",
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(1);
  });

  test("dry-run renders bd close argv without spawning bd-show/bd-close", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 405, dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 405,
            title: "feat (#405)",
            body: "Refs BD-deadbeef",
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("BD-deadbeef");
    expect(out).toContain("would close");
    expect(out).toContain("bd close BD-deadbeef");
  });

  test("JSON render exposes bdCandidates + closed-bd targets", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    runPostmerge(
      makeOpts({ prNumber: 406, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 406,
            title: "feat (#406)",
            body: "Refs BD-deadbeef\nClosing #885",
            closing: [],
          }),
      }),
    );
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.bdCandidates).toEqual(["BD-deadbeef"]);
    const closedBd = parsed.targets.find(
      (t: { kind: string }) => t.kind === "closed-bd",
    );
    expect(closedBd).toBeDefined();
    expect(closedBd.id).toBe("BD-deadbeef");
  });
});

describe("runPostmerge — cross-workspace bd refs (GH-1806)", () => {
  test("foreign bd long-id with pinned prefix → skip:bd-foreign-workspace, no bd-show/close", () => {
    const foreignRef = "BD-beta-1234567890123-1-deadbeef";
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 500, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        localPrefix: "alpha",
        inventory: inventoryWith([
          bareRepo("alpha-repo", "/bare/alpha.git", "alpha"),
          bareRepo("beta-repo", "/bare/beta.git", "beta"),
        ]),
        prView: () =>
          prViewOk({
            number: 500,
            title: "feat (#500)",
            body: `Refs ${foreignRef}\n`,
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
    const parsed = JSON.parse(logs[0]!);
    const skip = parsed.targets.find(
      (t: { kind: string }) => t.kind === "skip:bd-foreign-workspace",
    );
    expect(skip).toBeDefined();
    expect(skip.raw).toBe(foreignRef);
    expect(skip.prefix).toBe("beta");
    expect(skip.repo).toBe("beta-repo");
  });

  test("foreign bd long-id with no inventory pin → skip:bd-missing-pin with hint", () => {
    const foreignRef = "BD-orphan-1234567890123-1-deadbeef";
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 501 }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        localPrefix: "alpha",
        inventory: inventoryWith([
          bareRepo("alpha-repo", "/bare/alpha.git", "alpha"),
        ]),
        prView: () =>
          prViewOk({
            number: 501,
            title: "feat (#501)",
            body: `Refs ${foreignRef}\n`,
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("skip");
    expect(out).toContain(foreignRef);
    expect(out).toContain('"orphan"');
    expect(out).toContain("prx repo add");
  });

  test("local bd long-id (prefix === local) still closes via existing path", () => {
    const localRef = "BD-alpha-1234567890123-1-cafebabe";
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 502 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        localPrefix: "alpha",
        inventory: inventoryWith([
          bareRepo("alpha-repo", "/bare/alpha.git", "alpha"),
        ]),
        prView: () =>
          prViewOk({
            number: 502,
            title: "feat (#502)",
            body: `Refs ${localRef}\n`,
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toEqual([
      { kind: "bd-show", id: "BD-cafebabe" },
    ]);
    expect(calls.filter((c) => c.kind === "bd-close")).toEqual([
      { kind: "bd-close", id: "BD-cafebabe" },
    ]);
  });

  test("short-form bd id (no embedded prefix) still closes via existing path", () => {
    const calls: CallTag[] = [];
    const exit = runPostmerge(
      makeOpts({ prNumber: 503 }),
      { log: () => undefined, error: () => undefined },
      makeDeps({
        calls,
        // Even with a foreign inventory pinned to another prefix, a short-form
        // ref carries no prefix and routes locally — this guards against
        // accidental routing of `BD-<8hex>` ids through `decideRoute`.
        localPrefix: "alpha",
        inventory: inventoryWith([
          bareRepo("alpha-repo", "/bare/alpha.git", "alpha"),
          bareRepo("beta-repo", "/bare/beta.git", "beta"),
        ]),
        prView: () =>
          prViewOk({
            number: 503,
            title: "feat (#503)",
            body: "Refs BD-deadbeef\n",
            closing: [],
          }),
      }),
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toEqual([
      { kind: "bd-show", id: "BD-deadbeef" },
    ]);
    expect(calls.filter((c) => c.kind === "bd-close")).toEqual([
      { kind: "bd-close", id: "BD-deadbeef" },
    ]);
  });

  test("narrowed overlay does not hide foreign long-id — safety-net surfaces skip:bd-foreign-workspace", () => {
    // Identity overlay that only accepts a semantic-id bd shape, so the
    // foreign-prefix long-id would be filtered by `extractCanonicalRefs`.
    // The GH-1806 safety-net union scan must still surface it.
    const foreignRef = "BD-beta-1234567890123-1-deadbeef";
    const semanticIdentity: IdentityConfig = {
      sources: {
        github: {
          name: "github",
          kind: "github",
          canonicalIdPattern: /^BD-[a-z]+$/,
          source: "<test>",
        },
      },
      defaultSourceName: "github",
      isDefault: false,
    };
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const deps = makeDeps({
      calls,
      localPrefix: "alpha",
      inventory: inventoryWith([
        bareRepo("alpha-repo", "/bare/alpha.git", "alpha"),
        bareRepo("beta-repo", "/bare/beta.git", "beta"),
      ]),
      prView: () =>
        prViewOk({
          number: 504,
          title: "feat (#504)",
          body: `Refs ${foreignRef}\n`,
          closing: [],
        }),
    });
    deps.loadIdentityConfig = (() => semanticIdentity) as never;
    const exit = runPostmerge(
      makeOpts({ prNumber: 504, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      deps,
    );
    expect(exit).toBe(0);
    expect(calls.filter((c) => c.kind === "bd-show")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(0);
    const parsed = JSON.parse(logs[0]!);
    const skip = parsed.targets.find(
      (t: { kind: string }) => t.kind === "skip:bd-foreign-workspace",
    );
    expect(skip).toBeDefined();
    expect(skip.raw).toBe(foreignRef);
    expect(skip.prefix).toBe("beta");
    expect(skip.repo).toBe("beta-repo");
  });
});

describe("runPostmerge — JSON output round-trip", () => {
  test("--format json emits parseable render", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    runPostmerge(
      makeOpts({ prNumber: 1313, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      makeDeps({
        calls,
        prView: () =>
          prViewOk({
            number: 1313,
            title: "feat (GH-885) (#1313)",
            body: "Also: GH-882",
            closing: [885],
          }),
      }),
    );
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.prNumber).toBe(1313);
    expect(parsed.candidates).toEqual([882]);
    expect(parsed.closingIssuesReferences).toEqual([885]);
    expect(parsed.exitCode).toBe(0);
  });
});
