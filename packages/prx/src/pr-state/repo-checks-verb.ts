// `prx repo-checks` (a.k.a. `repo checks` / `scout checks`) as a spec-driven
// VerbSpec — a deps-bearing read migrated off cli.ts (ADR
// docs/prx/cli-decomposition.md). It lists the required-status-check names for a
// repo's branch and, via the `exitCode` projection, exits 1 when none resolve
// (an empty list usually means the ruleset/branch-protection couldn't be read).

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { formatRepoChecks } from "./cli-format.ts";
import { repoCheckNames, type RepoCheckNamesResult } from "./github.ts";

export type RepoChecksDeps = { repoCheckNames: typeof repoCheckNames };
const realRepoChecksDeps = (): RepoChecksDeps => ({ repoCheckNames });

export const RepoChecksOutput = z
  .object({
    repo: z.string(),
    branch: z.string(),
    sha: z.string(),
    checks: z.array(z.string()),
  })
  .loose();
export type RepoChecksOutput = z.infer<typeof RepoChecksOutput>;

export const repoChecksVerb = defineVerb({
  id: "repo-checks",
  summary: "List a repo branch's required status-check names; exits 1 when none resolve.",
  actor: "work",
  input: z.object({
    "repo-path": z.string().default(".").describe("repo worktree path"),
    repo: z.string().optional().describe("owner/name override (defaults to the repo at --repo-path)"),
    branch: z.string().default("main").describe("branch whose checks to read"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: RepoChecksOutput,
  deps: realRepoChecksDeps,
  run: (input, deps: RepoChecksDeps = realRepoChecksDeps()): RepoChecksOutput =>
    deps.repoCheckNames(input["repo-path"], { repo: input.repo, branch: input.branch }),
  render: (out, input) => formatRepoChecks(out as RepoCheckNamesResult, input.format),
  exitCode: (out) => (out.checks.length > 0 ? 0 : 1),
});
