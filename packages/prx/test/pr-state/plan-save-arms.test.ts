// Residual arms of plan-save-verb.ts not exercised by plan-save.test.ts /
// plan-save-cleanup.test.ts: the --from-stdin/--from-file mutual-exclusion
// refusal and the `--format=json` render face (sha/ref/diagnostics envelope).

import { describe, expect, test } from "bun:test";

import { parseArgs } from "../../src/cli/verbspec.ts";
import { planSaveVerb, type PlanSaveDeps } from "../../src/pr-state/plan-save-verb.ts";

type Output = { log: (line: string) => void; error: (line: string) => void };

async function runPlanSaveCli(
  argv: string[],
  output: Output,
  deps: Partial<PlanSaveDeps>,
): Promise<number> {
  const rest = argv.slice(2);
  try {
    const input = parseArgs(planSaveVerb as never, rest) as Parameters<typeof planSaveVerb.run>[0];
    const out = await planSaveVerb.run(input, { ...planSaveVerb.deps!(), ...deps });
    for (const w of planSaveVerb.warnings!(out, input)) output.error(w);
    output.log(planSaveVerb.render!(out, input));
    return planSaveVerb.exitCode?.(out, input) ?? 0;
  } catch (e) {
    output.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: { log: (l) => logs.push(l), error: (l) => errors.push(l) },
  };
}

const SHA = `sha256:${"c".repeat(64)}`;
const VALID_BODY = "# Plan\n\n## Scope\n\n- Real scope.\n";

describe("prx plan save — residual arms", () => {
  test("--from-stdin and --from-file are mutually exclusive", async () => {
    const { errors, output } = captureOutput();
    let saveCalls = 0;

    const exit = await runPlanSaveCli(
      ["plan", "save", "--unit", "GH-1277", "--from-stdin", "--from-file", "/tmp/x.md"],
      output,
      {
        readStdinSync: () => Buffer.from(VALID_BODY),
        readPlanFile: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => {
          saveCalls++;
          return { sha: SHA, ref: "GH-1277:plan@draft", body_sha: SHA, envelope_sha: SHA, validated_ok: true, diagnostics: [] };
        },
      },
    );

    expect(exit).not.toBe(0);
    expect(saveCalls).toBe(0);
    expect(errors.join("\n")).toContain("mutually exclusive");
  });

  test("--format=json renders the sha/ref/validated_ok envelope", async () => {
    const { logs, output } = captureOutput();

    const exit = await runPlanSaveCli(
      ["plan", "save", "--unit", "GH-1277", "--from-stdin", "--format=json"],
      output,
      {
        readStdinSync: () => Buffer.from(VALID_BODY),
        runPlanSave: async () => ({ sha: SHA, ref: "GH-1277:plan@draft", body_sha: SHA, envelope_sha: SHA, validated_ok: true, diagnostics: [] }),
      },
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.unit).toBe("GH-1277");
    expect(parsed.slot).toBe("draft");
    expect(parsed.sha).toBe(SHA);
    expect(parsed.ref).toBe("GH-1277:plan@draft");
    expect(parsed.validated_ok).toBe(true);
    expect(parsed.size).toBe(VALID_BODY.length);
  });
});
