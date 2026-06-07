// `prx worktree` (a.k.a. `worktree status`) and `prx worktrees` (`worktree
// list`) as spec-driven VerbSpecs — deps-bearing reads migrated off cli.ts via
// the VerbSpec deps seam (ADR docs/prx/cli-decomposition.md). Each wraps a
// single github.ts status read (its small deps slice, defaulted to the real
// reader and injectable in tests) and renders it via the cli-format leaf. No
// other side effects. `worktree remove` stays on the legacy handler (mux deps).

import { z } from "zod";

import { defineVerb } from "../cli/verbspec.ts";
import { formatWorktree, formatWtStatus } from "./cli-format.ts";
import { worktreeStatus, wtStatus } from "./github.ts";

const RenderedOutput = z.object({ rendered: z.string() }).strict();
export type RenderedOutput = z.infer<typeof RenderedOutput>;

export type WorktreeDeps = { worktreeStatus: typeof worktreeStatus };
const realWorktreeDeps = (): WorktreeDeps => ({ worktreeStatus });

export const worktreeVerb = defineVerb({
  id: "worktree",
  summary: "Show the current worktree's PR-relevant status for a repo path.",
  actor: "work",
  input: z.object({
    "repo-path": z.string().default(".").describe("repo worktree path"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
  }),
  output: RenderedOutput,
  deps: realWorktreeDeps,
  run: (input, deps: WorktreeDeps = realWorktreeDeps()): RenderedOutput => ({
    rendered: formatWorktree(deps.worktreeStatus(input["repo-path"]), input.format),
  }),
  render: (out) => out.rendered,
});

export type WorktreesDeps = { wtStatus: typeof wtStatus };
const realWorktreesDeps = (): WorktreesDeps => ({ wtStatus });

export const worktreesVerb = defineVerb({
  id: "worktrees",
  summary: "List the repo's worktrees and their branch/PR status.",
  actor: "work",
  input: z.object({
    "repo-path": z.string().default(".").describe("repo worktree path"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    "include-git-details": z.coerce.boolean().default(true).describe("include per-worktree git detail"),
  }),
  output: RenderedOutput,
  deps: realWorktreesDeps,
  run: (input, deps: WorktreesDeps = realWorktreesDeps()): RenderedOutput => ({
    rendered: formatWtStatus(
      deps.wtStatus(input["repo-path"], input["include-git-details"]),
      input.format,
    ),
  }),
  render: (out) => out.rendered,
});
