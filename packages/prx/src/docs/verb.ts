// `prx docs` — render or check every generated doc, as a spec-driven VerbSpec
// (the `prx health` template applied to the doc-generation family). One verb over
// the five targets — jsonld, readme, community, cli, claude-context — each calling
// the SAME render function the `gen-*` scripts use, so the verb and the scripts
// can't diverge.
//
// The heavy render modules (graph/readme/claude-context/community) are imported
// DYNAMICALLY inside `run`, never at module load: they resolve the repo root, and
// pulling them into the compiled binary's startup graph would add a git spawn to
// every `prx` invocation. They load only when `prx docs` actually runs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import { getRepoRoot } from "@bounded-systems/repo-root";
import { defineVerb } from "../cli/verbspec.ts";

export const DocsReport = z
  .object({
    check: z.boolean(),
    driftCount: z.number().int().nonnegative(),
    targets: z.array(
      z
        .object({
          name: z.string(),
          path: z.string(),
          status: z.enum(["wrote", "ok", "drifted", "skipped"]),
        })
        .strict(),
    ),
  })
  .strict();
export type DocsReport = z.infer<typeof DocsReport>;

type DocTarget = { name: string; path: string; content: string; gated: boolean };

/** Collect every doc target (path + freshly-rendered content) from the sources. */
async function collectTargets(root: string): Promise<DocTarget[]> {
  const [graph, readme, ctx, cliDocs, community] = await Promise.all([
    import("../graph/build.ts"),
    import("../readme/build.ts"),
    import("../claude-context/build.ts"),
    import("../cli/docs.ts"),
    import("../community/build.ts"),
  ]);
  return [
    { name: "jsonld", path: graph.GRAPH_OUTPUT, content: graph.renderGraph(), gated: true },
    { name: "readme", path: readme.README_OUTPUT, content: readme.renderReadme(), gated: true },
    { name: "claude-context", path: ctx.CONTEXT_OUTPUT, content: ctx.renderContextDoc(), gated: true },
    // cli.md is rendered but NOT drift-gated: the command set grows on main faster
    // than a branch can track (mirrors docs:check, which omits cli:check).
    { name: "cli", path: resolve(root, "docs/cli.md"), content: cliDocs.generateCliDoc() + "\n", gated: false },
    ...community.renderCommunityTargets().map((c) => ({
      name: `community:${c.output}`,
      path: resolve(root, c.output),
      content: c.content,
      gated: true,
    })),
  ];
}

export const docsVerb = defineVerb({
  id: "docs",
  summary: "Render (or --check) the generated docs: jsonld, readme, community, cli, claude-context.",
  actor: "work",
  input: z.object({
    check: z.boolean().optional().describe("validate drift instead of writing files"),
  }),
  output: DocsReport,
  run: async ({ check = false }): Promise<DocsReport> => {
    const root = getRepoRoot();
    const targets = await collectTargets(root);
    const results: DocsReport["targets"] = [];
    let driftCount = 0;
    for (const t of targets) {
      const path = relative(root, t.path) || t.path;
      if (check) {
        if (!t.gated) {
          results.push({ name: t.name, path, status: "skipped" });
          continue;
        }
        let current = "";
        try {
          current = readFileSync(t.path, "utf8");
        } catch {
          current = "";
        }
        const drifted = current !== t.content;
        if (drifted) driftCount += 1;
        results.push({ name: t.name, path, status: drifted ? "drifted" : "ok" });
      } else {
        mkdirSync(dirname(t.path), { recursive: true });
        writeFileSync(t.path, t.content, "utf8");
        results.push({ name: t.name, path, status: "wrote" });
      }
    }
    // In --check mode, a drift is a failure: throw so the CLI exits non-zero
    // (this verb backs `docs:check` / `prx ci --phase=docs`). Render mode never
    // throws — it just reports what it wrote.
    if (check && driftCount > 0) {
      const drifted = results.filter((t) => t.status === "drifted").map((t) => t.path);
      throw new Error(
        `docs out of date: ${drifted.join(", ")}\nrun \`bun run docs:render\` and commit the result.`,
      );
    }
    return { check, driftCount, targets: results };
  },
});
