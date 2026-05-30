// GH-1423: PR-1 renderer skeleton — composes the substrate-driven sections
// of `claude/rules/core.md` from typed inputs.
//
// Per `docs/prx/rules-build-substrate.md` §5, PR-1 does **not** re-render
// the full `core.md` and commit the result — that content rewrite is a
// follow-up. What PR-1 ships is a renderer that:
//
//   * Projects `VerbSupply` into a generated table-of-verbs section.
//   * Embeds a `<!-- assert:alias -->` fence around the canonical drift
//     line so the alias-exists assertion has something to catch.
//   * Composes static-prose sections inside `<!-- assert:none -->` fences
//     so the verb-exists assertion does not flag illustrative tokens.
//
// The output is markdown; it mirrors `src/pr-state/help/components.ts`'s
// section-composition pattern (Identity / DomainSection) but emits markdown
// rather than ANSI-friendly aligned text.

import type {
  RulesInputs,
  VerbSupplyEntry,
} from "../schemas/inputs.ts";

const HEADING = "# Core Project Rules (generated)\n\nGenerated from typed substrate by `prx rules render`. Do not edit by hand.\n";

const STATIC_PROSE_AGENT_PATTERNS = `<!-- assert:none -->

## Agent Optimization Patterns

### Parallelization over single-session optimization

Run multiple parallel sessions (via git worktrees) rather than optimizing one session:

- Each worktree gets its own session with isolated context.
- Parallel independent sessions beat agent-pipeline orchestration on this codebase.
- Cross-contamination between tasks is eliminated by worktree boundaries.

### Collapsed SDLC — Delegate → Review → Own

Phase boundaries (Plan → Build → Test → Document) are dissolving. Use the **Delegate → Review → Own** pattern:

- **Delegate**: mechanical work to agents (boilerplate, test generation, analysis).
- **Review**: at natural breakpoints for accuracy and alignment.
- **Own**: judgment calls — strategy, architecture, what ships. Accountability stays with the operator.

<!-- /assert:none -->`;

const DRIFT_CANARY_SECTION = `## Worktree-switching shortcuts

The repo provides shell shortcuts for instant worktree switching.

<!-- assert:alias -->

Use shell aliases (\`za\`, \`zb\`, \`zc\`) for instant worktree switching.

<!-- /assert:alias -->

This section's claim is **alias-supply gated** (GH-1423/follow-up/alias-supply). Until that loader lands, the validator will report \`alias-exists\` failures for each token above.`;

function groupVerbsByActor(supply: VerbSupplyEntry[]): Map<string, VerbSupplyEntry[]> {
  const grouped = new Map<string, VerbSupplyEntry[]>();
  for (const entry of supply) {
    const bucket = grouped.get(entry.actor) ?? [];
    bucket.push(entry);
    grouped.set(entry.actor, bucket);
  }
  return grouped;
}

function renderVerbSupplySection(supply: VerbSupplyEntry[]): string {
  if (supply.length === 0) {
    return "## Verbs\n\n_(verb-supply is empty)_";
  }
  const grouped = groupVerbsByActor(supply);
  const actorNames = [...grouped.keys()].sort();
  const sections: string[] = [];
  sections.push("## Verbs\n");
  sections.push("Every backticked `prx <verb>` below is projected from `prxCommandRegistry`.\n");
  for (const actor of actorNames) {
    const rows = (grouped.get(actor) ?? []).slice().sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    sections.push(`### actor: \`${actor}\`\n`);
    for (const r of rows) {
      sections.push(`- \`prx ${r.name}\``);
    }
    sections.push("");
  }
  return sections.join("\n");
}

function renderStubBanner(inputs: RulesInputs): string {
  const stubbed: string[] = [];
  if (inputs.aliasSupply.length === 0) stubbed.push("alias-supply");
  if (inputs.worktreeGestures.length === 0) stubbed.push("worktree-gestures");
  if (inputs.memoryIndex.length === 0) stubbed.push("memory-index");
  if (stubbed.length === 0) return "";
  return `> [!NOTE]\n> Stubbed inputs (PR-1, GH-1423): ${stubbed.join(", ")}. Loaders return \`[]\` and the renderer emits a \`RULES_INPUT_STUBBED\` event per kind.\n`;
}

/**
 * Compose the spike's PR-1 rendered output. Not byte-equal to the current
 * `claude/rules/core.md` — see `docs/prx/rules-build-substrate.md` §5 for
 * the scope clip.
 */
export function renderCoreMd(inputs: RulesInputs): string {
  return [
    HEADING,
    renderStubBanner(inputs),
    renderVerbSupplySection(inputs.verbSupply),
    DRIFT_CANARY_SECTION,
    STATIC_PROSE_AGENT_PATTERNS,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}
