import { describe, expect, test } from "bun:test";

import { PlanArtifactSchema } from "../../src/plan-store/plan-artifact.ts";
import {
  evaluateTransitionGate,
  transitionSchemaForRole,
  type TransitionGateInput,
} from "../../src/session/transition-gate.ts";
import type { PinTransitionDeps } from "../../src/session/transition-artifact.ts";

function stubDeps(): PinTransitionDeps {
  return {
    writeBlob: async () => ({ sha: `sha256:${"b".repeat(64)}` }),
    setRef: async () => {},
    casUriFor: (domain, sha) => `${domain}://${sha}`,
  };
}

const base = (over: Partial<TransitionGateInput>): TransitionGateInput => ({
  raw: "{}",
  role: "executor",
  workUnitId: "GH-1",
  deps: stubDeps(),
  ...over,
});

describe("transitionSchemaForRole (ai-home-wlw5l)", () => {
  test("the planner role (PRX_AGENT_ROLE for the plan profile) resolves to the strict PlanArtifactSchema", () => {
    expect(transitionSchemaForRole("planner")).toBe(PlanArtifactSchema);
    // The profile name `plan` is NOT the role vocabulary — it must miss.
    expect(transitionSchemaForRole("plan")).not.toBe(PlanArtifactSchema);
  });

  test("an un-schema'd role (e.g. executor) falls back to the loose object floor", () => {
    const schema = transitionSchemaForRole("executor");
    expect(schema.safeParse({ anything: 1 }).success).toBe(true);
    // ...but still rejects a non-object: the gate always enforces a JSON object.
    expect(schema.safeParse(42).success).toBe(false);
  });
});

describe("evaluateTransitionGate (ai-home-wlw5l)", () => {
  test("a valid object for an un-schema'd role is allowed and pinned", async () => {
    const d = await evaluateTransitionGate(base({ raw: '{"status":"ready"}' }));
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") {
      expect(d.handle).toBe(`executor://sha256:${"b".repeat(64)}`);
    }
  });

  test("an empty slot blocks termination with a 'no artifact' reason", async () => {
    const d = await evaluateTransitionGate(base({ raw: "   " }));
    expect(d.decision).toBe("block");
    if (d.decision === "block") {
      expect(d.reason).toContain("no transition artifact emitted");
      expect(d.reason).toContain("executor/GH-1");
    }
  });

  test("a non-object slot blocks (the loose floor still requires a JSON object)", async () => {
    const d = await evaluateTransitionGate(base({ raw: "42" }));
    expect(d.decision).toBe("block");
    if (d.decision === "block") expect(d.reason).toContain("schema_invalid");
  });

  test("a planner-role artifact failing PlanArtifactSchema blocks (strict role schema)", async () => {
    const d = await evaluateTransitionGate(base({ role: "planner", raw: '{"not":"a plan"}' }));
    expect(d.decision).toBe("block");
    if (d.decision === "block") expect(d.reason).toContain("schema_invalid");
  });
});
