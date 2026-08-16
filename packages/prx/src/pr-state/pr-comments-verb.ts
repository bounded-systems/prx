// `prx pr-comments` (a.k.a. `repo pr-comments` / `scout comments`) as a
// deps-bearing VerbSpec migrated off cli.ts (ADR docs/prx/cli-decomposition.md).
// Two actions in one verb: `show` fetches a PR's review-comment surface;
// `resolve` resolves the given threads (variadic positionals + repeatable
// `--thread`, plus `--all-unresolved`) and re-reads. `--write` (or `--output`)
// persists the JSON snapshot. Both exit 1 while unresolved threads remain (the
// `exitCode` projection). The action is selected from the `resolve` sub-token in
// the early dispatch and passed as `--action`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { CliError } from "./cli-error.ts";
import { formatPrComments, formatPrCommentsResolution } from "./cli-format.ts";
import {
  fetchPrComments,
  resolvePrReviewThreads,
  type PrCommentsResult,
  type PrReviewThreadResolution,
} from "./github.ts";

function defaultPrCommentsOutputPath(repoPath: string): string {
  return join(repoPath, ".pr", "local", "review-comments.json");
}

export type PrCommentsDeps = {
  fetchPrComments: typeof fetchPrComments;
  resolvePrReviewThreads: typeof resolvePrReviewThreads;
};
const realPrCommentsDeps = (): PrCommentsDeps => ({ fetchPrComments, resolvePrReviewThreads });

export const PrCommentsOutput = z
  .object({
    action: z.enum(["show", "resolve"]),
    summary: z.unknown(), // PrCommentsResult — the current (post-resolution) state
    resolvedThreads: z.unknown().optional(), // PrReviewThreadResolution[] (resolve only)
    outputPath: z.string().optional(),
    unresolvedThreads: z.number(),
  })
  .loose();
export type PrCommentsOutput = z.infer<typeof PrCommentsOutput>;

export const prCommentsVerb = defineVerb({
  id: "pr-comments",
  summary:
    "Show a PR's review-comment threads, or resolve them; exits 1 while any stay unresolved.",
  actor: "work",
  positionals: ["thread"],
  input: z.object({
    action: z
      .enum(["show", "resolve"])
      .default("show")
      .describe("show the threads or resolve them"),
    "repo-path": z.string().default(".").describe("repo worktree path"),
    pr: z.string().optional().describe("PR ref; defaults to the current branch"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    output: z.string().optional().describe("explicit JSON snapshot path"),
    write: z.coerce
      .boolean()
      .default(false)
      .describe("write the JSON snapshot to the default path"),
    thread: z
      .array(z.string())
      .default([])
      .describe("thread ids to resolve (variadic positionals + repeatable --thread)"),
    "all-unresolved": z.coerce.boolean().default(false).describe("resolve every unresolved thread"),
  }),
  output: PrCommentsOutput,
  deps: realPrCommentsDeps,
  run: (input, deps: PrCommentsDeps = realPrCommentsDeps()): PrCommentsOutput => {
    const repoPath = input["repo-path"];
    const outputPath =
      input.output ?? (input.write ? defaultPrCommentsOutputPath(repoPath) : undefined);
    const persist = (summary: PrCommentsResult) => {
      if (outputPath) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
      }
    };

    if (input.action === "resolve") {
      const threadIds = input.thread.map((t) => t.trim()).filter((t) => t.length > 0);
      if (threadIds.length === 0 && !input["all-unresolved"]) {
        throw new CliError(
          "pr-comments resolve requires at least one thread id or --all-unresolved",
        );
      }
      const before = deps.fetchPrComments(repoPath, input.pr);
      const ids = input["all-unresolved"]
        ? before.threads.filter((t) => !t.isResolved).map((t) => t.id)
        : threadIds;
      if (ids.length === 0) {
        throw new CliError("No unresolved review threads found to resolve");
      }
      const resolvedThreads = deps.resolvePrReviewThreads(repoPath, ids);
      const postResolution = deps.fetchPrComments(repoPath, input.pr);
      persist(postResolution);
      return {
        action: "resolve",
        summary: postResolution,
        resolvedThreads,
        outputPath,
        unresolvedThreads: postResolution.unresolvedThreads,
      };
    }

    const summary = deps.fetchPrComments(repoPath, input.pr);
    persist(summary);
    return { action: "show", summary, outputPath, unresolvedThreads: summary.unresolvedThreads };
  },
  render: (out, input) =>
    out.action === "resolve"
      ? formatPrCommentsResolution(
          out.resolvedThreads as PrReviewThreadResolution[],
          out.summary as PrCommentsResult,
          input.format,
          out.outputPath,
        )
      : formatPrComments(out.summary as PrCommentsResult, input.format, out.outputPath),
  exitCode: (out) => (out.unresolvedThreads === 0 ? 0 : 1),
});
