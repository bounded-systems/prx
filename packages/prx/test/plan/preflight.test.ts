import { describe, expect, test } from "bun:test";

import { formatPreflightPlain, runPlanPreflight } from "../../src/plan/preflight.ts";
import type { CommandResult, CommandRunner, IdentityConfig } from "../../src/pr-state/github.ts";
import type { WorkUnitResolver } from "../../src/pr-state/resolvers/types.ts";

type RunnerHandler = (cmd: string[]) => CommandResult;

function makeRunner(handler: RunnerHandler): CommandRunner {
  return (cmd) => {
    const result = handler(cmd);
    return result;
  };
}

const PASSING_BODY = `
## Acceptance

- src/new/feature.ts (new)
- post comment on GH-9999 announcing the change
`;

function ghIssueViewResult(payload: {
  number: number;
  title?: string;
  state?: string;
  body?: string;
  labels?: string[];
}): CommandResult {
  return {
    stdout: JSON.stringify({
      number: payload.number,
      title: payload.title ?? `Issue ${payload.number}`,
      state: payload.state ?? "OPEN",
      body: payload.body ?? "",
      comments: [],
      labels: (payload.labels ?? []).map((name) => ({ name })),
    }),
    stderr: "",
    status: 0,
  };
}

describe("runPlanPreflight", () => {
  test("rejects unit ids that are not GH-<number>", async () => {
    await expect(
      runPlanPreflight(
        { unit: "ai-home-abc" },
        { runner: makeRunner(() => ({ stdout: "", stderr: "", status: 0 })) },
      ),
    ).rejects.toThrow(/GH-/);
  });

  test("axis-1: file deliverable that is already tracked produces an already-done finding", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1239,
          body: "## Acceptance\n- src/landed/already.ts\n",
        });
      }
      if (cmd[0] === "git" && cmd[1] === "ls-files" && cmd[2] === "--error-unmatch") {
        // landed file is tracked
        return { stdout: cmd[3]!, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "not handled", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1239" }, { runner });
    expect(result.status).toBe("already-done");
    expect(result.findings).toEqual([
      {
        axis: "already-done",
        shape: "file",
        target: "src/landed/already.ts",
      },
    ]);
  });

  test("axis-2: gh issue close action is refused (BLOCKED) → infeasible-action", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1239,
          body: `## Plan\n- gh issue close GH-1199 on completion\n`,
        });
      }
      return { stdout: "", stderr: "not tracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1239" }, { runner });
    expect(result.status).toBe("infeasible-action");
    expect(result.findings).toContainEqual({
      axis: "infeasible-action",
      shape: "gh-issue",
      subcommand: "close",
      reason: "blocked",
    });
  });

  test("axis-3: an OPEN blocker produces an infeasible-blocker finding", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        const issueNum = Number(cmd[3]);
        if (issueNum === 1239) {
          return ghIssueViewResult({
            number: 1239,
            body: `## Dependencies\n- Blocked by #1247\n`,
          });
        }
        if (issueNum === 1247) {
          return ghIssueViewResult({
            number: 1247,
            title: "Upstream gating ticket",
            state: "OPEN",
          });
        }
        return { stdout: "", stderr: "not found", status: 1 };
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1239" }, { runner });
    expect(result.status).toBe("infeasible-blocker");
    expect(result.findings).toContainEqual({
      axis: "infeasible-blocker",
      issue: 1247,
      title: "Upstream gating ticket",
      source: "issue-body",
    });
  });

  test("axis-3: a CLOSED blocker is dropped", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        const issueNum = Number(cmd[3]);
        if (issueNum === 1239) {
          return ghIssueViewResult({
            number: 1239,
            body: `## Dependencies\n- Blocked by #500\n`,
          });
        }
        if (issueNum === 500) {
          return ghIssueViewResult({
            number: 500,
            title: "Already shipped",
            state: "CLOSED",
          });
        }
      }
      return { stdout: "", stderr: "", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1239" }, { runner });
    expect(result.status).toBe("pass");
    expect(result.findings.filter((f) => f.axis === "infeasible-blocker")).toEqual([]);
  });

  test("unresolvable blocker reference downgrades to a warning, not a refusal", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        const n = Number(cmd[3]);
        if (n === 1239) {
          return ghIssueViewResult({
            number: 1239,
            body: `## Dependencies\n- Blocked by #99999999\n`,
          });
        }
        return { stdout: "", stderr: "not found", status: 1 };
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1239" }, { runner });
    expect(result.status).toBe("pass");
    expect(result.findings).toContainEqual({
      axis: "warning",
      message: "could not resolve blocker reference #99999999 — skipping",
    });
  });

  test("crossed-axis case: partially-done deliverables AND infeasible action collapses to mixed-failure", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1199,
          body: `## Acceptance\n- src/done/landed.ts\n- src/notyet/missing.ts\n- gh issue close GH-1199 on completion\n`,
        });
      }
      if (cmd[0] === "git" && cmd[1] === "ls-files") {
        const path = cmd[3];
        return path?.includes("done")
          ? { stdout: path, stderr: "", status: 0 }
          : { stdout: "", stderr: "untracked", status: 1 };
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1199" }, { runner });
    expect(result.status).toBe("mixed-failure");
  });

  // GH-1359: prose mentions of action shapes inside non-actions-bearing
  // sections (Repro / Expected / Actual / Environment) on a `type::bug` issue
  // must NOT emit infeasible-action findings.
  test("GH-1359: gh pr merge in ## Repro Steps of a type::bug issue does not emit infeasible-action", async () => {
    const body = [
      "## Description",
      "",
      "Direct-merge fallback for already-clean PRs.",
      "",
      "## Repro Steps",
      "",
      "1. Run `gh pr merge` and watch the over-strict gate trip.",
      "",
      "## Acceptance Criteria",
      "",
      "PR merges cleanly.",
    ].join("\n");
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1345,
          title: "fix(prx): doctor merge clean-PR fallback",
          body,
          labels: ["type::bug"],
        });
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1345" }, { runner });
    expect(result.findings.filter((f) => f.axis === "infeasible-action")).toEqual([]);
    expect(result.status).toBe("pass");
  });

  test("GH-1359: action shape in ## Acceptance Criteria of a type::bug still fires", async () => {
    const body = [
      "## Description",
      "",
      "Plan-side change.",
      "",
      "## Acceptance Criteria",
      "",
      "Run `gh issue close GH-1199` after landing.",
    ].join("\n");
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1359,
          title: "bug(prx): something broken",
          body,
          labels: ["type::bug"],
        });
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1359" }, { runner });
    expect(result.status).toBe("infeasible-action");
    expect(result.findings).toContainEqual({
      axis: "infeasible-action",
      shape: "gh-issue",
      subcommand: "close",
      reason: "blocked",
    });
  });

  test("GH-1359: type detection — title prefix fallback when label missing", async () => {
    const body = [
      "## Description",
      "",
      "thing.",
      "",
      "## Repro Steps",
      "",
      "Run `gh pr merge` to see broken behaviour.",
      "",
      "## Acceptance Criteria",
      "",
      "It works.",
    ].join("\n");
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1345,
          title: "fix(prx): doctor merge",
          body,
          labels: [],
        });
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1345" }, { runner });
    expect(result.findings.filter((f) => f.axis === "infeasible-action")).toEqual([]);
  });

  test("GH-1359: no label + no recognised title prefix falls back to legacy whole-body scan", async () => {
    // Without intake-type detection the legacy scan still fires on
    // vocab-known verbs mentioned anywhere in the body — preserves backward
    // compat for pre-schema bodies. GH-1832 narrowed the vocabulary so the
    // canary here uses `gh issue close` (BLOCKED, vocab-known) instead of
    // `gh pr merge` (now a phantom verb dropped at extraction).
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1199,
          title: "Free-form title",
          body: "## Plan\n- gh issue close GH-1199 to land\n",
          labels: [],
        });
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1199" }, { runner });
    expect(result.findings.some((f) => f.axis === "infeasible-action")).toBe(true);
  });

  // GH-1579: role-scoped axis-2. Refusals owned by another role at the
  // current state demote to an informational `action-deferred-to-other-role`
  // finding rather than refusing the plan-session entry.
  describe("GH-1579: role-scoped action feasibility", () => {
    test("axis-2 demotes `bd update` (planner-owned) to action-deferred-to-other-role; status stays pass", async () => {
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1575,
            body: "## Plan\n- bd update on GH-1575 after acceptance\n",
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1575" }, { runner });
      expect(result.status).toBe("pass");
      expect(result.counts.actionsInfeasible).toBe(0);
      expect(result.counts.actionsDeferredToOtherRole).toBe(1);
      const deferred = result.findings.find((f) => f.axis === "action-deferred-to-other-role");
      expect(deferred).toBeDefined();
      if (deferred?.axis === "action-deferred-to-other-role") {
        expect(deferred.shape).toBe("bd");
        expect(deferred.subcommand).toBe("update");
        expect(deferred.owningRoles).toEqual(["planner"]);
        expect(deferred.owningProfiles).toContain("triage");
        expect(deferred.suggestedUnblock).toBe("prx triage agent");
      }
    });

    test("axis-2 demotes `bd dep` (planner-owned dep edge writes) the same way", async () => {
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1575,
            body: "## Plan\n- bd dep parent=GH-1575 child=GH-1900\n",
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1575" }, { runner });
      expect(result.status).toBe("pass");
      expect(result.counts.actionsDeferredToOtherRole).toBe(1);
      const deferred = result.findings.find((f) => f.axis === "action-deferred-to-other-role");
      expect(deferred).toBeDefined();
      if (deferred?.axis === "action-deferred-to-other-role") {
        expect(deferred.subcommand).toBe("dep");
        expect(deferred.owningRoles).toEqual(["planner"]);
      }
    });

    test("GH-1832: phantom subcommand (`bd side`) is dropped at extraction — status=pass", async () => {
      // Pre-GH-1832 this body produced an `infeasible-action` finding for the
      // phantom `bd side` verb. Layer 1's vocabulary filter in
      // extractPlannedActions now drops the match before it ever becomes a
      // PlannedAction, so the gate does not refuse the plan.
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1575,
            body: "## Plan\n- bd side effect inspection\n",
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1575" }, { runner });
      expect(result.status).toBe("pass");
      expect(result.counts.actionsInfeasible).toBe(0);
      expect(result.findings.filter((f) => f.axis === "infeasible-action")).toEqual([]);
    });

    test("BLOCKED actions (e.g. `gh issue close`) never demote — refusal stays a hard infeasible-action", async () => {
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1575,
            body: "## Plan\n- gh issue close GH-1199 on completion\n",
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1575" }, { runner });
      expect(result.status).toBe("infeasible-action");
      expect(result.counts.actionsDeferredToOtherRole).toBe(0);
      expect(result.findings).toContainEqual({
        axis: "infeasible-action",
        shape: "gh-issue",
        subcommand: "close",
        reason: "blocked",
      });
    });

    test("currentRole=planner override on `bd update` → status=pass, no finding (planner can run it)", async () => {
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1575,
            body: "## Plan\n- bd update on GH-1575 after acceptance\n",
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight(
        { unit: "GH-1575", currentRole: "planner" },
        { runner },
      );
      expect(result.status).toBe("pass");
      expect(result.counts.actionsInfeasible).toBe(0);
      expect(result.counts.actionsDeferredToOtherRole).toBe(0);
      expect(
        result.findings.filter(
          (f) => f.axis === "action-deferred-to-other-role" || f.axis === "infeasible-action",
        ),
      ).toEqual([]);
    });

    test("crossed-axis: deferred-action + open-blocker → status=infeasible-blocker (NOT mixed-failure)", async () => {
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          const issueNum = Number(cmd[3]);
          if (issueNum === 1575) {
            return ghIssueViewResult({
              number: 1575,
              body: "## Plan\n- bd update on GH-1575\n\n## Dependencies\n- Blocked by #1247\n",
            });
          }
          if (issueNum === 1247) {
            return ghIssueViewResult({
              number: 1247,
              title: "Upstream gating ticket",
              state: "OPEN",
            });
          }
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1575" }, { runner });
      expect(result.status).toBe("infeasible-blocker");
      expect(result.counts.actionsInfeasible).toBe(0);
      expect(result.counts.actionsDeferredToOtherRole).toBe(1);
      expect(result.counts.blockersOpen).toBe(1);
    });
  });

  // GH-1832: phantom-subcommand false-positives — noun-as-verb prose ("bd
  // records", "gh issues that are closed-as-dup", "git commits") used to be
  // captured by the action regex, classified as not-allowlisted-for-role, and
  // surfaced as infeasible-action. The two-layered fix drops them at
  // extraction (Layer 1) AND demotes any phantom verb that slips past to a
  // non-fatal warning (Layer 2).
  describe("GH-1832: phantom-subcommand false-positives", () => {
    test("Layer 2: synthetic PlannedAction with unknown subcommand demotes to warning, not infeasible-action", async () => {
      // Bypass extraction by feeding checkActionFeasibility a synthetic
      // PlannedAction directly. Pins the safety-net contract independently of
      // Layer 1 — if a future caller bypasses extractPlannedActions and feeds
      // a phantom verb into the classifier, the gate still does not refuse.
      const { checkActionFeasibility } = await import("../../src/plan/preflight.ts");
      const findings = checkActionFeasibility(
        // GH-1516: PlannedAction now requires perspective. Synthetic inputs
        // from callers bypassing the extractor must supply it explicitly;
        // `unknown` is the safe default for the layer-2 safety-net test
        // because the demotion-to-perspective-mismatch branch never fires for
        // it (only `executor-later` under a non-executor role would).
        [{ shape: "bd", subcommand: "record", perspective: "unknown" }],
        { allowedTools: [], disallowedTools: [] },
        "planning",
        "executor",
      );
      const infeasible = findings.filter((f) => f.axis === "infeasible-action");
      const warnings = findings.filter((f) => f.axis === "warning");
      expect(infeasible).toEqual([]);
      expect(warnings.length).toBe(1);
      if (warnings[0]?.axis === "warning") {
        expect(warnings[0].message).toContain("bd record");
        expect(warnings[0].message).toContain("noun-as-verb");
      }
    });

    test("GH-1829-shaped body (bd records / gh issues / git commits) → status=pass, actionsInfeasible=0", async () => {
      // End-to-end repro from the issue. Pre-GH-1832 this body refused with
      // `infeasible-action [bd]: record (not-allowlisted-for-role)`.
      const body = [
        "## Description",
        "",
        "When ingest sees a row whose closed-as-dup target also has bd records,",
        "we should ignore closed-as-dup bd records and emit a single bd record",
        "per external_ref. Surfacing duplicate gh issues that are closed-as-dup",
        "leads to repeated git commits on the parity chain.",
        "",
        "## Acceptance Criteria",
        "",
        "- Skip all bd records sharing the row's external_ref.",
        "- Surface a single bd record per external_ref.",
        "- Do not reopen gh issues that are closed-as-dup.",
      ].join("\n");
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1829,
            title: "fix(triage): suppress §6 closed-as-dup beads from drift",
            body,
            labels: ["type::bug"],
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1829" }, { runner });
      expect(result.status).toBe("pass");
      expect(result.counts.actionsInfeasible).toBe(0);
      expect(result.findings.filter((f) => f.axis === "infeasible-action")).toEqual([]);
    });
  });

  // GH-1516: end-to-end pinning of the bleed-stop fix. The two witness bodies
  // below (GH-1514 / GH-1548-shaped) used to refuse with `already-done [file]`
  // / `infeasible-action [git]: remote` respectively, driving operators to
  // routine `--skip-preflight`. Post-GH-1516 both must clear with status=pass.
  describe("GH-1516: false-positive bleed-stop fixtures", () => {
    test("GH-1514-shaped: cited ADR path inside Acceptance Criteria → status=pass", async () => {
      const body = [
        "## Description",
        "",
        "The architecture document is the canonical authority.",
        "",
        "## Acceptance Criteria",
        "",
        "- Land docs/architecture/Architecture.md.",
        "- This work names bd as the canonical authority.",
        "- Cite docs/spikes/GH-1500-authority.md as the source of truth.",
      ].join("\n");
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1514,
            title: "chore: name canonical authority",
            body,
            labels: ["type::chore"],
          });
        }
        if (cmd[0] === "git" && cmd[1] === "ls-files" && cmd[2] === "--error-unmatch") {
          // The cited ADR file IS tracked — pre-GH-1516 this would refuse.
          // The new architecture doc is NOT yet tracked.
          if (cmd[3] === "docs/spikes/GH-1500-authority.md") {
            return { stdout: cmd[3]!, stderr: "", status: 0 };
          }
          return { stdout: "", stderr: "untracked", status: 1 };
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1514" }, { runner });
      expect(result.status).toBe("pass");
      // The cited ADR path must NOT surface as an already-done finding.
      const adrFindings = result.findings.filter(
        (f) =>
          f.axis === "already-done" &&
          f.shape === "file" &&
          f.target === "docs/spikes/GH-1500-authority.md",
      );
      expect(adrFindings).toEqual([]);
      // And `bd as` must NOT have surfaced as an infeasible-action.
      const bdAs = result.findings.filter(
        (f) => f.axis === "infeasible-action" && f.shape === "bd" && f.subcommand === "as",
      );
      expect(bdAs).toEqual([]);
    });

    test("GH-1548-shaped: ## Approach executor-time git verbs under planner role → status=pass with perspective-mismatch advisory", async () => {
      const body = [
        "## Description",
        "",
        "Add a helper that needs git introspection.",
        "",
        "## Approach",
        "",
        "Run `git remote get-url origin` then `git rev-parse --git-common-dir`",
        "to resolve the repo identity.",
        "",
        "## Acceptance Criteria",
        "",
        "Helper exposes `repoNameWithOwner` under src/pr-state/github.ts.",
      ].join("\n");
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          // No type::* label and a non-canonical heading set, so intake-type
          // detection drops to null and the legacy section walker picks up
          // `## Approach` directly.
          return ghIssueViewResult({
            number: 1548,
            title: "helper: repoNameWithOwner",
            body,
            labels: [],
          });
        }
        if (cmd[0] === "git" && cmd[1] === "ls-files" && cmd[2] === "--error-unmatch") {
          return { stdout: "", stderr: "untracked", status: 1 };
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      // Run under currentRole=planner — the surface where the GH-1548
      // false-positive bites. Pre-GH-1516 this refused with infeasible-action
      // [git]: remote (BLOCKED). Post-GH-1516 the perspective demotion turns
      // it into an advisory.
      const result = await runPlanPreflight(
        { unit: "GH-1548", currentRole: "planner" },
        { runner },
      );
      expect(result.status).toBe("pass");
      expect(result.counts.actionsInfeasible).toBe(0);
      expect(result.counts.actionsPerspectiveMismatched).toBeGreaterThan(0);
      const mismatched = result.findings.filter((f) => f.axis === "action-perspective-mismatch");
      expect(mismatched.length).toBeGreaterThan(0);
      const gitRemote = mismatched.find(
        (f) =>
          f.axis === "action-perspective-mismatch" &&
          f.shape === "git" &&
          f.subcommand === "remote",
      );
      expect(gitRemote).toBeDefined();
      if (gitRemote?.axis === "action-perspective-mismatch") {
        expect(gitRemote.perspective).toBe("executor-later");
        expect(gitRemote.section).toBe("Approach");
        expect(gitRemote.currentRole).toBe("planner");
      }
    });

    test("GH-1516: under executor role the same ## Approach verbs still refuse — perspective demotion is role-scoped", async () => {
      // Symmetry check: the demotion only applies under non-executor roles.
      // An executor-profile session must still refuse BLOCKED verbs even when
      // they live under `## Approach`.
      const body = [
        "## Acceptance Criteria",
        "",
        "Helper exposes `repoNameWithOwner`.",
        "",
        "## Approach",
        "",
        "Run `git remote get-url origin` to read the remote.",
      ].join("\n");
      const runner = makeRunner((cmd) => {
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
          return ghIssueViewResult({
            number: 1548,
            title: "helper: repoNameWithOwner",
            body,
            labels: [],
          });
        }
        return { stdout: "", stderr: "untracked", status: 1 };
      });
      const result = await runPlanPreflight({ unit: "GH-1548" }, { runner });
      // Default currentRole=executor → no perspective demotion → BLOCKED
      // surfaces as a hard infeasible-action.
      expect(result.status).toBe("infeasible-action");
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          axis: "infeasible-action",
          shape: "git",
          subcommand: "remote",
          reason: "blocked",
        }),
      );
    });
  });

  test("clean draft (no extracted deliverables, no blockers, no actions) returns pass", async () => {
    const runner = makeRunner((cmd) => {
      if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "view") {
        return ghIssueViewResult({
          number: 1303,
          body: PASSING_BODY,
        });
      }
      return { stdout: "", stderr: "untracked", status: 1 };
    });
    const result = await runPlanPreflight({ unit: "GH-1303" }, { runner });
    expect(result.status).toBe("pass");
    expect(result.counts.deliverablesExtracted).toBeGreaterThan(0);
  });

  // GH-1422: overlay-aware preflight for non-GH canonical ids.
  describe("non-GH canonical ids (GH-1422)", () => {
    const overlayPattern = /^(GH-\d+|PROJ-\d+)$/;

    function notionConfig(): IdentityConfig {
      return {
        sources: {
          notion: {
            name: "notion",
            kind: "notion",
            canonicalIdPattern: overlayPattern,
            source: "<test>",
            notion: {
              auth: "notion-cli",
              databaseId: null,
              idProperty: null,
              titleProperty: null,
              statusProperty: null,
              tokenOpRef: null,
            },
          },
        },
        defaultSourceName: "notion",
        isDefault: false,
      };
    }

    function ghOnlyConfig(): IdentityConfig {
      return {
        sources: {
          github: {
            name: "github",
            kind: "github",
            canonicalIdPattern: overlayPattern,
            source: "<test>",
          },
        },
        defaultSourceName: "github",
        isDefault: false,
      };
    }

    function stubResolver(body: string, title = "PROJ Task"): WorkUnitResolver {
      return {
        name: "notion",
        async fetch(canonicalId) {
          return {
            id: canonicalId,
            title,
            body,
            state: "open",
            url: null,
            source: "notion",
          };
        },
      };
    }

    test("matched non-GH id with resolver wired → fetches body, runs extraction, returns PreflightResult", async () => {
      const runner = makeRunner(() => ({ stdout: "", stderr: "untracked", status: 1 }));
      const result = await runPlanPreflight(
        { unit: "PROJ-5775" },
        {
          runner,
          loadIdentityConfig: () => notionConfig(),
          buildResolver: () => stubResolver("## Acceptance\n- src/new/notion-flow.ts (new)\n"),
        },
      );
      expect(result.unit).toBe("PROJ-5775");
      expect(result.status).toBe("pass");
      expect(result.counts.deliverablesExtracted).toBeGreaterThan(0);
    });

    test("matched non-GH id with NO resolver → throws GH-1168 hint with --source=", async () => {
      const runner = makeRunner(() => ({ stdout: "", stderr: "untracked", status: 1 }));
      await expect(
        runPlanPreflight(
          { unit: "PROJ-5775" },
          {
            runner,
            loadIdentityConfig: () => ghOnlyConfig(),
            buildResolver: () => null,
          },
        ),
      ).rejects.toThrow(/--source=/);
    });

    test("unmatched id → throws with 'must match canonical_id_pattern' and configured-sources list", async () => {
      const runner = makeRunner(() => ({ stdout: "", stderr: "untracked", status: 1 }));
      await expect(
        runPlanPreflight(
          { unit: "GARBAGE-9" },
          {
            runner,
            loadIdentityConfig: () => notionConfig(),
            buildResolver: () => null,
          },
        ),
      ).rejects.toThrow(/must match canonical_id_pattern/);
    });

    test("unmatched id error names the configured non-default sources (notion when wired)", async () => {
      const runner = makeRunner(() => ({ stdout: "", stderr: "untracked", status: 1 }));
      await expect(
        runPlanPreflight(
          { unit: "GARBAGE-9" },
          {
            runner,
            loadIdentityConfig: () => notionConfig(),
            buildResolver: () => null,
          },
        ),
      ).rejects.toThrow(/Configured sources:.*notion/);
    });
  });
});

describe("formatPreflightPlain", () => {
  test("renders the pass case with a 'safe to draft' line", () => {
    const text = formatPreflightPlain({
      unit: "GH-1303",
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
    });
    expect(text).toContain("status: pass");
    expect(text).toContain("safe to draft");
  });

  test("renders an infeasible-action finding with reason in parens", () => {
    const text = formatPreflightPlain({
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
    });
    expect(text).toContain("infeasible-action [gh-issue]: close (blocked)");
  });

  // GH-1516: render the perspective-mismatch advisory variant. Distinct line
  // shape from action-deferred-to-other-role so operators can tell at a glance
  // whether the issue is a role-mismatch vs an executor-time prose mention.
  test("renders an action-perspective-mismatch finding with section + currentRole", () => {
    const text = formatPreflightPlain({
      unit: "GH-1548",
      status: "pass",
      findings: [
        {
          axis: "action-perspective-mismatch",
          shape: "git",
          subcommand: "remote",
          perspective: "executor-later",
          section: "Approach",
          currentRole: "planner",
          detail: "blocked for planner; described as executor-later prose",
        },
      ],
      counts: {
        deliverablesExtracted: 0,
        deliverablesAlreadyDone: 0,
        actionsExtracted: 1,
        actionsInfeasible: 0,
        actionsDeferredToOtherRole: 0,
        actionsPerspectiveMismatched: 1,
        blockersExtracted: 0,
        blockersOpen: 0,
      },
    });
    expect(text).toContain("perspective-mismatched=1");
    expect(text).toContain("perspective-mismatch [git]: remote");
    expect(text).toContain("executor-later");
    expect(text).toContain("## Approach");
    expect(text).toContain("planner not refusing");
  });

  // GH-1579: render the demoted-axis variant with role + profile hint.
  test("renders an action-deferred-to-other-role finding with role/profile/unblock hint", () => {
    const text = formatPreflightPlain({
      unit: "GH-1575",
      status: "pass",
      findings: [
        {
          axis: "action-deferred-to-other-role",
          shape: "bd",
          subcommand: "update",
          owningRoles: ["planner"],
          owningProfiles: ["triage"],
          suggestedUnblock: "prx triage agent",
        },
      ],
      counts: {
        deliverablesExtracted: 0,
        deliverablesAlreadyDone: 0,
        actionsExtracted: 1,
        actionsInfeasible: 0,
        actionsDeferredToOtherRole: 1,
        actionsPerspectiveMismatched: 0,
        blockersExtracted: 0,
        blockersOpen: 0,
      },
    });
    expect(text).toContain("deferred=1");
    expect(text).toContain("deferred-to-other-role [bd]: update");
    expect(text).toContain("owned by role(s) 'planner'");
    expect(text).toContain("profile(s) 'triage'");
    expect(text).toContain("`prx triage agent`");
  });
});
