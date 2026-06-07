// GH-352: `prx provenance status` posture + onboarding decision.
import { describe, expect, test } from "bun:test";

import {
  provenanceStatus,
  renderProvenanceStatus,
  type ProvenanceStatusInputs,
} from "../status.ts";

const base: ProvenanceStatusInputs = {
  perActor: true,
  masterSource: "operator-file",
  trustedActors: 7,
  drift: [],
  enforced: true,
};

describe("provenanceStatus — posture", () => {
  test("operator master + trust map + enforce + per-actor + no drift ⇒ production", () => {
    expect(provenanceStatus(base).posture).toBe("production");
    expect(provenanceStatus(base).onboarding).toEqual([]);
  });

  test("config-file master counts as operator-grade", () => {
    expect(provenanceStatus({ ...base, masterSource: "config-file" }).posture).toBe("production");
  });

  test("dev master + per-actor ⇒ bootstrap (onboarding points at the operator master)", () => {
    const s = provenanceStatus({ ...base, masterSource: "dev-bootstrap", trustedActors: 0, enforced: false });
    expect(s.posture).toBe("bootstrap");
    expect(s.onboarding.join("\n")).toContain("masterFile");
    expect(s.onboarding.join("\n")).toContain("docs/provenance/signing.md");
  });

  test("a never-registered map is NOT 'drifted' (empty map ≠ stale map)", () => {
    // keymaker reports every actor missing against an empty map; that's not drift.
    const s = provenanceStatus({
      ...base,
      masterSource: "dev-bootstrap",
      trustedActors: 0,
      drift: [{ actor: "plan", reason: "missing" }, { actor: "submit", reason: "missing" }],
      enforced: false,
    });
    expect(s.posture).toBe("bootstrap");
  });

  test("a PUBLISHED map that disagrees with derived keys ⇒ drifted", () => {
    const s = provenanceStatus({ ...base, drift: [{ actor: "implement", reason: "key changed" }] });
    expect(s.posture).toBe("drifted");
    expect(s.onboarding.join("\n")).toContain("keymaker register");
  });

  test("operator master but enforcement off ⇒ unconfigured (onboarding says enable it)", () => {
    const s = provenanceStatus({ ...base, enforced: false });
    expect(s.posture).toBe("unconfigured");
    expect(s.onboarding.join("\n")).toContain("PRX_REQUIRE_SIGNED_DERIVATIONS=1");
  });

  test("single-key (not per-actor) ⇒ onboarding says enable per-actor", () => {
    const s = provenanceStatus({ ...base, perActor: false });
    expect(s.posture).toBe("unconfigured");
    expect(s.onboarding.join("\n")).toContain("PRX_PROVENANCE_KEY=dev");
  });
});

describe("renderProvenanceStatus", () => {
  test("production renders the posture line + no onboarding section", () => {
    const lines = renderProvenanceStatus(provenanceStatus(base));
    const text = lines.join("\n");
    expect(text).toContain("provenance signing: production");
    expect(text).toContain("mode:        per-actor");
    expect(text).toContain("enforcement: on (fail-closed)");
    expect(text).not.toContain("onboarding:");
  });

  test("a drifted (published) map shows the drifted count + onboarding", () => {
    const lines = renderProvenanceStatus(
      provenanceStatus({ ...base, drift: [{ actor: "implement", reason: "key changed" }] }),
    );
    const text = lines.join("\n");
    expect(text).toContain("7 actor(s) — 1 drifted");
    expect(text).toContain("onboarding:");
  });

  test("an empty map does NOT render a drifted count (never-registered ≠ stale)", () => {
    const lines = renderProvenanceStatus(
      provenanceStatus({
        ...base,
        masterSource: "dev-bootstrap",
        trustedActors: 0,
        drift: [{ actor: "plan", reason: "missing" }],
        enforced: false,
      }),
    );
    expect(lines.join("\n")).toContain("0 actor(s)");
    expect(lines.join("\n")).not.toContain("drifted");
  });
});
