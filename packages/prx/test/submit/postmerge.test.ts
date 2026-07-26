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
import type { IdentityConfig } from "../../src/pr-state/github.ts";

type PrViewTag = { kind: "pr-view"; number: number };
type GhCall = { kind: "gh"; subcommand: string; args: string[] };
type CloseCall = {
  kind: "close";
  number: number;
  reason?: string | undefined;
  repo?: string | undefined;
};
type CallTag = PrViewTag | GhCall | CloseCall;

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

function makeDeps(opts: {
  calls: CallTag[];
  prView: () => GhPrViewResult;
  issueViewState?: Record<number, "OPEN" | "CLOSED">;
  perGhSubcommand?: Partial<Record<string, () => GhExecResult>>;
  close?: () => GhIssueCloseResult;
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
    loadIdentityConfig: (() => defaultIdentity) as never,
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
    const commentCalls = calls.filter((c) => c.kind === "gh" && c.subcommand === "comment");
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

describe("runPostmerge — notion refs are filtered (no gh shape)", () => {
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
            body: "References NOTION-1234567890abcdef1234567890abcdef but no GH refs.",
            closing: [],
          }),
      }),
    );
    expect(calls.filter((c) => c.kind === "close")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "gh")).toHaveLength(0);
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
