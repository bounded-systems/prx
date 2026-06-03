import { describe, expect, test } from "bun:test";
import {
  PRX_SESSION_OPEN_DEFINITION,
  formatPrxSessionOpenHelpBlock,
  prxSessionBoardReadFailureMessage,
  prxSessionCannotOpenPrefix,
  prxSessionEpicRefusalMessage,
  prxSessionNotProjectedLocallyEnvelope,
  prxSessionNotProjectedLocallyMessage,
  prxSessionParityCleanupMessage,
  prxSessionUnitCompleteMessage,
} from "../../src/machine/session_open.ts";
import type { ResolvedWorkUnit, WorkUnitSource } from "../../src/pr-state/resolvers/types.ts";

describe("session_open copy (workflow machine semantics)", () => {
  test("prxSessionCannotOpenPrefix names the work unit", () => {
    expect(prxSessionCannotOpenPrefix("GH-321")).toBe("Cannot open PRX session for GH-321:");
  });

  test("board read failure copy ties errors to opening a session", () => {
    const msg = prxSessionBoardReadFailureMessage("GH-9", "rate limit");
    expect(msg).toContain("preparing to open PRX session for GH-9");
    expect(msg).toContain("rate limit");
  });

  test("formatPrxSessionOpenHelpBlock includes definition and lifecycle wording", () => {
    const lines = formatPrxSessionOpenHelpBlock();
    expect(lines.join("\n")).toContain("lifecycle machine");
    expect(lines.join("\n")).toContain(PRX_SESSION_OPEN_DEFINITION.slice(0, 40));
  });

  describe("prxSessionUnitCompleteMessage (GH-924)", () => {
    test("names the unit, lists merged + closed reasons, and points at prx prune + prx delegate next", () => {
      const msg = prxSessionUnitCompleteMessage("GH-888", {
        prMergeState: "merged",
        ghIssueClosed: true,
        worktreePath: "/Users/dev/.local/state/wt/worktrees/main/gh_888_7f9",
      });
      expect(msg).toContain("Cannot open PRX session for GH-888:");
      expect(msg).toContain("work unit is complete");
      expect(msg).toContain("PR merged");
      expect(msg).toContain("GitHub issue closed");
      expect(msg).toContain("/gh_888_7f9");
      expect(msg).toContain("prx prune --ticket GH-888");
      expect(msg).toContain("prx delegate next");
    });

    test("renders the closed-PR reason when merge_state is closed", () => {
      const msg = prxSessionUnitCompleteMessage("GH-742", {
        prMergeState: "closed",
        ghIssueClosed: true,
        worktreePath: null,
      });
      expect(msg).toContain("PR closed");
      expect(msg).not.toContain("Worktree at");
    });

    test("includes Beads-issue closure reason when applicable", () => {
      const msg = prxSessionUnitCompleteMessage("GH-101", {
        prMergeState: null,
        ghIssueClosed: false,
        beadsIssueClosed: true,
        worktreePath: "/tmp/wt",
      });
      expect(msg).toContain("Beads issue closed");
      expect(msg).toContain("Worktree at /tmp/wt");
    });
  });
});

describe("prxSessionParityCleanupMessage (GH-914)", () => {
  test("operator-only prune actions still recommend `prx chain prune`", () => {
    const msg = prxSessionParityCleanupMessage("GH-321", ["delete_local_branch", "delete_remote_branch"]);
    expect(msg).toContain("Cannot open PRX session for GH-321:");
    expect(msg).toContain("parity-chain cleanup is required first");
    expect(msg).toContain("delete_local_branch, delete_remote_branch");
    expect(msg).toContain("`prx chain prune --authority issue --scope all`");
  });

  test("foreign-authored branch suppresses the destructive remediation", () => {
    const msg = prxSessionParityCleanupMessage(
      "PROJ-5767",
      ["delete_remote_branch"],
      ["PROJ-5767"],
    );
    expect(msg).toContain("Cannot open PRX session for PROJ-5767:");
    expect(msg).not.toContain("`prx chain prune --authority issue --scope all`");
    expect(msg).toContain("authored by other operators");
    expect(msg).toContain("PROJ-5767");
    expect(msg).toContain("--branch <name>");
    expect(msg).toContain("coordinate with the branch author");
  });

  test("foreign-branch listing truncates after three with a total count", () => {
    const branches = ["FOO-1", "FOO-2", "FOO-3", "FOO-4", "FOO-5"];
    const msg = prxSessionParityCleanupMessage("FOO-1", ["delete_remote_branch"], branches);
    expect(msg).toContain("FOO-1, FOO-2, FOO-3");
    expect(msg).toContain("(5 total)");
    expect(msg).not.toContain("FOO-4");
  });
});

describe("prxSessionEpicRefusalMessage (GH-935)", () => {
  test("opens with the canonical cannot-open prefix and names the epic", () => {
    const msg = prxSessionEpicRefusalMessage("GH-899", [
      { ghNumber: 902, title: "A.2 — Warp profile", state: "open" },
    ]);
    expect(msg).toContain("Cannot open PRX session for GH-899:");
    expect(msg).toContain("GH-899 is an epic (type::epic)");
    expect(msg).toContain("Open a child instead:");
  });

  test("lists each child by GH number with state in brackets", () => {
    const msg = prxSessionEpicRefusalMessage("GH-899", [
      { ghNumber: 902, title: "Warp profile", state: "open" },
      { ghNumber: 906, title: "Codex profile", state: "closed" },
    ]);
    expect(msg).toContain("- GH-902 (Warp profile) [open]");
    expect(msg).toContain("- GH-906 (Codex profile) [closed]");
  });

  test("emits the no-children hint when beads has no parent-child edges", () => {
    const msg = prxSessionEpicRefusalMessage("GH-555", []);
    expect(msg).toContain("Cannot open PRX session for GH-555");
    expect(msg).toContain("type::epic");
    expect(msg).toContain("No children are registered in beads");
    expect(msg).toContain("bd dep add --type=parent-child");
    expect(msg).not.toContain("Open a child instead:");
  });

  test("truncates very long child titles to keep the child line scannable", () => {
    const longTitle = "x".repeat(200);
    const msg = prxSessionEpicRefusalMessage("GH-1", [
      { ghNumber: 2, title: longTitle, state: "open" },
    ]);
    expect(msg).toContain("...");
    const childLine = msg.split("\n").find((line) => line.trim().startsWith("- GH-2"));
    expect(childLine).toBeDefined();
    expect(childLine!.length).toBeLessThan(100);
  });
});

describe("prxSessionNotProjectedLocallyMessage (GH-2089)", () => {
  function resolved(source: WorkUnitSource | string): ResolvedWorkUnit {
    return {
      id: "TEST-ID",
      title: "test",
      body: null,
      state: "open",
      url: "https://example.test/TEST-ID",
      // Cast through unknown so the test can also exercise the defensive
      // branch for a (hypothetical) future source not yet shipped in the
      // accepted-flag list.
      source: source as WorkUnitSource,
    };
  }

  test("includes the canonical materialize hint when the source is accepted by the CLI", () => {
    const msg = prxSessionNotProjectedLocallyMessage("BD-AAAAAAAA", resolved("beads"));
    expect(msg).toContain("Cannot open PRX session for BD-AAAAAAAA:");
    expect(msg).toContain("beads page");
    expect(msg).toContain("`prx chain backfill --authority issue --scope all`");
    // The hint points at the canonical plan entry and drops the redundant
    // `--from` (`--create` auto-resolves the source); the retired `session
    // open` alias must not appear.
    expect(msg).toContain("prx plan agent BD-AAAAAAAA --create");
    expect(msg).toContain("prx plan session BD-AAAAAAAA --create");
    expect(msg).not.toContain("session open");
    expect(msg).not.toContain("--from=");
  });

  test("emits the materialize hint for notion-resolved units too", () => {
    const msg = prxSessionNotProjectedLocallyMessage("PROJ-1", resolved("notion"));
    expect(msg).toContain("prx plan agent PROJ-1 --create");
    expect(msg).not.toContain("--from=");
  });

  test("omits the materialize hint when the source is not in workUnitSources (defensive regression net)", () => {
    const msg = prxSessionNotProjectedLocallyMessage("X-1", resolved("future-source"));
    expect(msg).toContain("Cannot open PRX session for X-1:");
    expect(msg).toContain("`prx chain backfill --authority issue --scope all`");
    expect(msg).not.toContain("prx plan agent X-1 --create");
    expect(msg).not.toContain("prx plan session X-1 --create");
  });
});

describe("prxSessionNotProjectedLocallyEnvelope (GH-2067)", () => {
  function resolved(source: WorkUnitSource | string): ResolvedWorkUnit {
    return {
      id: "TEST-ID",
      title: "test",
      body: null,
      state: "open",
      url: "https://example.test/TEST-ID",
      source: source as WorkUnitSource,
    };
  }

  test("includes the materialize hint when the source is accepted by the CLI", () => {
    const envelope = prxSessionNotProjectedLocallyEnvelope("BD-AAAAAAAA", resolved("beads"));
    expect(envelope.code).toBe("PRX_SESSION_NOT_PROJECTED_LOCALLY");
    expect(envelope.workUnitId).toBe("BD-AAAAAAAA");
    expect(envelope.source).toBe("beads");
    expect(envelope.title).toBe("test");
    expect(envelope.url).toBe("https://example.test/TEST-ID");
    expect(envelope.message).toBe(
      prxSessionNotProjectedLocallyMessage("BD-AAAAAAAA", resolved("beads")),
    );
    expect(envelope.suggestedNextCommands).toEqual([
      "prx chain backfill --authority issue --scope all",
      "prx plan agent BD-AAAAAAAA --create",
    ]);
  });

  test("includes the canonical materialize hint for notion-resolved units too", () => {
    const envelope = prxSessionNotProjectedLocallyEnvelope("PROJ-1", resolved("notion"));
    expect(envelope.source).toBe("notion");
    expect(envelope.suggestedNextCommands).toContain(
      "prx plan agent PROJ-1 --create",
    );
  });

  test("omits the materialize hint when the source is not in workUnitSources (parity with GH-2089 text gate)", () => {
    const envelope = prxSessionNotProjectedLocallyEnvelope("X-1", resolved("future-source"));
    expect(envelope.source).toBe("future-source");
    expect(envelope.suggestedNextCommands).toEqual([
      "prx chain backfill --authority issue --scope all",
    ]);
  });
});
