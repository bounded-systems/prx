// GH-1239 — `prx plan preflight` standalone verb + plan-session auto-step.
//
// Coverage:
//   * standalone-verb dispatch through runCli (parsing, exit codes, plain
//     and JSON output shapes)
//   * --skip-preflight flag plumbing on `prx plan session`
//   * auto-step refuses session entry on non-pass status
//   * auto-step skipped when --check / --dry-run pass through

import { describe, expect, test } from "bun:test";

import { parseArgs, CliExitError } from "@bounded-systems/verbspec";
import {
  planPreflightVerb,
  type PlanPreflightDeps,
} from "../../src/pr-state/plan-preflight-verb.ts";
import { preflightExitCode } from "../../src/plan/preflight_schema.ts";
import type { PreflightResult } from "../../src/plan/preflight_schema.ts";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

// `plan preflight` is a VerbSpec now; drive its CLI path (parse → run → render
// → exit, with CliExitError → exit code) the way the legacy `runCli(["plan",
// "preflight", …], output, deps)` harness did. argv arrives as ["plan",
// "preflight", …rest].
async function runPlanPreflightCli(
  argv: string[],
  output: Output,
  deps: Partial<PlanPreflightDeps>,
): Promise<number> {
  const rest = argv.slice(2);
  try {
    const input = parseArgs(planPreflightVerb as never, rest) as Parameters<
      typeof planPreflightVerb.run
    >[0];
    const out = await planPreflightVerb.run(input, { ...planPreflightVerb.deps!(), ...deps });
    output.log(planPreflightVerb.render!(out, input));
    return preflightExitCode((out as { result: PreflightResult }).result.status);
  } catch (e) {
    output.error(e instanceof Error ? e.message : String(e));
    return e instanceof CliExitError ? e.exitCode : 1;
  }
}

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

const PASS_RESULT: PreflightResult = {
  unit: "GH-1239",
  status: "pass",
  findings: [],
  counts: {
    deliverablesExtracted: 0,
    deliverablesAlreadyDone: 0,
    actionsExtracted: 0,
    actionsInfeasible: 0,
    actionsDeferredToOtherRole: 0,
    actionsPerspectiveMismatched: 0,
    blockersExtracted: 0,
    blockersOpen: 0,
  },
};

const REFUSAL_RESULT: PreflightResult = {
  unit: "GH-1199",
  status: "infeasible-action",
  findings: [
    {
      axis: "infeasible-action",
      shape: "gh-issue",
      subcommand: "close",
      reason: "blocked",
    },
  ],
  counts: {
    deliverablesExtracted: 0,
    deliverablesAlreadyDone: 0,
    actionsExtracted: 1,
    actionsInfeasible: 1,
    actionsDeferredToOtherRole: 0,
    actionsPerspectiveMismatched: 0,
    blockersExtracted: 0,
    blockersOpen: 0,
  },
};

describe("prx plan preflight (standalone verb)", () => {
  test("exit 0 on pass; plain output renders the safe-to-draft summary", async () => {
    const { logs, errors, output } = captureOutput();
    let called = false;
    const exit = await runPlanPreflightCli(
      ["plan", "preflight", "GH-1239"],
      output,
      {
        runPlanPreflight: async (input) => {
          called = true;
          expect(input.unit).toBe("GH-1239");
          return PASS_RESULT;
        },
      },
    );
    expect(exit).toBe(0);
    expect(called).toBe(true);
    expect(errors).toEqual([]);
    const stdout = logs.join("\n");
    expect(stdout).toContain("status: pass");
    expect(stdout).toContain("safe to draft");
  });

  test("exit 1 on non-pass; plain output names the offending action shape", async () => {
    const { logs, errors, output } = captureOutput();
    const exit = await runPlanPreflightCli(
      ["plan", "preflight", "GH-1199"],
      output,
      {
        runPlanPreflight: async () => REFUSAL_RESULT,
      },
    );
    expect(exit).toBe(1);
    expect(errors).toEqual([]);
    const stdout = logs.join("\n");
    expect(stdout).toContain("status: infeasible-action");
    expect(stdout).toContain("infeasible-action [gh-issue]: close (blocked)");
  });

  test("exit 2 when the preflight throws (network/parse error)", async () => {
    const { logs, errors, output } = captureOutput();
    const exit = await runPlanPreflightCli(
      ["plan", "preflight", "GH-1239"],
      output,
      {
        runPlanPreflight: async () => {
          throw new Error("gh issue view failed: 503");
        },
      },
    );
    expect(exit).toBe(2);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("gh issue view failed: 503");
  });

  test("--format json emits the schema-shape result on stdout", async () => {
    const { logs, output } = captureOutput();
    const exit = await runPlanPreflightCli(
      ["plan", "preflight", "GH-1239", "--format", "json"],
      output,
      {
        runPlanPreflight: async () => PASS_RESULT,
      },
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toEqual(PASS_RESULT);
  });

  test("missing positional → CliError with usage hint", async () => {
    const { errors, output } = captureOutput();
    const exit = await runPlanPreflightCli(["plan", "preflight"], output, {});
    expect(exit).not.toBe(0);
    expect(errors.join("\n")).toContain(
      "plan preflight requires a work-unit id",
    );
  });
});
