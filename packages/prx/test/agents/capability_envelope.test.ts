// prx-g88.7 (7b) — the capability envelope: drift + the structural invariants
// the matrix must keep (monotonic escalation, journaling, the headline effects).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_SEVERITY,
  ENVELOPE_REVERSIBILITY,
  ENVELOPE_SCOPES,
  EFFECT_ENVELOPE,
  evaluateEnvelope,
  generateEnvelopeFeature,
} from "../../src/agents/capability_envelope.ts";
import { findRepoRoot } from "../../src/repo-root.ts";
const REPO_ROOT = findRepoRoot();

const featurePath = join(REPO_ROOT, "features", "capability-envelope.feature");

describe("capability envelope (prx-g88.7 / 7b)", () => {
  test("the committed feature matches the generator (no drift)", () => {
    expect(existsSync(featurePath)).toBe(true);
    expect(
      readFileSync(featurePath, "utf8"),
      "features/capability-envelope.feature is stale — run `bun run features:render` and commit",
    ).toBe(generateEnvelopeFeature());
  });

  test("approval is monotonic — it never decreases as scope or reversibility rises", () => {
    for (let s = 0; s < ENVELOPE_SCOPES.length; s++) {
      for (let r = 0; r < ENVELOPE_REVERSIBILITY.length; r++) {
        const here =
          APPROVAL_SEVERITY[
            evaluateEnvelope(ENVELOPE_SCOPES[s]!, ENVELOPE_REVERSIBILITY[r]!).approval
          ];
        if (s > 0) {
          const up =
            APPROVAL_SEVERITY[
              evaluateEnvelope(ENVELOPE_SCOPES[s - 1]!, ENVELOPE_REVERSIBILITY[r]!).approval
            ];
          expect(here).toBeGreaterThanOrEqual(up);
        }
        if (r > 0) {
          const left =
            APPROVAL_SEVERITY[
              evaluateEnvelope(ENVELOPE_SCOPES[s]!, ENVELOPE_REVERSIBILITY[r - 1]!).approval
            ];
          expect(here).toBeGreaterThanOrEqual(left);
        }
      }
    }
  });

  test("anything irreversible, and anything external, requires explicit approval", () => {
    for (const scope of ENVELOPE_SCOPES) {
      expect(evaluateEnvelope(scope, "irreversible").approval).toBe("explicit");
    }
    for (const rev of ENVELOPE_REVERSIBILITY) {
      expect(evaluateEnvelope("external", rev).approval).toBe("explicit");
    }
  });

  test("journaled iff approval is not none", () => {
    for (const scope of ENVELOPE_SCOPES) {
      for (const rev of ENVELOPE_REVERSIBILITY) {
        const v = evaluateEnvelope(scope, rev);
        expect(v.journal).toBe(v.approval !== "none");
      }
    }
  });

  test("only the most-trivial local actions need no approval", () => {
    expect(evaluateEnvelope("local", "reversible").approval).toBe("none");
    expect(evaluateEnvelope("local", "recoverable").approval).toBe("none");
    // The moment scope or reversibility rises, approval appears.
    expect(evaluateEnvelope("repo", "recoverable").approval).not.toBe("none");
    expect(evaluateEnvelope("local", "destructive").approval).not.toBe("none");
  });

  test("headline effects land where the session showed they should", () => {
    const verdict = (effect: string) => {
      const e = EFFECT_ENVELOPE[effect]!;
      return evaluateEnvelope(e.scope, e.reversibility).approval;
    };
    expect(verdict("git commit")).toBe("none");
    expect(verdict("git push")).toBe("notify");
    expect(verdict("gh pr merge")).toBe("explicit");
    // The ambient-authority opener: an org-scope repo-settings PATCH.
    expect(verdict("gh repo settings")).toBe("explicit");
    expect(verdict("publish release")).toBe("explicit");
  });
});
