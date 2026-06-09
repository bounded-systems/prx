// GH-1238: tests for the `prx implement agent` auto-prime + refusal contract.
// The refusal cases (no draft slot, empty Scope) fire BEFORE the
// PRX_SESSION_OPEN env latch and BEFORE primePlanSession, so we don't need
// to mock the worktree/parity-chain seams — only `runPlanShow` matters.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/pr-state/cli.ts";
import { PlanRefNotFound } from "../../src/plan-store/verbs.ts";
import { validatePlanShape } from "../../src/plan-store/scope.ts";

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

describe("prx implement agent auto-prime + refusal contract (GH-1238)", () => {
  test("refuses with exit 2 when neither approved nor draft slot exists", async () => {
    const { errors, output } = captureOutput();
    delete process.env.PRX_SESSION_OPEN;

    const exit = await runCli(
      ["implement", "agent", "GH-1238"],
      output,
      {
        runPlanShow: async () => {
          throw new PlanRefNotFound("GH-1238", "approved");
        },
      },
    );

    expect(exit).toBe(2);
    const blob = errors.join("\n");
    expect(blob).toContain("refused");
    expect(blob).toContain("no plan slot for GH-1238");
    expect(blob).toContain("prx plan session GH-1238");
    // Refusal happens before the env latch is set.
    expect(process.env.PRX_SESSION_OPEN).toBeUndefined();
  });

  // GH-2028: the consumer is the trust boundary. It reads the persisted
  // envelope's `validated_ok` + `diagnostics` (no re-parse) and refuses
  // `validated_ok: false` drafts, surfacing each diagnostic.
  test("refuses with exit 2 when the draft slot's envelope is validated_ok=false (no-scope)", async () => {
    const { errors, output } = captureOutput();
    delete process.env.PRX_SESSION_OPEN;
    const planBody = "# Plan\n\n## Goals\n\nDo a thing.\n";
    const verdict = validatePlanShape(planBody, "GH-1238");

    const exit = await runCli(
      ["implement", "agent", "GH-1238"],
      output,
      {
        runPlanShow: async () => ({
          unit: "GH-1238",
          slot: "draft" as const,
          sha: "fakesha" as never,
          size: planBody.length,
          body: Buffer.from(planBody),
          validated_ok: verdict.validated_ok,
          diagnostics: verdict.diagnostics,
        }),
      },
    );

    expect(exit).toBe(2);
    const blob = errors.join("\n");
    expect(blob).toContain("refused");
    expect(blob).toContain("validated_ok=false");
    expect(blob).toContain("no-scope");
    expect(blob).toContain("## Scope");
    expect(blob).toContain("prx plan session GH-1238");
    // The persisted body is echoed so the failed draft is recoverable.
    expect(blob).toContain("## Goals");
    expect(process.env.PRX_SESSION_OPEN).toBeUndefined();
  });

  test("refuses with exit 2 when the draft envelope is validated_ok=false (empty-scope)", async () => {
    const { errors, output } = captureOutput();
    delete process.env.PRX_SESSION_OPEN;
    const planBody = "## Scope\n\n<!-- TODO: fill me in -->\n\n## Acceptance\n";
    const verdict = validatePlanShape(planBody, "GH-1238");

    const exit = await runCli(
      ["implement", "agent", "GH-1238"],
      output,
      {
        runPlanShow: async () => ({
          unit: "GH-1238",
          slot: "draft" as const,
          sha: "fakesha" as never,
          size: planBody.length,
          body: Buffer.from(planBody),
          validated_ok: verdict.validated_ok,
          diagnostics: verdict.diagnostics,
        }),
      },
    );

    expect(exit).toBe(2);
    const blob = errors.join("\n");
    expect(blob).toContain("refused");
    expect(blob).toContain("validated_ok=false");
    expect(blob).toContain("empty-scope");
    expect(process.env.PRX_SESSION_OPEN).toBeUndefined();
  });

  // Resolver simulator that mirrors src/plan-store/verbs.ts:runPlanShow:
  // - explicit slot ⇒ that slot only;
  // - undefined slot ⇒ approved → draft fallback.
  // Lets these tests fail loudly if the implementation regressed back to
  // pinning a specific slot — the stub returns the wrong body and downstream
  // refusal/proceed assertions catch it.
  function makeResolverStub(store: { approved?: string; draft?: string }) {
    return async (input: { unit: string; slot?: "approved" | "draft" | undefined }) => {
      const order = input.slot ? [input.slot] : (["approved", "draft"] as const);
      for (const slot of order) {
        const body = store[slot];
        if (body !== undefined) {
          const verdict = validatePlanShape(body, input.unit);
          return {
            unit: input.unit,
            slot,
            sha: "fakesha" as never,
            size: body.length,
            body: Buffer.from(body),
            validated_ok: verdict.validated_ok,
            diagnostics: verdict.diagnostics,
          };
        }
      }
      throw new PlanRefNotFound(input.unit, input.slot ?? "approved");
    };
  }

  test("prefers the approved slot's body over the draft slot's body when both exist", async () => {
    const { errors, output } = captureOutput();
    delete process.env.PRX_SESSION_OPEN;
    const approvedBody = "## Scope\n\n- ship the approved plan\n";
    // Draft is malformed: if the implementation regresses to pinning
    // `slot: "draft"`, the stub returns this body and the empty-Scope
    // refusal fires — the assertion on `errors` then fails loudly.
    const malformedDraftBody = "## Scope\n\n<!-- not filled in -->\n";

    await runCli(
      ["implement", "agent", "GH-1284"],
      output,
      {
        runPlanShow: makeResolverStub({
          approved: approvedBody,
          draft: malformedDraftBody,
        }),
        boardStatus: () => {
          throw new Error("expected: stop here so the test stays hermetic");
        },
      },
    );

    // Approved was preferred ⇒ no refusal. If draft had been preferred, the
    // empty-Scope refusal would have fired before boardStatus was reached.
    expect(errors.join("\n")).not.toContain("refused");
  });

  test("falls back to the draft slot when the approved slot is absent", async () => {
    const { errors, output } = captureOutput();
    delete process.env.PRX_SESSION_OPEN;
    const draftBody = "## Scope\n\n- ship the draft plan\n";

    await runCli(
      ["implement", "agent", "GH-1284"],
      output,
      {
        // Approved missing entirely. If the implementation regresses to
        // pinning `slot: "approved"`, the stub throws PlanRefNotFound and the
        // "no plan slot" refusal fires.
        runPlanShow: makeResolverStub({ draft: draftBody }),
        boardStatus: () => {
          throw new Error("expected: stop here so the test stays hermetic");
        },
      },
    );

    expect(errors.join("\n")).not.toContain("refused");
  });

  test("`--plan PATH` skips the slot lookup entirely (precedence: --plan > slot)", async () => {
    const { output } = captureOutput();
    delete process.env.PRX_SESSION_OPEN;
    let slotLookupCalled = false;

    // Skip the worktree/tmux side-effects by exiting after the slot-lookup
    // check via an unrelated downstream throw that bubbles through the
    // existing handleRunCliError path. The point of this test is to assert
    // that `runPlanShow` is NEVER consulted when --plan is provided.
    await runCli(
      ["implement", "agent", "GH-1238", "--plan", "plan.md", "--dry-run"],
      output,
      {
        runPlanShow: async () => {
          slotLookupCalled = true;
          throw new PlanRefNotFound("GH-1238", "draft");
        },
        // Force an early exit by stubbing one of the priming seams. Any
        // throw downstream of the refusal-block but inside the try wrapper
        // is fine — we only care that we got past the refusal block without
        // calling runPlanShow.
        boardStatus: () => {
          throw new Error("expected: stop here so the test stays hermetic");
        },
      },
    );

    expect(slotLookupCalled).toBe(false);
  });
});
