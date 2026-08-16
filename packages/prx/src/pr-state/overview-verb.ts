// `prx overview` (a.k.a. `repo overview` / `scout overview`) as a spec-driven
// VerbSpec — a deps-bearing read migrated off cli.ts via the VerbSpec deps seam
// (ADR docs/prx/cli-decomposition.md). With a `<slug>` positional it resolves a
// registered repo through the inventory; otherwise it reads the cwd / --repo-path
// worktree. The inventory + status reads are the verb's `OverviewDeps` slice
// (defaulted to reals, injectable in tests).

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { CliError } from "./cli-error.ts";
import { formatOverview } from "./cli-format.ts";
import { loadRepoInventoryConfig, loadRepoInventoryIndex } from "./repos.ts";
import { overviewStatus } from "./github.ts";
import { locateRepo } from "./repo_locate.ts";

export type OverviewDeps = {
  loadRepoInventoryConfig: typeof loadRepoInventoryConfig;
  loadRepoInventoryIndex: typeof loadRepoInventoryIndex;
  overviewStatus: typeof overviewStatus;
};

const realOverviewDeps = (): OverviewDeps => ({
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  overviewStatus,
});

export const OverviewOutput = z.object({ rendered: z.string() }).strict();
export type OverviewOutput = z.infer<typeof OverviewOutput>;

export const overviewVerb = defineVerb({
  id: "overview",
  summary: "Show a repo's PR/worktree overview — by registered <slug> or the cwd / --repo-path.",
  actor: "work",
  positionals: ["slug"],
  input: z.object({
    // GH-1757: optional slug positional — resolve the target repo via the
    // inventory; null ⇒ the cwd / --repo-path flow.
    slug: z.string().nullable().default(null).describe("registered repo slug (optional)"),
    "repo-path": z.string().default(".").describe("repo worktree path when no slug is given"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    "include-diff-stats": z.coerce.boolean().default(true).describe("include per-file diff stats"),
  }),
  output: OverviewOutput,
  deps: realOverviewDeps,
  run: (input, deps: OverviewDeps = realOverviewDeps()): OverviewOutput => {
    let resolvedRepoPath = input["repo-path"];
    if (input.slug !== null) {
      const config = deps.loadRepoInventoryConfig(process.cwd());
      if (!config.indexPath) {
        throw new CliError(
          "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo overview` from a prx-managed checkout, or omit the slug to use the current directory.",
        );
      }
      const inventory = deps.loadRepoInventoryIndex(config.indexPath);
      if (!inventory) {
        throw new CliError(
          `No repo inventory index at ${config.indexPath}. Run \`prx repo add\` first to create one.`,
        );
      }
      const located = locateRepo(inventory, { slug: input.slug, cwd: process.cwd() });
      if (located.kind === "not_found") {
        throw new CliError(located.detail);
      }
      resolvedRepoPath = located.repo.mainWorktree ?? located.repo.commonDir;
    }
    const overview = deps.overviewStatus(resolvedRepoPath, input["include-diff-stats"]);
    return { rendered: formatOverview(overview, input.format) };
  },
  render: (out) => out.rendered,
});
