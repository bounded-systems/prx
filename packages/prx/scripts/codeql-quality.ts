#!/usr/bin/env bun
/**
 * Run the three CodeQL quality rules prx cares about against the JS/TS sources.
 *
 * The rule set lives in codeql/prx-quality.qls (the single source of truth,
 * shared with the codeql-quality CI workflow):
 *   js/unused-local-variable        Declarations/UnusedVariable.ql
 *   js/useless-assignment-to-local  Declarations/DeadStoreOfLocal.ql
 *   js/trivial-conditional          Statements/UselessConditional.ql
 *
 * Requires `codeql` on PATH (opt-in: `nix develop .#codeql`, or the flake app
 * `nix run .#codeql-quality`). The official bundle includes the query packs.
 *
 * Usage:
 *   bun packages/prx/scripts/codeql-quality.ts [--source <dir>] [--out <sarif>] [--check]
 * Env:
 *   CODEQL_DB  reuse/keep a database dir (default: temp dir, removed on exit)
 *
 * Exit code: 0 normally; with --check, 1 if any findings are reported.
 */
import { $ } from "bun";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * A finalized CodeQL database has a `db-<lang>/` dataset dir (the `.yml` alone
 * is written by a `create` that may have failed before finalizing).
 */
function isFinalizedDb(dir: string): boolean {
  if (!existsSync(join(dir, "codeql-database.yml"))) return false;
  try {
    return readdirSync(dir).some(
      (e) => e.startsWith("db-") && existsSync(join(dir, e, "default")),
    );
  } catch {
    return false;
  }
}

/**
 * Single source of truth for which rules run — a CodeQL suite filtered to the
 * three ids. Shared with the codeql-quality CI workflow. Resolved relative to
 * the source root (repo root).
 */
const SUITE = "codeql/prx-quality.qls";

/** Minimal SARIF 2.1.0 shape we consume — validated, not trusted. */
const Finding = z.object({
  ruleId: z.string(),
  message: z.object({ text: z.string() }).partial().optional(),
  locations: z
    .array(
      z.object({
        physicalLocation: z.object({
          artifactLocation: z.object({ uri: z.string() }),
          region: z.object({ startLine: z.number() }).partial().optional(),
        }),
      }),
    )
    .default([]),
});
const Sarif = z.object({
  runs: z.array(z.object({ results: z.array(Finding).default([]) })).default([]),
});
type Finding = z.infer<typeof Finding>;

function parseArgs(argv: string[]) {
  const opts = { source: "", out: "codeql-quality.sarif", check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") opts.source = argv[++i] ?? "";
    else if (a === "--out") opts.out = argv[++i] ?? opts.out;
    else if (a === "--check") opts.check = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** Run a command with live stdout/stderr; throw on non-zero exit. */
async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${cmd.join(" ")}`);
}

async function main() {
  const opts = parseArgs(Bun.argv.slice(2));

  if (!Bun.which("codeql")) {
    console.error(
      "error: codeql not on PATH. Run inside 'nix develop .#codeql' or use 'nix run .#codeql-quality'.",
    );
    process.exit(127);
  }

  const sourceRoot =
    opts.source || (await $`git rev-parse --show-toplevel`.text()).trim();

  // Database: reuse $CODEQL_DB if set, else a self-cleaning temp dir.
  let db = process.env.CODEQL_DB ?? "";
  let cleanup = "";
  if (!db) {
    db = mkdtempSync(join(tmpdir(), "prx-codeql-db."));
    cleanup = db;
  }
  try {
    if (!isFinalizedDb(db)) {
      console.error(
        `>> Building CodeQL database (javascript-typescript) from ${sourceRoot} ...`,
      );
      await run([
        "codeql",
        "database",
        "create",
        db,
        "--language=javascript-typescript",
        `--source-root=${sourceRoot}`,
        "--overwrite",
      ]);
    }

    console.error(`>> Running quality suite ${SUITE} ...`);
    await run([
      "codeql",
      "database",
      "analyze",
      db,
      join(sourceRoot, SUITE),
      "--format=sarifv2.1.0",
      `--output=${opts.out}`,
      "--threads=0",
      "--rerun",
    ]);
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }

  const sarif = Sarif.parse(await Bun.file(opts.out).json());
  const findings: Finding[] = sarif.runs.flatMap((r) => r.results);

  const byRule = new Map<string, number>();
  for (const f of findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);

  console.error(`\n>> Results: ${opts.out}`);
  console.log("\n== Findings by rule ==");
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(4)}  ${rule}`);
  }

  console.log("\n== Findings (rule  file:line) ==");
  const lines = findings
    .map((f) => {
      const loc = f.locations[0]?.physicalLocation;
      const where = loc
        ? `${loc.artifactLocation.uri}:${loc.region?.startLine ?? "?"}`
        : "<unknown>";
      return `${f.ruleId}\t${where}`;
    })
    .sort();
  for (const l of lines) console.log(l);

  if (opts.check && findings.length > 0) process.exit(1);
}

await main();
