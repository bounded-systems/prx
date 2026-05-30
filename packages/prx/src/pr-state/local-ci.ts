// `prx ci` (GH-955) — CLI surface for the `local_ci` actor's `run` accept.
//
// Runs the canonical local-validation pipeline (install → typecheck → build →
// test) so `.github/workflows/ci.yml` can be a thin shell over the prx surface
// instead of calling raw `bun test` / `bun build`. Per the workflow model
// (`prx actors --scope workflow`), this is the executor for the `local_ci`
// actor; emitted `LOCAL_CI_*` events feed the `ci` parallel region
// (pending → running → passed|failed).
//
// Out of scope (covered by #352): projecting LOCAL_CI_* events into
// `.pr/local/pr.json` and the parity chain. This module only stamps event
// lines on stderr / in the JSON summary so reviewers can see the contract;
// downstream wiring belongs to the prx-ci semantic-state validation work.
import { defaultRunner, runCaptured } from "@bounded-systems/proc";
import { z } from "zod";

export const CI_PHASES = ["install", "typecheck", "build", "test"] as const;
export type CiPhase = (typeof CI_PHASES)[number];

export const ciOptionsSchema = z.object({
  phase: z.enum(CI_PHASES).optional(),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type CiOptions = z.infer<typeof ciOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

type PhaseResult = {
  phase: CiPhase;
  status: number;
  durationMs: number;
  stdout?: string;
  stderr?: string;
};

type PhaseSpec = {
  argv: string[];
  // When the build phase runs we need a baked git SHA in the binary, computed
  // at phase-execution time so the bake matches the working tree.
  prepareEnv?: () => Record<string, string>;
  prepare?: () => void;
};

function bakedGitSha(): string {
  const r = runCaptured(["git", "rev-parse", "--short=12", "HEAD"], { check: false });
  if (r.status === 0) return r.stdout.trim();
  return "";
}

function ensureDistDir(): void {
  defaultRunner(["mkdir", "-p", "dist"], { stdio: "inherit", check: false });
}

function phaseSpec(phase: CiPhase): PhaseSpec {
  switch (phase) {
    case "install":
      return { argv: ["bun", "install", "--frozen-lockfile"] };
    case "typecheck":
      return { argv: ["bunx", "tsc", "--noEmit"] };
    case "build":
      return {
        argv: [
          "bun",
          "build",
          "--compile",
          "--define",
          `__PRX_BUILD_GIT_SHA__="${bakedGitSha()}"`,
          "packages/prx/scripts/pr_state.ts",
          "--outfile",
          "dist/prx",
        ],
        prepare: ensureDistDir,
      };
    case "test":
      return { argv: ["bun", "test"] };
  }
}

function runPhase(phase: CiPhase, format: "plain" | "json", output: Output): PhaseResult {
  const spec = phaseSpec(phase);
  const start = Date.now();
  output.error(`LOCAL_CI_STARTED phase=${phase}`);
  spec.prepare?.();
  const r = format === "plain"
    ? defaultRunner(spec.argv, { stdio: "inherit", check: false })
    : runCaptured(spec.argv, { check: false });
  const status = r.status;
  const durationMs = Date.now() - start;
  output.error(`${status === 0 ? "LOCAL_CI_PASSED" : "LOCAL_CI_FAILED"} phase=${phase} duration_ms=${durationMs}`);
  if (format === "json") {
    return {
      phase,
      status,
      durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }
  return { phase, status, durationMs };
}

export function runCi(opts: CiOptions, output: Output): number {
  const phases: CiPhase[] = opts.phase ? [opts.phase] : [...CI_PHASES];
  const results: PhaseResult[] = [];
  for (const phase of phases) {
    const result = runPhase(phase, opts.format, output);
    results.push(result);
    if (result.status !== 0) break;
  }
  if (opts.format === "json") {
    output.log(JSON.stringify({ phases: results }, null, 2));
  } else {
    const passed = results.filter((r) => r.status === 0).length;
    const failed = results.find((r) => r.status !== 0);
    if (failed) {
      output.error(`prx ci: failed at phase=${failed.phase} (passed ${passed} of ${phases.length})`);
    } else {
      output.error(`prx ci: passed ${passed} of ${phases.length} phases`);
    }
  }
  return results.some((r) => r.status !== 0) ? 1 : 0;
}
