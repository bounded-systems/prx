// Non-tty smoke test pinning the parser routing for the planning entry.
//
// Background: ai-home-f2lcz documents that `prx session open` is described as
// an alias for the canonical `prx plan session`, but it routes through the
// interactive `parseSessionOpenCommand` parser rather than the print-default
// `parseSessionPlanCommand` parser. The user-facing fallout: invoking the
// alias in a non-tty context fails with "open terminal failed: not a
// terminal", while the canonical form runs to completion because its handler
// defaults to `--print --output-format text`.
//
// This test exercises only the pure-function parser layer (no env, no bd,
// no GitHub) so it is safely runnable from any non-tty environment and pins
// the current divergence so any fix is visible in the diff.
//
// Sibling references:
//   - ai-home-j64fq parity-chain materialization gap
//   - ai-home-ezswv chain-sync bd-blind destructive plan
//   - ai-home-56cgp chain-backfill silent no-op
//   - Cluster handoff: ~/.config/claude/handoffs/prx/prx-tool-cluster-2026-05-19.md

import { describe, expect, test } from "bun:test";

import { parseCommand } from "../../src/pr-state/cli.ts";

describe("plan-session vs session-open alias routing (ai-home-f2lcz)", () => {
  test("canonical `prx plan session GH-456` routes to the session-plan parser", () => {
    const parsed = parseCommand(["plan", "session", "GH-456"]);
    expect(parsed.command).toBe("session-plan");
    if (parsed.command !== "session-plan") return;
    expect(parsed.workUnitId).toBe("GH-456");
    expect(parsed.invokedViaPlanSession).toBe(true);
    expect(parsed.interactive).toBe(false);
  });

  test("`prx session plan GH-456` (GH-1982 alias) also routes to session-plan", () => {
    const parsed = parseCommand(["session", "plan", "GH-456"]);
    expect(parsed.command).toBe("session-plan");
    if (parsed.command !== "session-plan") return;
    expect(parsed.workUnitId).toBe("GH-456");
    expect(parsed.invokedViaPlanSession).toBe(true);
    expect(parsed.interactive).toBe(false);
  });

  test("`prx session open GH-456` (deprecated alias) does NOT route to session-plan", () => {
    // Characterization: this is the bug from ai-home-f2lcz. The alias is
    // documented as forwarding to the canonical, but its parser entry is
    // parseSessionOpenCommand (the tmux-interactive path), not
    // parseSessionPlanCommand. Result: callers in non-tty contexts hit
    // "open terminal failed: not a terminal" instead of the canonical's
    // default print path.
    const parsed = parseCommand(["session", "open", "GH-456"]);
    expect(parsed.command).not.toBe("session-plan");
    // Default claude path through parseSessionOpenCommand resolves to
    // "session-open-claude" (see comment near command-literal table at the
    // top of parseSessionOpenCommand for the redirect map).
    expect(parsed.command).toBe("session-open-claude");
  });

  test("`prx plan session GH-456 --create --from=beads` carries the source through to session-plan", () => {
    // GH-2089 wired beads as a first-class --from value. Pin that path here
    // so any regression of the print-default + beads-source composition is
    // caught at the parser layer (no need to spin up bd state to detect it).
    const parsed = parseCommand([
      "plan",
      "session",
      "GH-456",
      "--create",
      "--from=beads",
    ]);
    expect(parsed.command).toBe("session-plan");
    if (parsed.command !== "session-plan") return;
    expect(parsed.create).toBe(true);
    expect(parsed.from).toBe("beads");
    expect(parsed.interactive).toBe(false);
  });

  test("`prx plan session GH-456 --interactive` switches off the print default at the parser", () => {
    // Sanity-check the opt-in: the canonical exposes --interactive as the
    // way to drop the print default. Pinning this complements the alias
    // routing test above — if a future change makes the alias route to
    // session-plan, --interactive must still be the documented switch.
    const parsed = parseCommand([
      "plan",
      "session",
      "GH-456",
      "--interactive",
    ]);
    // --interactive on the canonical re-routes through parseSessionOpenCommand
    // (it owns the tmux pane), tagging invokedViaPlanSession on the result so
    // the dispatch banner still says "plan session". The default claude
    // dispatch resolves to the "session-open-claude" command literal.
    expect(parsed.command).toBe("session-open-claude");
    if (parsed.command !== "session-open-claude") return;
    expect(parsed.invokedViaPlanSession).toBe(true);
  });
});
