// GH-2028 — persist-on-failure at the `prx plan save` write site.
//
// Coverage: the producer ALWAYS persists the body (exit 0 + sha printed); a
// shape-failing body lands with a stderr `validated_ok=false` note listing
// diagnostics; `--skip-validate` forces the slot consumable with a loud stderr
// warning; a valid body is silent. The parity guard: the save side persists a
// `validated_ok=false` slot and the consume side (`prx implement agent`)
// refuses it — refusal moved from producer-write to consumer-read.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import { validatePlanShape } from "../../src/plan-store/scope.ts";
import type { RunPlanSaveResult } from "../../src/plan-store/verbs.ts";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

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

const FAKE_SHA = "deadbeef".repeat(8);
const ENVELOPE_SHA = `sha256:${"a".repeat(64)}`;
const BODY_SHA = `sha256:${"b".repeat(64)}`;

// Build a RunPlanSaveResult from a body + the real shape verdict, mirroring the
// producer's persist-on-failure contract (skipValidate forces validated_ok).
function fakeSaveResult(
  unit: string,
  body: string,
  skipValidate: boolean,
): RunPlanSaveResult {
  const verdict = validatePlanShape(body, unit);
  return {
    sha: ENVELOPE_SHA,
    ref: `${unit}:plan@draft`,
    body_sha: BODY_SHA,
    envelope_sha: ENVELOPE_SHA,
    validated_ok: skipValidate ? true : verdict.validated_ok,
    diagnostics: verdict.diagnostics,
  };
}

describe("prx plan save — persist-on-failure (GH-2028)", () => {
  test("malformed body (no `## Scope`) persists, exits 0, notes validated_ok=false + diagnostics", async () => {
    const { logs, errors, output } = captureOutput();
    const planBody = "# Plan\n\n## Goals\n\nDo a thing.\n";
    let runPlanSaveCalled = false;

    const exit = await runCli(
      ["plan", "save", "--unit", "GH-1277", "--from-stdin"],
      output,
      {
        readStdinSync: () => Buffer.from(planBody),
        runPlanSave: async ({ unit, content, skipValidate }) => {
          runPlanSaveCalled = true;
          expect(skipValidate).toBe(false);
          expect(unit).toBe("GH-1277");
          expect(Buffer.from(content as Buffer).toString("utf8")).toBe(planBody);
          return fakeSaveResult("GH-1277", planBody, false);
        },
      },
    );

    // The write succeeded — the regression (GH-2009/GH-1473) is closed.
    expect(exit).toBe(0);
    expect(runPlanSaveCalled).toBe(true);
    // Stdout still carries the sha (plain format).
    expect(logs).toEqual([ENVELOPE_SHA]);
    const stderr = errors.join("\n");
    expect(stderr).toContain("validated_ok=false");
    expect(stderr).toContain("no-scope");
    expect(stderr).toContain("## Scope");
    expect(stderr).toContain("prx implement agent GH-1277");
  });

  test("--skip-validate forces validated_ok=true, emits stderr warning, exits 0", async () => {
    const { logs, errors, output } = captureOutput();
    const planBody = "# Plan\n\n## Goals\n\nNo Scope here.\n";
    let saved = false;

    const exit = await runCli(
      ["plan", "save", "--unit", "GH-1277", "--from-stdin", "--skip-validate"],
      output,
      {
        readStdinSync: () => Buffer.from(planBody),
        runPlanSave: async ({ skipValidate }) => {
          saved = true;
          expect(skipValidate).toBe(true);
          return fakeSaveResult("GH-1277", planBody, true);
        },
      },
    );

    expect(exit).toBe(0);
    expect(saved).toBe(true);
    expect(logs).toEqual([ENVELOPE_SHA]);
    const stderr = errors.join("\n");
    expect(stderr).toContain("warning");
    expect(stderr).toContain("--skip-validate");
    expect(stderr).toContain("will fail at consume");
    // skipValidate forced validated_ok=true ⇒ no validated_ok=false note.
    expect(stderr).not.toContain("validated_ok=false");
  });

  test("valid body (non-empty `## Scope`) exits 0 with sha printed (no warning, no note)", async () => {
    const { logs, errors, output } = captureOutput();
    const planBody = "# Plan\n\n## Scope\n\n- Real scope.\n";

    const exit = await runCli(
      ["plan", "save", "--unit", "GH-1277", "--from-stdin"],
      output,
      {
        readStdinSync: () => Buffer.from(planBody),
        runPlanSave: async ({ skipValidate }) => {
          expect(skipValidate).toBe(false);
          return fakeSaveResult("GH-1277", planBody, false);
        },
      },
    );

    expect(exit).toBe(0);
    expect(logs).toEqual([ENVELOPE_SHA]);
    const stderr = errors.join("\n");
    expect(stderr).not.toContain("--skip-validate");
    expect(stderr).not.toContain("validated_ok=false");
  });

  // GH-2028 parity guard: refusal moved to the consumer. The save side persists
  // a `validated_ok=false` slot (exit 0); the consume side refuses it (exit 2).
  // Both reference the unit and surface the missing `## Scope` predicate.
  test("save persists a validated_ok=false slot; consume refuses it", async () => {
    const planBody = "# Plan\n\n## Goals\n\nNo scope here.\n";

    // Save side: persists, exit 0, validated_ok=false note.
    const saveCapture = captureOutput();
    const saveExit = await runCli(
      ["plan", "save", "--unit", "GH-1277", "--from-stdin"],
      saveCapture.output,
      {
        readStdinSync: () => Buffer.from(planBody),
        runPlanSave: async () => fakeSaveResult("GH-1277", planBody, false),
      },
    );
    expect(saveExit).toBe(0);
    const saveNote = saveCapture.errors.find((e) => e.includes("validated_ok=false"));
    expect(saveNote).toBeDefined();

    // Consume side: same body's verdict, routed through the implement refusal.
    const consumeCapture = captureOutput();
    delete process.env.PRX_SESSION_OPEN;
    const verdict = validatePlanShape(planBody, "GH-1277");
    const consumeExit = await runCli(
      ["implement", "agent", "GH-1277"],
      consumeCapture.output,
      {
        runPlanShow: async () => ({
          unit: "GH-1277",
          slot: "draft" as const,
          sha: ENVELOPE_SHA as never,
          size: planBody.length,
          body: Buffer.from(planBody),
          validated_ok: verdict.validated_ok,
          diagnostics: verdict.diagnostics,
        }),
      },
    );
    expect(consumeExit).toBe(2);
    const consumeRefusal = consumeCapture.errors.find((e) => e.includes("refused"));
    expect(consumeRefusal).toBeDefined();
    expect(consumeRefusal).toContain("GH-1277");
    expect(consumeRefusal).toContain("validated_ok=false");
    // The diagnostic + canonical hint are surfaced.
    const consumeStderr = consumeCapture.errors.join("\n");
    expect(consumeStderr).toContain("## Scope");
    expect(consumeStderr).toContain("prx plan session GH-1277");
  });
});
