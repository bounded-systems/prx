/**
 * Project-scope Claude Code settings.json baseline (GH-1378 / GH-357).
 *
 * Single source of truth for the checked-in `.claude/settings.json`. The
 * builder returns the canonical object; the in-repo file is asserted to
 * match (test/init/claude_settings.test.ts) so drift between the two
 * fails the suite.
 *
 * Two surfaces, deliberately split:
 *
 *   - `buildClaudeSettings()` — the PUBLIC baseline (permissions only). This
 *     is what `prx init` scaffolds into any repo. It must stay free of the
 *     org-internal SessionStart context hook (which clones bounded-systems'
 *     private `.github-private`) — an open-source `prx init` user has no
 *     access to that source, so leaking it would scaffold a broken hook.
 *
 *   - `buildOrgHarnessSettings()` — the bounded-systems harness baseline,
 *     layering the org `env` defaults and the SessionStart context-injection
 *     hook on top of the public permissions. This drives THIS repo's own
 *     checked-in `.claude/settings.json` (drift sentinel), never the public
 *     scaffolder.
 *
 * Boundary with GH-593: this scaffolds at repo init (one-time, per-repo).
 * GH-593 stamps the file per-worktree on `wt switch`. The two surfaces do
 * not conflict — `prx init` ensures fresh repos carry the baseline from
 * the first commit; `wt switch` ensures every worktree has it at runtime.
 */

export type ClaudeHook = {
  type: "command";
  command: string;
};

export type ClaudeHookMatcher = {
  matcher: string;
  hooks: ClaudeHook[];
};

export type ClaudeSettings = {
  permissions: {
    allow: string[];
    deny: string[];
  };
  env?: Record<string, string>;
  hooks?: {
    SessionStart?: ClaudeHookMatcher[];
  };
};

export function buildClaudeSettings(): ClaudeSettings {
  return {
    permissions: {
      allow: [
        "Read(**)",
        "Grep(**)",
        "Glob(**)",
        "Bash(prx model:*)",
        "Bash(prx scout:*)",
        "Bash(prx routine:*)",
        "Bash(prx actions:*)",
        "Bash(prx contract:*)",
        "Bash(prx chain:*)",
        "Bash(prx repo:*)",
        "Bash(prx worktree:*)",
        "Bash(prx plan show:*)",
        "Bash(prx triage status:*)",
        "Bash(prx help:*)",
        "Bash(bun test:*)",
        "Bash(bun typecheck:*)",
        "Bash(gh issue view:*)",
        "Bash(gh pr view:*)",
        "Bash(gh pr checks:*)",
        "Bash(bd ready:*)",
        "Bash(bd list:*)",
        "Bash(bd show:*)",
        "Bash(bd blocked:*)",
        "Bash(bd memories:*)",
      ],
      deny: [
        "Bash(rm -rf:*)",
        "Bash(rm -fr:*)",
        "Bash(git push --force:*)",
        "Bash(git push --force-with-lease:*)",
        "Bash(git reset --hard:*)",
      ],
    },
  };
}

/**
 * The bounded-systems Claude harness baseline: the public permissions plus
 * the org `env` defaults and the SessionStart context-injection hook. Drives
 * THIS repo's checked-in `.claude/settings.json`; never the public scaffolder.
 *
 *   - env: subagent model → haiku, autocompact at 75%, telemetry switch on
 *     (inert until an OTEL endpoint is configured out-of-band).
 *   - SessionStart: ensures the per-repo beadsd is up (host-side bridge for
 *     the retired auto-start, prx-82b Slice 2e.4 — see `.claude/ensure-beads.sh`),
 *     injects the org canonical context via `.claude/inject-org-context.sh`,
 *     then emits the cloud-box identity attestation via `.claude/attest-box.sh`
 *     (see docs/prx/cloud-box-attestation.md — all three fail open).
 */
export function buildOrgHarnessSettings(): ClaudeSettings {
  return {
    ...buildClaudeSettings(),
    env: {
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    },
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "bash .claude/ensure-beads.sh" },
            { type: "command", command: "bash .claude/inject-org-context.sh" },
            { type: "command", command: "bash .claude/attest-box.sh" },
          ],
        },
      ],
    },
  };
}

export function claudeSettingsJson(): string {
  return `${JSON.stringify(buildClaudeSettings(), null, 2)}\n`;
}

export function orgHarnessSettingsJson(): string {
  return `${JSON.stringify(buildOrgHarnessSettings(), null, 2)}\n`;
}
