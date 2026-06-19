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

  test("prx-rgr: `prx session plan` is retired — errors with a redirect to plan session", () => {
    expect(() => parseCommand(["session", "plan", "GH-456"])).toThrow(
      /prx session plan is retired\. Use `prx plan session`/,
    );
  });

  test("prx-rgr: `prx session open` is retired — errors with a redirect to plan session", () => {
    // ai-home-f2lcz's divergence (the alias forwarded to the tmux-interactive
    // parser, not the canonical print path) is moot now: the whole `prx
    // session` surface is retired. Callers use `prx plan session` (interactive)
    // or `prx plan agent` (headless) directly.
    expect(() => parseCommand(["session", "open", "GH-456"])).toThrow(
      /prx session open is retired\. Use `prx plan session`/,
    );
  });

  test("`prx plan session GH-456 --create --from=beads` carries the source through to session-plan", () => {
    // GH-2089 wired beads as a first-class --from value. Pin that path here
    // so any regression of the print-default + beads-source composition is
    // caught at the parser layer (no need to spin up bd state to detect it).
    const parsed = parseCommand(["plan", "session", "GH-456", "--create", "--from=beads"]);
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
    const parsed = parseCommand(["plan", "session", "GH-456", "--interactive"]);
    // --interactive on the canonical re-routes through parseSessionOpenCommand
    // (it owns the tmux pane), tagging invokedViaPlanSession on the result so
    // the dispatch banner still says "plan session". The default claude
    // dispatch resolves to the "session-open-claude" command literal.
    expect(parsed.command).toBe("session-open-claude");
    if (parsed.command !== "session-open-claude") return;
    expect(parsed.invokedViaPlanSession).toBe(true);
  });
});
