// Code-health detection — an honest, grounded read on sprawl, coupling, dead
// code, and "what the product actually is". Not a quality gate (that's
// test/code_health.test.ts, which ratchets the cheap deterministic budgets); this
// is the on-demand deep scan.
//
//   bun run health            # human report
//   bun run health -- --json  # machine output
//
// Modern toolchain (replaced madge):
//   - knip            → dead code (unused files, reachability from entrypoints,
//                       declared in knip.json — no ad-hoc entrypoint heuristics).
//   - dependency-cruiser → circular imports (rule-based; .dependency-cruiser.cjs).
//   - bespoke         → sprawl (largest files) + product map (value-prop trace),
//                       which neither tool models.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../src/repo-root.ts";
import { VALUE_PROPS } from "../src/value_props.ts";
import { CodeHealthReport } from "../src/health/model.ts";
import { prxCommandRegistry } from "../src/cli/registry.data.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");

function run(cmd: string, cmdArgs: string[]): string {
  const r = spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.stdout ?? "";
}
function tracked(glob: string): string[] {
  return run("git", ["ls-files", glob]).split("\n").filter(Boolean);
}

// 1. SPRAWL — largest source files (the god-file watch). ---------------------
const srcFiles = tracked("packages/prx/src/**/*.ts").filter((f) => !f.endsWith(".test.ts"));
const sizes = srcFiles
  .map((f) => ({ file: f, lines: readFileSync(join(REPO_ROOT, f), "utf8").split("\n").length }))
  .sort((a, b) => b.lines - a.lines);
const totalLines = sizes.reduce((n, s) => n + s.lines, 0);

// 2. COUPLING — circular imports (dependency-cruiser). ----------------------
let circularChains = 0;
let cycleSamples: string[] = [];
try {
  const dc = JSON.parse(
    run("bunx", ["depcruise", "packages/prx/src", "--config", ".dependency-cruiser.cjs", "--output-type", "json"]),
  );
  const violations: Array<{ rule?: { name?: string }; from?: string; to?: string }> = dc.summary?.violations ?? [];
  const circ = violations.filter((v) => v.rule?.name === "no-circular");
  circularChains = circ.length;
  cycleSamples = circ.slice(0, 12).map((v) => `${v.from} → ${v.to}`);
} catch {
  cycleSamples = ["(dependency-cruiser unavailable — run `bun install`)"];
}

// 3. DEAD CODE — unused files (knip, reachability from knip.json entries). ---
let deadFiles: string[] = [];
try {
  const k = JSON.parse(run("bunx", ["knip-bun", "--include", "files", "--reporter", "json"]));
  const issues: Array<{ file: string; files?: unknown[] }> = k.issues ?? [];
  deadFiles = issues.filter((i) => (i.files?.length ?? 0) > 0).map((i) => i.file).sort();
} catch {
  deadFiles = ["(knip unavailable — run `bun install`)"];
}

// 4. PRODUCT MAP — modules that trace to a value-prop forcing function. ------
const exercised = new Set<string>();
for (const vp of VALUE_PROPS) {
  for (const ff of vp.forcing) {
    if ("exercises" in ff) {
      for (const ref of ff.exercises) exercised.add(ref.split(":")[0]!.replace(/^packages\/prx\/src\//, ""));
    }
  }
}
const backedCount = VALUE_PROPS.filter((vp) => !vp.forcing.some((ff) => "pending" in ff)).length;

// 5. BOUNDARY — Zod coverage of the IO seams (portable, over the src files). ---
const countMatches = (re: RegExp) =>
  srcFiles.reduce((n, f) => n + (readFileSync(join(REPO_ROOT, f), "utf8").match(re)?.length ?? 0), 0);
const zAnyHoles = countMatches(/z\.(any|unknown)\(/g);
const rawJsonParse = countMatches(/JSON\.parse\(/g);

// 6. VERBSPEC — spec-driven-CLI readiness over the command registry. ----------
// Counts how many verbs declare the GH-1242 substrate fields (`args` = input
// Zod, `event` = typed machine event) en route to full VerbSpec coverage.
const verbs = prxCommandRegistry.length;
const withInput = prxCommandRegistry.filter((c) => c.args !== undefined).length;
const withEvent = prxCommandRegistry.filter((c) => c.event !== undefined).length;

// Schema-first: validate the report against src/health/model.ts before emitting.
const report = CodeHealthReport.parse({
  sprawl: { totalLines, fileCount: sizes.length, largest: sizes.slice(0, 10) },
  coupling: { circularChains, samples: cycleSamples },
  deadCode: { count: deadFiles.length, files: deadFiles },
  productMap: { valueProps: VALUE_PROPS.length, backed: backedCount, modulesExercised: exercised.size },
  boundary: { zAnyHoles, rawJsonParse },
  verbspec: { verbs, withInput, withEvent },
});

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# prx code health\n`);
  console.log(`## 1. Sprawl — ${report.sprawl.fileCount} src files, ${totalLines.toLocaleString()} lines`);
  for (const s of report.sprawl.largest) console.log(`  ${String(s.lines).padStart(6)}  ${s.file}`);
  console.log(`\n## 2. Coupling — ${circularChains} circular import edges (dependency-cruiser)`);
  for (const c of cycleSamples) console.log(`  ${c}`);
  if (circularChains > cycleSamples.length) console.log(`  … and ${circularChains - cycleSamples.length} more`);
  console.log(`\n## 3. Dead code — ${deadFiles.length} unused file(s) (knip)`);
  for (const f of deadFiles) console.log(`  ${f}`);
  console.log(`\n## 4. Product map — ${backedCount}/${VALUE_PROPS.length} value props backed; ${exercised.size} modules traced`);
  console.log(`  (modules named by no forcing function are pruning candidates — see value_props.ts)`);
  console.log(`\n## 5. Zod boundary — ${zAnyHoles} z.any()/z.unknown() holes; ${rawJsonParse} JSON.parse sites`);
  console.log(`  (lower is better — each is an IO boundary that should be schema-validated)`);
  const pct = (n: number) => (verbs === 0 ? 0 : Math.round((n / verbs) * 100));
  console.log(`\n## 6. VerbSpec — ${withInput}/${verbs} verbs with input schema (${pct(withInput)}%); ${withEvent}/${verbs} with typed event (${pct(withEvent)}%)`);
  console.log(`  (higher is better — spec-driven-CLI readiness; target 100% as the VerbSpec migration lands)`);
}
