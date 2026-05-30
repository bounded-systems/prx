// GH-977: tests for the session-entry XState machine — alias-vs-canonical
// hint emission, profile build into context, and final-state value as the
// source of truth for `getCurrentSessionContext()`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import {
  __resetClaudeCapabilitiesForTests,
  __setClaudeSystemPromptFileSupportForTests,
} from "../../src/machine/claude_capabilities.ts";
import {
  initialSessionEntryContext,
  resetSessionEntryStderr,
  sessionEntryMachine,
  setSessionEntryStderrSink,
} from "../../src/machine/machines/session-entry.ts";
import { SESSION_PROFILES } from "../../src/machine/runtime_profiles.ts";
import { PRX_SESSION_OPEN_ALIAS_HINT } from "../../src/machine/session_open.ts";

beforeEach(() => {
  // GH-1287: pin the implement-session runtime profile to the inline
  // (fallback) prompt-delivery shape so machine-level assertions stay agnostic
  // to whether the dev box's `claude --help` advertises
  // `--append-system-prompt-file`. The primary file-write shape is exercised
  // directly in test/pr-state/runtime_profiles.test.ts via injected
  // capabilities.
  __setClaudeSystemPromptFileSupportForTests(false);
});

afterEach(() => {
  resetSessionEntryStderr();
  __resetClaudeCapabilitiesForTests();
});

function captureHints() {
  const hints: string[] = [];
  const restore = setSessionEntryStderrSink((line) => hints.push(line));
  return { hints, restore };
}

describe("sessionEntryMachine", () => {
  test("starts in idle with empty context and no emitted hint", () => {
    const actor = createActor(sessionEntryMachine).start();
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("idle");
    expect(snap.context).toEqual(initialSessionEntryContext);
  });

  test("OPEN_PLAN_SESSION (canonical) → final state plan; profile built; no hint", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-977" });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("plan");
      expect(snap.status).toBe("done");
      expect(snap.context.workUnitId).toBe("GH-977");
      expect(snap.context.profile?.command).toBe("claude");
      // canonical → no alias hint, machine flag stays false
      expect(snap.context.emittedAliasHint).toBe(false);
      expect(hints).toEqual([]);
    } finally {
      restore();
    }
  });

  test("OPEN_PLAN_SESSION via alias → emits PRX_SESSION_OPEN_ALIAS_HINT exactly once", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-1",
        viaAlias: true,
      });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("plan");
      expect(snap.context.emittedAliasHint).toBe(true);
      expect(hints).toEqual([PRX_SESSION_OPEN_ALIAS_HINT]);
    } finally {
      restore();
    }
  });

  test("OPEN_PLAN_SESSION carries hasPriorSession into the runtime profile", () => {
    const { restore } = captureHints();
    try {
      const fresh = createActor(sessionEntryMachine).start();
      fresh.send({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-2" });
      const freshArgs = fresh.getSnapshot().context.profile?.args ?? [];
      expect(freshArgs.includes("--continue")).toBe(false);

      const resumed = createActor(sessionEntryMachine).start();
      resumed.send({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-2",
        hasPriorSession: true,
      });
      const resumedArgs = resumed.getSnapshot().context.profile?.args ?? [];
      expect(resumedArgs.includes("--continue")).toBe(true);
    } finally {
      restore();
    }
  });

  test("OPEN_INTAKE_SESSION → final state intake; intake profile bound to mainx", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({ type: "OPEN_INTAKE_SESSION" });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("intake");
      expect(snap.status).toBe("done");
      const profile = snap.context.profile;
      expect(profile?.command).toBe("claude");
      expect(profile?.env?.PRX_AGENT_ROLE).toBe("intake");
      // intake never triggers the alias-hint path
      expect(snap.context.emittedAliasHint).toBe(false);
      expect(hints).toEqual([]);
    } finally {
      restore();
    }
  });

  test("OPEN_TRIAGE_SESSION → final state triage; triage profile bound to mainx", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({ type: "OPEN_TRIAGE_SESSION" });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("triage");
      expect(snap.status).toBe("done");
      const profile = snap.context.profile;
      expect(profile?.command).toBe("claude");
      expect(profile?.env?.PRX_AGENT_ROLE).toBe("triage");
      expect(snap.context.emittedAliasHint).toBe(false);
      expect(hints).toEqual([]);
    } finally {
      restore();
    }
  });

  test("OPEN_SUBMIT_SESSION (--interactive) → final state submit; submit role; work-unit-bound at the flag layer (GH-1740 + GH-1900)", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      // GH-2380: the flag-layer argv fence is the interactive profile; the
      // default is now headless SDK (covered separately below).
      actor.send({ type: "OPEN_SUBMIT_SESSION", workUnitId: "GH-1900", interaction: "interactive" });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("submit");
      expect(snap.status).toBe("done");
      expect(snap.context.workUnitId).toBe("GH-1900");
      const profile = snap.context.profile;
      expect(profile?.command).toBe("claude");
      expect(profile?.env?.PRX_AGENT_ROLE).toBe("submit");
      // GH-1900: work-unit anchor env var, mirroring PRX_PLAN_SESSION_UNIT.
      expect(profile?.env?.PRX_SUBMIT_SESSION_UNIT).toBe("GH-1900");
      // Flag-layer fence: narrow submit allowlist (no raw gh/git, no Edit/Write).
      const allowedIdx = profile!.args.indexOf("--allowedTools");
      const disallowedIdx = profile!.args.indexOf("--disallowedTools");
      expect(allowedIdx).toBeGreaterThanOrEqual(0);
      expect(disallowedIdx).toBeGreaterThanOrEqual(0);
      const allowedTools = profile!.args[allowedIdx + 1]!.split(",");
      const disallowedTools = profile!.args[disallowedIdx + 1]!.split(",");
      // Submit toolset verbs that stay in scope.
      expect(allowedTools).toContain("Bash(prx submit body-template:*)");
      expect(allowedTools).toContain("Bash(prx submit postmerge:*)");
      // GH-1530 PR-6: cross-namespace plan reads migrated to dispatch; the
      // own-namespace glob is omitted, so the dispatch verb is granted directly.
      expect(allowedTools).toContain("Bash(prx submit dispatch:*)");
      expect(allowedTools).not.toContain("Bash(prx plan dispatch --actor=submit:*)");
      // Source-edit blocked; raw gh/bd/git denied at the flag layer.
      expect(allowedTools).not.toContain("Edit");
      expect(allowedTools).not.toContain("Write");
      expect(disallowedTools).toContain("Edit");
      expect(disallowedTools).toContain("Write");
      expect(disallowedTools).toContain("Bash(gh:*)");
      // GH-1900: publish must NOT be reachable from inside the session.
      expect(disallowedTools).toContain("Bash(prx submit publish:*)");
      // GH-1900: display name now matches the work-unit id (not `mainx-submit`).
      const nameIdx = profile!.args.indexOf("--name");
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(profile!.args[nameIdx + 1]).toBe("GH-1900");
      // OPEN_SUBMIT_SESSION never triggers the alias-hint path.
      expect(snap.context.emittedAliasHint).toBe(false);
      expect(hints).toEqual([]);
    } finally {
      restore();
    }
  });

  test("OPEN_AUTHOR_SESSION (--interactive) → final state author; author role; read+gh-pr-only at the flag layer (GH-1206)", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      // GH-2380: the flag-layer argv fence is the interactive profile; the
      // default is now headless SDK (covered separately below).
      actor.send({ type: "OPEN_AUTHOR_SESSION", workUnitId: "GH-1206", interaction: "interactive" });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("author");
      expect(snap.status).toBe("done");
      expect(snap.context.workUnitId).toBe("GH-1206");
      const profile = snap.context.profile;
      expect(profile?.command).toBe("claude");
      expect(profile?.env?.PRX_AGENT_ROLE).toBe("author");
      const allowedIdx = profile!.args.indexOf("--allowedTools");
      const disallowedIdx = profile!.args.indexOf("--disallowedTools");
      expect(allowedIdx).toBeGreaterThanOrEqual(0);
      expect(disallowedIdx).toBeGreaterThanOrEqual(0);
      const allowedTools = profile!.args[allowedIdx + 1]!.split(",");
      const disallowedTools = profile!.args[disallowedIdx + 1]!.split(",");
      // ai-home-2ow2v: own namespace (covers `prx author dispatch …`); raw
      // `gh pr*` is gone — PR writes route through the forge actor.
      expect(allowedTools).toContain("Bash(prx author:*)");
      expect(allowedTools).not.toContain("Bash(gh pr create:*)");
      expect(allowedTools).not.toContain("Bash(gh pr edit:*)");
      expect(allowedTools).not.toContain("Bash(gh pr ready:*)");
      // Source-edit + push + all raw gh denied at the flag layer.
      expect(allowedTools).not.toContain("Edit");
      expect(allowedTools).not.toContain("Write");
      expect(disallowedTools).toContain("Edit");
      expect(disallowedTools).toContain("Write");
      expect(disallowedTools).toContain("Bash(git push:*)");
      expect(disallowedTools).toContain("Bash(gh:*)");
      expect(disallowedTools).toContain("Bash(prx session open --create:*)");
      // Display name is `<id>-author` so the prompt-box badge,
      // /resume picker, and terminal title all match.
      const nameIdx = profile!.args.indexOf("--name");
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(profile!.args[nameIdx + 1]).toBe("GH-1206-author");
      // No alias-hint path for author.
      expect(snap.context.emittedAliasHint).toBe(false);
      expect(hints).toEqual([]);
    } finally {
      restore();
    }
  });

  test("OPEN_SCRATCH_SESSION → final state scratch; safe by default; --unsafe flips to ambient (GH-2394)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "prx-scratch-machine-"));
    try {
      // Safe (default): permission/allowlist/strict-mcp/settings + kill-switch.
      const safeActor = createActor(sessionEntryMachine).start();
      safeActor.send({ type: "OPEN_SCRATCH_SESSION", cwd });
      const safe = safeActor.getSnapshot();
      expect(safe.value).toBe("scratch");
      expect(safe.status).toBe("done");
      // Scratch is work-unit-UNBOUND — no workUnitId on context.
      expect(safe.context.workUnitId).toBeUndefined();
      const safeProfile = safe.context.profile;
      expect(safeProfile?.command).toBe("claude");
      expect(safeProfile?.env?.PRX_AGENT_ROLE).toBe("scratch");
      expect(safeProfile?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
      const safeArgs = safeProfile!.args;
      const safeAllowed = safeArgs[safeArgs.indexOf("--allowedTools") + 1]!.split(",");
      expect(safeAllowed).toContain("Read");
      expect(safeAllowed).toContain("Bash(prx:*)");
      expect(safeAllowed).not.toContain("Edit");
      expect(safeAllowed).not.toContain("Write");
      expect(safeArgs).toContain("--strict-mcp-config");
      expect(safeArgs).toContain("--settings");

      // --unsafe: none of the safe-mode flags, no kill-switch.
      const unsafeActor = createActor(sessionEntryMachine).start();
      unsafeActor.send({ type: "OPEN_SCRATCH_SESSION", cwd, unsafe: true });
      const unsafe = unsafeActor.getSnapshot();
      expect(unsafe.value).toBe("scratch");
      const unsafeProfile = unsafe.context.profile;
      expect(unsafeProfile?.args).not.toContain("--permission-mode");
      expect(unsafeProfile?.args).not.toContain("--allowedTools");
      expect(unsafeProfile?.args).not.toContain("--strict-mcp-config");
      expect(unsafeProfile?.args).not.toContain("--settings");
      expect(unsafeProfile?.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("OPEN_IMPLEMENT_SESSION → final state implement; executor role; Edit/Write enabled at the flag layer (GH-1172)", () => {
    const { hints, restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({ type: "OPEN_IMPLEMENT_SESSION", workUnitId: "GH-1172" });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("implement");
      expect(snap.status).toBe("done");
      expect(snap.context.workUnitId).toBe("GH-1172");
      const profile = snap.context.profile;
      expect(profile?.command).toBe("claude");
      expect(profile?.env?.PRX_AGENT_ROLE).toBe("executor");
      // Edit/Write must be on the allowed list at the flag layer — that is
      // the whole point of GH-1172. Disallowed list keeps the destructive
      // subset out of reach (force-push, hard reset, recursive rm).
      const allowedIdx = profile!.args.indexOf("--allowedTools");
      const disallowedIdx = profile!.args.indexOf("--disallowedTools");
      expect(allowedIdx).toBeGreaterThanOrEqual(0);
      expect(disallowedIdx).toBeGreaterThanOrEqual(0);
      const allowedTools = profile!.args[allowedIdx + 1]!.split(",");
      const disallowedTools = profile!.args[disallowedIdx + 1]!.split(",");
      expect(allowedTools).toContain("Edit");
      expect(allowedTools).toContain("Write");
      expect(disallowedTools).toContain("Bash(git push --force:*)");
      expect(disallowedTools).toContain("Bash(rm -rf:*)");
      // GH-1238 + GH-1530 PR-6: allowlist collapsed to the executor's own
      // namespace glob (which also covers `prx implement dispatch …`); the
      // consumed-slot plan reads migrated to dispatch, not direct grants.
      expect(allowedTools).toContain("Bash(prx implement:*)");
      expect(allowedTools).not.toContain("Bash(prx plan show:*)");
      expect(allowedTools).not.toContain("Bash(prx plan close:*)");
      expect(allowedTools).not.toContain("Bash(prx model:*)");
      expect(allowedTools).not.toContain("Bash(prx scout:*)");
      expect(allowedTools).not.toContain("Bash(prx repo overview:*)");
      // GH-1238: deny-list now blocks recursive session entry, raw beads
      // writes, and `gh pr merge`.
      expect(disallowedTools).toContain("Bash(prx session open --create:*)");
      expect(disallowedTools).toContain("Bash(gh pr merge:*)");
      expect(disallowedTools).toContain("Bash(bd create:*)");
      expect(disallowedTools).toContain("Bash(bd close:*)");
      // OPEN_IMPLEMENT_SESSION never triggers the alias-hint path.
      expect(snap.context.emittedAliasHint).toBe(false);
      expect(hints).toEqual([]);
    } finally {
      restore();
    }
  });

  test("OPEN_IMPLEMENT_SESSION threads --plan PATH into the executor system prompt (GH-1172)", () => {
    const { restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({
        type: "OPEN_IMPLEMENT_SESSION",
        workUnitId: "GH-1172",
        planPath: "/tmp/plan.md",
      });
      const args = actor.getSnapshot().context.profile?.args ?? [];
      const appendIdx = args.indexOf("--append-system-prompt");
      expect(appendIdx).toBeGreaterThanOrEqual(0);
      const systemPrompt = args[appendIdx + 1]!;
      expect(systemPrompt.endsWith("Execute the plan at /tmp/plan.md.")).toBe(true);
    } finally {
      restore();
    }
  });

  test("OPEN_IMPLEMENT_SESSION threads planBody through to the executor profile (GH-1238 / GH-1287 fallback shape)", () => {
    const { restore } = captureHints();
    try {
      const planBody = "## Scope\n\n- Implement the GH-1238 thing.\n";
      const actor = createActor(sessionEntryMachine).start();
      actor.send({
        type: "OPEN_IMPLEMENT_SESSION",
        workUnitId: "GH-1238",
        planBody,
      });
      const args = actor.getSnapshot().context.profile?.args ?? [];
      // GH-1287 fallback shape (capabilities pinned to false in beforeEach):
      // the body never enters argv; the inline prompt directs the agent to
      // load the plan via dispatch (GH-1530 PR-6). Primary-file shape is
      // covered in test/pr-state/runtime_profiles.test.ts.
      const appendIdx = args.indexOf("--append-system-prompt");
      expect(appendIdx).toBeGreaterThanOrEqual(0);
      const systemPrompt = args[appendIdx + 1]!;
      expect(systemPrompt).toContain("prx implement dispatch --actor=plan -- show GH-1238");
      expect(systemPrompt).toContain("Execute exactly its § Scope");
      expect(systemPrompt).not.toContain("Implement the GH-1238 thing.");
      expect(systemPrompt).not.toContain("Execute the plan at");
    } finally {
      restore();
    }
  });

  test("OPEN_IMPLEMENT_SESSION carries hasPriorSession into the runtime profile (GH-1172)", () => {
    const { restore } = captureHints();
    try {
      const fresh = createActor(sessionEntryMachine).start();
      fresh.send({ type: "OPEN_IMPLEMENT_SESSION", workUnitId: "GH-1172" });
      const freshArgs = fresh.getSnapshot().context.profile?.args ?? [];
      expect(freshArgs.includes("--continue")).toBe(false);

      const resumed = createActor(sessionEntryMachine).start();
      resumed.send({
        type: "OPEN_IMPLEMENT_SESSION",
        workUnitId: "GH-1172",
        hasPriorSession: true,
      });
      const resumedArgs = resumed.getSnapshot().context.profile?.args ?? [];
      expect(resumedArgs.includes("--continue")).toBe(true);
    } finally {
      restore();
    }
  });

  test("plan and implement profiles produce DIFFERENT runtime-profile argv for the same work unit (GH-1172)", () => {
    const { restore } = captureHints();
    try {
      const planActor = createActor(sessionEntryMachine).start();
      planActor.send({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-1172" });
      const implementActor = createActor(sessionEntryMachine).start();
      implementActor.send({ type: "OPEN_IMPLEMENT_SESSION", workUnitId: "GH-1172" });
      const planArgs = planActor.getSnapshot().context.profile?.args ?? [];
      const implementArgs = implementActor.getSnapshot().context.profile?.args ?? [];
      // Acceptance criterion for GH-1172: prx implement must NOT collapse
      // onto the read-only plan profile. The two argv lists differ in their
      // --allowedTools content (Edit/Write only on implement) and the
      // system prompt (planner vs executor role).
      expect(planArgs).not.toEqual(implementArgs);
      const planAllowed = planArgs[planArgs.indexOf("--allowedTools") + 1] ?? "";
      const implementAllowed = implementArgs[implementArgs.indexOf("--allowedTools") + 1] ?? "";
      expect(planAllowed.split(",")).not.toContain("Edit");
      expect(implementAllowed.split(",")).toContain("Edit");
      expect(implementAllowed.split(",")).toContain("Write");
    } finally {
      restore();
    }
  });

  // GH-2014: attachMode plumbing through OPEN_PLAN_SESSION / OPEN_IMPLEMENT_SESSION
  test("OPEN_PLAN_SESSION with attachMode: background → projection carries attachMode", () => {
    const { restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-2014",
        attachMode: "background",
      });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("plan");
      expect(snap.context.profile?.attachMode).toBe("background");
    } finally {
      restore();
    }
  });

  test("OPEN_PLAN_SESSION without attachMode → projection has no attachMode field", () => {
    const { restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-2014" });
      const snap = actor.getSnapshot();
      expect(snap.context.profile?.attachMode).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("OPEN_IMPLEMENT_SESSION with attachMode: background → projection carries attachMode", () => {
    const { restore } = captureHints();
    try {
      const actor = createActor(sessionEntryMachine).start();
      actor.send({
        type: "OPEN_IMPLEMENT_SESSION",
        workUnitId: "GH-2014",
        attachMode: "background",
      });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("implement");
      expect(snap.context.profile?.attachMode).toBe("background");
    } finally {
      restore();
    }
  });

  // GH-2380: headless-first axis. The DEFAULT (absent `interaction`) builds
  // the SDK profile for the four ops actors; `interaction: "interactive"`
  // builds the legacy subprocess/tmux profile. The SDK profile carries the
  // SESSION_PROFILES allowlist/denylist verbatim into `sdkSpec`.
  const headlessCases = [
    { event: { type: "OPEN_INTAKE_SESSION" as const }, profileName: "intake" as const, role: "intake" },
    { event: { type: "OPEN_TRIAGE_SESSION" as const }, profileName: "triage" as const, role: "triage" },
    { event: { type: "OPEN_SUBMIT_SESSION" as const, workUnitId: "GH-1900" }, profileName: "submit" as const, role: "submit" },
    { event: { type: "OPEN_AUTHOR_SESSION" as const, workUnitId: "GH-1206" }, profileName: "author" as const, role: "author" },
  ];

  for (const { event, profileName, role } of headlessCases) {
    test(`${event.type} default → headless SDK profile; sdkSpec mirrors SESSION_PROFILES.${profileName}`, () => {
      const { restore } = captureHints();
      try {
        const actor = createActor(sessionEntryMachine).start();
        actor.send(event);
        const profile = actor.getSnapshot().context.profile;
        expect(profile?.command).toBe("claude");
        expect(profile?.interaction).toBe("headless");
        expect(profile?.agentRuntime).toBe("sdk");
        expect(profile?.env?.PRX_AGENT_ROLE).toBe(role);
        // sdkSpec carries the declared toolset verbatim (authority = spec).
        expect(profile?.sdkSpec?.allowedTools).toEqual(SESSION_PROFILES[profileName].allowedTools);
        expect(profile?.sdkSpec?.disallowedTools).toEqual(SESSION_PROFILES[profileName].disallowedTools);
        expect(profile?.sdkSpec?.permissionMode).toBe("plan");
      } finally {
        restore();
      }
    });

    test(`${event.type} with interaction:"interactive" → subprocess profile (no SDK axis)`, () => {
      const { restore } = captureHints();
      try {
        const actor = createActor(sessionEntryMachine).start();
        actor.send({ ...event, interaction: "interactive" });
        const profile = actor.getSnapshot().context.profile;
        expect(profile?.command).toBe("claude");
        expect(profile?.interaction).toBeUndefined();
        expect(profile?.agentRuntime).toBeUndefined();
        expect(profile?.sdkSpec).toBeUndefined();
      } finally {
        restore();
      }
    });
  }

  // GH-2380: deterministic across work-unit ids — the submit SDK profile's
  // declared toolset must not vary by id.
  test("OPEN_SUBMIT_SESSION headless sdkSpec.allowedTools is deterministic across ids", () => {
    const { restore } = captureHints();
    try {
      const a = createActor(sessionEntryMachine).start();
      a.send({ type: "OPEN_SUBMIT_SESSION", workUnitId: "GH-1" });
      const b = createActor(sessionEntryMachine).start();
      b.send({ type: "OPEN_SUBMIT_SESSION", workUnitId: "GH-2" });
      expect(a.getSnapshot().context.profile?.sdkSpec?.allowedTools).toEqual(
        b.getSnapshot().context.profile?.sdkSpec?.allowedTools,
      );
    } finally {
      restore();
    }
  });

  test("alias and canonical plan paths produce identical runtime-profile argv", () => {
    const { restore } = captureHints();
    try {
      const canonical = createActor(sessionEntryMachine).start();
      canonical.send({ type: "OPEN_PLAN_SESSION", workUnitId: "GH-9" });
      const aliased = createActor(sessionEntryMachine).start();
      aliased.send({
        type: "OPEN_PLAN_SESSION",
        workUnitId: "GH-9",
        viaAlias: true,
      });
      // The acceptance criterion: identical Claude invocation modulo the
      // stderr hint that fires only on the alias path.
      const canonicalProfile = canonical.getSnapshot().context.profile;
      const aliasedProfile = aliased.getSnapshot().context.profile;
      if (!canonicalProfile || !aliasedProfile) {
        throw new Error("expected both projections to be built");
      }
      expect(canonicalProfile.args).toEqual(aliasedProfile.args);
      expect(canonicalProfile.command).toBe(aliasedProfile.command);
    } finally {
      restore();
    }
  });
});
