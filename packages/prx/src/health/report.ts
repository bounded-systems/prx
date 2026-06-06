// The code-health computation, extracted from `scripts/code-health.ts` so both
// the `bun run health` script AND the spec-driven `prx health` verb
// (`src/health/verb.ts`) gather the SAME report from one place. The script keeps
// only argv parsing + the human markdown; the canonical structured surface is
// `computeHealthReport()` → a validated `CodeHealthReport` (src/health/model.ts).
//
// IO (subprocess + file reads + `git ls-files`) is injected via `HealthIo` so the
// pure assembly is unit-testable without shelling out to knip/dependency-cruiser.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runCaptured } from "@bounded-systems/proc";
import { getRepoRoot } from "@bounded-systems/repo-root";

import { VALUE_PROPS } from "../value_props.ts";
import { prxCommandRegistry } from "../cli/registry.data.ts";
import { CodeHealthReport } from "./model.ts";

/** The external-world seams the report reads — injectable for tests. */
export type HealthIo = {
  /** Run a tool, returning stdout (""+ on failure). */
  run: (cmd: string, args: string[]) => string;
  /** Read a repo-relative file as utf8. */
  readFile: (relPath: string) => string;
  /** `git ls-files <glob>` → tracked paths. */
  tracked: (glob: string) => string[];
};

// Root resolution is owned by @bounded-systems/repo-root: lazy + git-based, so it
// is safe in the compiled binary (bun's virtual fs has no `.git` ancestor) and
// scans whatever prx checkout `prx health` is invoked from. Spawns route through
// @bounded-systems/proc; `check: false` returns stdout regardless of exit code —
// depcruise/knip exit non-zero when they have findings, and we want that output.
export const defaultHealthIo: HealthIo = {
  run(cmd, args) {
    return runCaptured([cmd, ...args], { cwd: getRepoRoot(), check: false }).stdout;
  },
  readFile(relPath) {
    return readFileSync(join(getRepoRoot(), relPath), "utf8");
  },
  tracked(glob) {
    return this.run("git", ["ls-files", glob]).split("\n").filter(Boolean);
  },
};

/** Gather the metrics and validate them against the schema before returning. */
export function computeHealthReport(io: HealthIo = defaultHealthIo): CodeHealthReport {
  // 1. SPRAWL — largest source files (the god-file watch). -------------------
  const srcFiles = io.tracked("packages/prx/src/**/*.ts").filter((f) => !f.endsWith(".test.ts"));
  const sizes = srcFiles
    .map((f) => ({ file: f, lines: io.readFile(f).split("\n").length }))
    .sort((a, b) => b.lines - a.lines);
  const totalLines = sizes.reduce((n, s) => n + s.lines, 0);

  // 2. COUPLING — circular imports (dependency-cruiser). --------------------
  let circularChains = 0;
  let cycleSamples: string[] = [];
  try {
    const dc = JSON.parse(
      io.run("bunx", ["depcruise", "packages/prx/src", "--config", ".dependency-cruiser.cjs", "--output-type", "json"]),
    );
    const violations: Array<{ rule?: { name?: string }; from?: string; to?: string }> = dc.summary?.violations ?? [];
    const circ = violations.filter((v) => v.rule?.name === "no-circular");
    circularChains = circ.length;
    cycleSamples = circ.slice(0, 12).map((v) => `${v.from} → ${v.to}`);
  } catch {
    cycleSamples = ["(dependency-cruiser unavailable — run `bun install`)"];
  }

  // 3. DEAD CODE — unused files (knip, reachability from knip.json entries). -
  let deadFiles: string[] = [];
  try {
    const k = JSON.parse(io.run("bunx", ["knip-bun", "--include", "files", "--reporter", "json"]));
    const issues: Array<{ file: string; files?: unknown[] }> = k.issues ?? [];
    deadFiles = issues.filter((i) => (i.files?.length ?? 0) > 0).map((i) => i.file).sort();
  } catch {
    deadFiles = ["(knip unavailable — run `bun install`)"];
  }

  // 4. PRODUCT MAP — modules that trace to a value-prop forcing function. ----
  const exercised = new Set<string>();
  for (const vp of VALUE_PROPS) {
    for (const ff of vp.forcing) {
      if ("exercises" in ff) {
        for (const ref of ff.exercises) exercised.add(ref.split(":")[0]!.replace(/^packages\/prx\/src\//, ""));
      }
    }
  }
  const backedCount = VALUE_PROPS.filter((vp) => !vp.forcing.some((ff) => "pending" in ff)).length;

  // 5. BOUNDARY — Zod coverage of the IO seams (over the src files). ---------
  const countMatches = (re: RegExp) =>
    srcFiles.reduce((n, f) => n + (io.readFile(f).match(re)?.length ?? 0), 0);
  const zAnyHoles = countMatches(/z\.(any|unknown)\(/g);
  const rawJsonParse = countMatches(/JSON\.parse\(/g);

  // 6. VERBSPEC — spec-driven-CLI readiness over the command registry. -------
  const verbs = prxCommandRegistry.length;
  const withInput = prxCommandRegistry.filter((c) => c.args !== undefined).length;
  const withEvent = prxCommandRegistry.filter((c) => c.event !== undefined).length;

  return CodeHealthReport.parse({
    sprawl: { totalLines, fileCount: sizes.length, largest: sizes.slice(0, 10) },
    coupling: { circularChains, samples: cycleSamples },
    deadCode: { count: deadFiles.length, files: deadFiles },
    productMap: { valueProps: VALUE_PROPS.length, backed: backedCount, modulesExercised: exercised.size },
    boundary: { zAnyHoles, rawJsonParse },
    verbspec: { verbs, withInput, withEvent },
  });
}

/** The human markdown view — a pure projection of the structured report. */
export function renderHealthMarkdown(report: CodeHealthReport): string {
  const { sprawl, coupling, deadCode, productMap, boundary, verbspec } = report;
  const pct = (n: number) => (verbspec.verbs === 0 ? 0 : Math.round((n / verbspec.verbs) * 100));
  const out: string[] = [];
  out.push(`# prx code health\n`);
  out.push(`## 1. Sprawl — ${sprawl.fileCount} src files, ${sprawl.totalLines.toLocaleString()} lines`);
  for (const s of sprawl.largest) out.push(`  ${String(s.lines).padStart(6)}  ${s.file}`);
  out.push(`\n## 2. Coupling — ${coupling.circularChains} circular import edges (dependency-cruiser)`);
  for (const c of coupling.samples) out.push(`  ${c}`);
  if (coupling.circularChains > coupling.samples.length) {
    out.push(`  … and ${coupling.circularChains - coupling.samples.length} more`);
  }
  out.push(`\n## 3. Dead code — ${deadCode.count} unused file(s) (knip)`);
  for (const f of deadCode.files) out.push(`  ${f}`);
  out.push(`\n## 4. Product map — ${productMap.backed}/${productMap.valueProps} value props backed; ${productMap.modulesExercised} modules traced`);
  out.push(`  (modules named by no forcing function are pruning candidates — see value_props.ts)`);
  out.push(`\n## 5. Zod boundary — ${boundary.zAnyHoles} z.any()/z.unknown() holes; ${boundary.rawJsonParse} JSON.parse sites`);
  out.push(`  (lower is better — each is an IO boundary that should be schema-validated)`);
  out.push(`\n## 6. VerbSpec — ${verbspec.withInput}/${verbspec.verbs} verbs with input schema (${pct(verbspec.withInput)}%); ${verbspec.withEvent}/${verbspec.verbs} with typed event (${pct(verbspec.withEvent)}%)`);
  out.push(`  (higher is better — spec-driven-CLI readiness; target 100% as the VerbSpec migration lands)`);
  return out.join("\n");
}
