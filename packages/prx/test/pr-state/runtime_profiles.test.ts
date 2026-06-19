import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ArgvOverflowError } from "../../src/machine/argv_size.ts";
import { BASE_TOOLS_BY_ROLE, SHARED_DENY } from "../../src/machine/actor_ruleset.ts";
import { defaultDispatchCapabilities } from "../../src/machine/dispatch.ts";
import { actorNames } from "../../src/machine/actor_names.ts";
import {
  buildOpsAuthorPrompt,
  buildOpsAuthorSdkRuntimeProfile,
  buildOpsImplementClaudeRuntimeProfile,
  buildOpsImplementFallbackPrompt,
  buildOpsImplementPrompt,
  buildOpsIntakeClaudeRuntimeProfile,
  buildOpsIntakeSdkRuntimeProfile,
  buildOpsMainxIntakePrompt,
  buildOpsMainxTriagePrompt,
  buildOpsPlanClaudeRuntimeProfile,
  buildOpsPlanPrompt,
  buildOpsScratchClaudeRuntimeProfile,
  buildOpsScratchPrompt,
  buildOpsSubmitPrompt,
  buildOpsSubmitSdkRuntimeProfile,
  buildOpsTriageClaudeRuntimeProfile,
  buildOpsTriageSdkRuntimeProfile,
  SCRATCH_SANDBOX_ALLOWED_DOMAINS,
  buildTaskRoleAgentId,
  buildTaskRoleClaudeRuntimeProfile,
  buildTaskRoleCodexRuntimeProfile,
  buildTaskRoleCursorRuntimeProfile,
  buildTaskRoleGeminiRuntimeProfile,
  buildTriageHaikuClassifierRuntimeProfile,
  buildWorkUnitClaudeImplementSdkRuntimeProfile,
  buildWorkUnitClaudeInteractiveRuntimeProfile,
  buildWorkUnitClaudePlanPrintRuntimeProfile,
  resolveAgentBackend,
  SESSION_PROFILES,
  sessionProfileNames,
  taskAgentRoles,
} from "../../src/machine/runtime_profiles.ts";
import { getTaskRoleContract } from "../../src/machine/contracts/instances.ts";

describe("role-aware runtime profiles", () => {
  test("planner claude profile is read-only and role-scoped", () => {
    const profile = buildTaskRoleClaudeRuntimeProfile({
      agentId: "GH-5431",
      workUnitId: "GH-5431",
      role: "planner",
      ioFormat: "json",
      mode: "full",
    });

    expect(profile.command).toBe("claude");
    expect(profile.args).toContain("--tools");
    expect(profile.args.join(" ")).toContain("Read,Bash");
    expect(profile.args.join(" ")).not.toContain("Read,Edit,Bash");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("planner");
  });

  test("executor claude profile keeps Edit and role env", () => {
    const profile = buildTaskRoleClaudeRuntimeProfile({
      workUnitId: "GH-5431",
      role: "executor",
      ioFormat: "json",
      mode: "full",
    });

    expect(profile.args.join(" ")).toContain("Read,Edit,Bash");
    expect(profile.args).toContain(buildTaskRoleAgentId("GH-5431", "executor"));
    expect(profile.env?.PRX_AGENT_ROLE).toBe("executor");
  });

  test("reviewer codex profile uses inline role prompt and role env", () => {
    const profile = buildTaskRoleCodexRuntimeProfile({
      workUnitId: "GH-5431",
      role: "reviewer",
      ioFormat: "json",
      mode: "full",
    });

    expect(profile.command).toBe("codex");
    expect(profile.args[0]).toBe("resume");
    expect(profile.args).toContain("GH-5431");
    expect(profile.args.join(" ")).toContain("reviewer agent");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("reviewer");
  });

  test("planner gemini profile uses native plan prompt and role env", () => {
    const profile = buildTaskRoleGeminiRuntimeProfile({
      workUnitId: "GH-5431",
      role: "planner",
      ioFormat: "json",
      mode: "full",
    });

    expect(profile.command).toBe("gemini");
    expect(profile.args[0]).toBe("-p");
    expect(profile.args[1]).toContain("/plan");
    expect(profile.args[1]).toContain("planner agent");
    expect(profile.args).toContain("--output-format");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("planner");
  });

  test("reviewer cursor profile uses machine-first prompt and role env", () => {
    const profile = buildTaskRoleCursorRuntimeProfile({
      workUnitId: "GH-5431",
      role: "reviewer",
      ioFormat: "stream-json",
      mode: "full",
    });

    expect(profile.command).toBe("cursor-agent");
    expect(profile.args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      expect.stringContaining("reviewer agent"),
    ]);
    expect(profile.env?.PRX_AGENT_ROLE).toBe("reviewer");
  });
});

describe("buildWorkUnitClaudeInteractiveRuntimeProfile", () => {
  test("planner first-entry profile omits --continue and bound-agent flags", () => {
    const profile = buildWorkUnitClaudeInteractiveRuntimeProfile({
      workUnitId: "GH-5431",
      role: "planner",
      hasPriorSession: false,
    });

    expect(profile.command).toBe("claude");
    expect(profile.args).toContain("--permission-mode");
    expect(profile.args).toContain("plan");
    expect(profile.args).toContain("--strict-mcp-config");
    expect(profile.args).toContain("--mcp-config");
    expect(profile.args).toContain("--append-system-prompt");
    expect(profile.args).not.toContain("--continue");
    expect(profile.args).not.toContain("--agent");
    expect(profile.args).not.toContain("--agents");
    expect(profile.args).not.toContain("--tools");
    expect(profile.args).not.toContain("--allowedTools");
    expect(profile.args).not.toContain("--output-format");
    expect(profile.args).not.toContain("--json-schema");

    const nameIdx = profile.args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(profile.args[nameIdx + 1]).toBe("GH-5431");

    const promptIdx = profile.args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = profile.args[promptIdx + 1];
    expect(prompt).toContain("GH-5431");
    expect(prompt).toContain("planner");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("planner");
  });

  test("planner resume profile appends --continue", () => {
    const profile = buildWorkUnitClaudeInteractiveRuntimeProfile({
      workUnitId: "GH-5431",
      role: "planner",
      hasPriorSession: true,
    });
    expect(profile.args).toContain("--continue");
    expect(profile.args).toContain("--permission-mode");
    expect(profile.args).toContain("plan");
    const nameIdx = profile.args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(profile.args[nameIdx + 1]).toBe("GH-5431");
  });

  test("executor profile injects the executor machine-first prompt and role env", () => {
    const profile = buildWorkUnitClaudeInteractiveRuntimeProfile({
      workUnitId: "GH-5431",
      role: "executor",
      hasPriorSession: false,
    });

    expect(profile.command).toBe("claude");
    expect(profile.args).toContain("--permission-mode");
    expect(profile.args).toContain("plan");
    expect(profile.args).not.toContain("--agent");
    expect(profile.args).not.toContain("--tools");
    expect(profile.args).not.toContain("--allowedTools");
    expect(profile.args).not.toContain("--output-format");

    const nameIdx = profile.args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(profile.args[nameIdx + 1]).toBe("GH-5431");

    const promptIdx = profile.args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = profile.args[promptIdx + 1];
    expect(prompt).toContain("GH-5431");
    expect(prompt).toContain("executor");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("executor");
  });
});

describe("buildOpsImplementPrompt planBody injection (GH-1238)", () => {
  test("planBody inlines the slot body with execute-exactly framing", () => {
    const planBody = "## Scope\n\n- Implement the GH-1238 thing.\n";
    const prompt = buildOpsImplementPrompt({
      workUnitId: "GH-1238",
      planBody,
    });
    expect(prompt).toContain("Saved plan (slot=draft):");
    expect(prompt).toContain("Implement the GH-1238 thing.");
    expect(prompt).toContain("Execute exactly this plan's § Scope.");
    expect(prompt).toContain("`prx implement agent --help`");
  });

  test("rejects passing both planPath and planBody (mutually exclusive)", () => {
    expect(() =>
      buildOpsImplementPrompt({
        workUnitId: "GH-1238",
        planPath: "/tmp/plan.md",
        planBody: "## Scope\nx",
      }),
    ).toThrow(/mutually exclusive/);
  });

  test("buildOpsImplementClaudeRuntimeProfile rejects both planPath and planBody", () => {
    expect(() =>
      buildOpsImplementClaudeRuntimeProfile({
        workUnitId: "GH-1238",
        hasPriorSession: false,
        planPath: "/tmp/plan.md",
        planBody: "## Scope\nx",
      }),
    ).toThrow(/mutually exclusive/);
  });
});

describe("buildOpsImplementClaudeRuntimeProfile prompt delivery (GH-1287)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "prx-implement-profile-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("primary path writes the full untruncated prompt to disk and passes --append-system-prompt-file", () => {
    const planBody = `## Scope\n\n${"- ship a big plan\n".repeat(4000)}`; // ≥ 64 KB
    expect(Buffer.byteLength(planBody, "utf8")).toBeGreaterThan(64 * 1024);

    const profile = buildOpsImplementClaudeRuntimeProfile({
      workUnitId: "GH-1287",
      hasPriorSession: false,
      planBody,
      capabilities: { supportsSystemPromptFile: true },
      repoRoot: tmpRoot,
    });

    expect(profile.args).toContain("--append-system-prompt-file");
    expect(profile.args).not.toContain("--append-system-prompt");

    const flagIdx = profile.args.indexOf("--append-system-prompt-file");
    const promptPath = profile.args[flagIdx + 1]!;
    expect(promptPath).toBe(join(tmpRoot, ".prx", "run", "GH-1287", "implement-prompt.txt"));
    expect(existsSync(promptPath)).toBe(true);

    const written = readFileSync(promptPath, "utf8");
    expect(written).toContain("Saved plan (slot=draft):");
    expect(written).toContain("ship a big plan");
    // Full body, no truncation marker.
    expect(written).not.toContain("[truncated]");
    expect(written).not.toContain("…[truncated]");
    expect(Buffer.byteLength(written, "utf8")).toBeGreaterThan(64 * 1024);

    expect(
      profile.notes?.some(
        (n) => n.includes("--append-system-prompt-file") && n.includes("primary path"),
      ),
    ).toBe(true);
  });

  test("fallback path passes a short inline directive that points at `prx plan show`", () => {
    const planBody = `## Scope\n\n${"- ship a big plan\n".repeat(4000)}`;

    const profile = buildOpsImplementClaudeRuntimeProfile({
      workUnitId: "GH-1287",
      hasPriorSession: false,
      planBody,
      capabilities: { supportsSystemPromptFile: false },
      repoRoot: tmpRoot,
    });

    expect(profile.args).toContain("--append-system-prompt");
    expect(profile.args).not.toContain("--append-system-prompt-file");

    const idx = profile.args.indexOf("--append-system-prompt");
    const inline = profile.args[idx + 1]!;
    expect(inline).toContain("prx implement dispatch --actor=plan -- show GH-1287");
    expect(inline).toContain("Execute exactly its § Scope");
    // The plan body itself does not enter argv on the fallback path.
    expect(inline).not.toContain("ship a big plan");
    expect(inline).not.toContain("Saved plan (slot=draft):");

    // No prompt file is written on the fallback path.
    expect(existsSync(join(tmpRoot, ".prx", "run", "GH-1287", "implement-prompt.txt"))).toBe(false);

    expect(
      profile.notes?.some(
        (n) =>
          n.includes("fallback path") &&
          n.includes("prx implement dispatch --actor=plan -- show GH-1287"),
      ),
    ).toBe(true);
  });

  test("no planBody and no planPath keeps the inline shape (no file write)", () => {
    const profile = buildOpsImplementClaudeRuntimeProfile({
      workUnitId: "GH-1287",
      hasPriorSession: false,
      capabilities: { supportsSystemPromptFile: true },
      repoRoot: tmpRoot,
    });

    expect(profile.args).toContain("--append-system-prompt");
    expect(profile.args).not.toContain("--append-system-prompt-file");
    expect(existsSync(join(tmpRoot, ".prx", "run", "GH-1287", "implement-prompt.txt"))).toBe(false);
  });

  test("argv-size pre-check throws ArgvOverflowError naming the offender for an oversized inline prompt", () => {
    // Oversized planBody on the fallback path would still be safe (the body
    // never enters argv). Synthesize the regression by forcing the fallback
    // path with a planBody and then triggering the inline-prompt path with a
    // direct planPath whose value is huge.
    const huge = "x".repeat(200 * 1024);
    expect(() =>
      buildOpsImplementClaudeRuntimeProfile({
        workUnitId: "GH-1287",
        hasPriorSession: false,
        planPath: huge,
        capabilities: { supportsSystemPromptFile: true },
        repoRoot: tmpRoot,
      }),
    ).toThrow(ArgvOverflowError);
  });
});

describe("buildOpsImplementFallbackPrompt (GH-1287)", () => {
  test("fallback prompt directs the agent to load the plan via dispatch", () => {
    const prompt = buildOpsImplementFallbackPrompt("GH-1287");
    expect(prompt).toContain("prx implement dispatch --actor=plan -- show GH-1287");
    expect(prompt).toContain("Execute exactly its § Scope");
    // The fallback prompt is bounded — it does not embed any plan body.
    expect(prompt).not.toContain("Saved plan (slot=draft):");
    // Stays short relative to the inline body shape so argv is safe regardless
    // of plan size.
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(8 * 1024);
  });
});

describe("buildOpsPlanClaudeRuntimeProfile planPath injection (GH-1044)", () => {
  test("planPath suffixes 'Execute the plan at <path>.' onto the system prompt", () => {
    const profile = buildOpsPlanClaudeRuntimeProfile({
      workUnitId: "GH-1044",
      hasPriorSession: false,
      planPath: "/tmp/plan.md",
    });

    const promptIdx = profile.args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = profile.args[promptIdx + 1]!;
    expect(prompt.endsWith("Execute the plan at /tmp/plan.md.")).toBe(true);
    expect(prompt).toContain("GH-1044");
    expect(prompt).toContain("planner");
  });

  test("omitting planPath leaves the system prompt unchanged (no-regression)", () => {
    const profile = buildOpsPlanClaudeRuntimeProfile({
      workUnitId: "GH-1044",
      hasPriorSession: false,
    });

    const promptIdx = profile.args.indexOf("--append-system-prompt");
    const prompt = profile.args[promptIdx + 1];
    expect(prompt).not.toContain("Execute the plan at");
  });

  test("env exports PRX_PLAN_SESSION_UNIT for plan toolset verbs (GH-1311)", () => {
    const profile = buildOpsPlanClaudeRuntimeProfile({
      workUnitId: "GH-1311",
      hasPriorSession: false,
    });
    expect(profile.env?.PRX_PLAN_SESSION_UNIT).toBe("GH-1311");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("planner");
    expect(profile.notes?.some((n) => n.includes("PRX_PLAN_SESSION_UNIT"))).toBe(true);
  });
});

describe("buildOpsPlanClaudeRuntimeProfile staging-dir Write carve-out (GH-1175)", () => {
  const ENV_KEYS = ["XDG_CACHE_HOME", "HOME"] as const;
  let snap: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  // Manual save/restore — keep the plan-profile builder reading real env so
  // we can pin the resolved staging dir to a known prefix per test.
  function save(): void {
    snap = {};
    for (const k of ENV_KEYS) {
      snap[k] = process.env[k];
    }
  }
  function restore(): void {
    for (const k of ENV_KEYS) {
      const v = snap[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  test("injects Write(<staging>/**) resolved from XDG_CACHE_HOME into --allowedTools", () => {
    save();
    try {
      process.env.XDG_CACHE_HOME = "/tmp/x";
      const profile = buildOpsPlanClaudeRuntimeProfile({
        workUnitId: "GH-1175",
        hasPriorSession: false,
      });
      const allowIdx = profile.args.indexOf("--allowedTools");
      expect(allowIdx).toBeGreaterThanOrEqual(0);
      const allowed = profile.args[allowIdx + 1]!;
      expect(allowed).toContain("Write(/tmp/x/prx/plans/staging/**)");
      // Bare Write must NOT be in --allowedTools — only the path-scoped form.
      const allowedEntries = allowed.split(",");
      expect(allowedEntries).not.toContain("Write");
    } finally {
      restore();
    }
  });

  test("falls back to HOME/.cache when XDG_CACHE_HOME is unset", () => {
    save();
    try {
      delete process.env.XDG_CACHE_HOME;
      process.env.HOME = "/home/op";
      const profile = buildOpsPlanClaudeRuntimeProfile({
        workUnitId: "GH-1175",
        hasPriorSession: false,
      });
      const allowIdx = profile.args.indexOf("--allowedTools");
      const allowed = profile.args[allowIdx + 1]!;
      expect(allowed).toContain("Write(/home/op/.cache/prx/plans/staging/**)");
    } finally {
      restore();
    }
  });

  test("bare Write is not in --disallowedTools (would override the path-scoped allow)", () => {
    save();
    try {
      process.env.XDG_CACHE_HOME = "/tmp/x";
      const profile = buildOpsPlanClaudeRuntimeProfile({
        workUnitId: "GH-1175",
        hasPriorSession: false,
      });
      const denyIdx = profile.args.indexOf("--disallowedTools");
      expect(denyIdx).toBeGreaterThanOrEqual(0);
      const denied = profile.args[denyIdx + 1]!.split(",");
      expect(denied).not.toContain("Write");
      // Edit stays denied — planner never edits in place.
      expect(denied).toContain("Edit");
    } finally {
      restore();
    }
  });

  test("documents the staging carve-out in profile.notes", () => {
    save();
    try {
      process.env.XDG_CACHE_HOME = "/tmp/x";
      const profile = buildOpsPlanClaudeRuntimeProfile({
        workUnitId: "GH-1175",
        hasPriorSession: false,
      });
      const notes = profile.notes ?? [];
      expect(
        notes.some(
          (n) =>
            n.includes("Staging carve-out") && n.includes("Write(/tmp/x/prx/plans/staging/**)"),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  test("degrades gracefully when neither XDG_CACHE_HOME nor HOME is set", () => {
    save();
    try {
      delete process.env.XDG_CACHE_HOME;
      delete process.env.HOME;
      const profile = buildOpsPlanClaudeRuntimeProfile({
        workUnitId: "GH-1175",
        hasPriorSession: false,
      });
      // Profile still launches; allowed tools omits the staging entry.
      const allowIdx = profile.args.indexOf("--allowedTools");
      expect(allowIdx).toBeGreaterThanOrEqual(0);
      const allowed = profile.args[allowIdx + 1]!;
      expect(allowed).not.toContain("Write(");
      // The skip is announced in notes so --dry-run shows it.
      const notes = profile.notes ?? [];
      expect(notes.some((n) => n.includes("Staging carve-out: skipped"))).toBe(true);
    } finally {
      restore();
    }
  });

  test("propagates INVALID_STAGING_ROOT (does not silently swallow)", () => {
    save();
    try {
      process.env.XDG_CACHE_HOME = "/tmp/foo,bar";
      expect(() =>
        buildOpsPlanClaudeRuntimeProfile({
          workUnitId: "GH-1175",
          hasPriorSession: false,
        }),
      ).toThrow(/XDG_CACHE_HOME contains a character forbidden/);
    } finally {
      restore();
    }
  });
});

describe("ops triage runtime profile (GH-893)", () => {
  test("triage prompt encodes the four operator rules", () => {
    const prompt = buildOpsMainxTriagePrompt();
    expect(prompt).toContain("triage operator on mainx");
    expect(prompt).toContain("not an execution surface");
    // GH-1244 + GH-1530 PR-6: queue hydration routes through scout via dispatch
    // (scout is foreign to triage; the migration replaced the direct verb).
    expect(prompt).toContain("prx triage dispatch --actor=scout -- issues");
    expect(prompt).not.toContain("prx triage status --format json");
    expect(prompt).toContain("Search before file");
    // GH-1366 + GH-1530 PR-6: dedupe step routes through intake via dispatch
    // (intake is foreign to triage), not raw `gh issue list --search`.
    expect(prompt).toContain("prx triage dispatch --actor=intake -- search");
    expect(prompt).not.toContain("gh issue list");
    expect(prompt).toContain("intake log");
    expect(prompt).toContain("execution queue");
    expect(prompt).toContain("does not cross into execution");
    expect(prompt).toContain("bd show <id>");
    expect(prompt).not.toContain("2+ issues");
    // GH-950: allowlist is now sourced from SESSION_PROFILES.triage and
    // injected into the prompt as "Allowed tools" / "Disallowed tools".
    expect(prompt).toContain("Allowed tools:");
    expect(prompt).toContain("Disallowed tools:");
    // GH-1530: classify/apply collapsed onto the registry-derived own-namespace
    // glob `Bash(prx triage:*)` (so any new `prx triage <verb>` is in-surface).
    expect(prompt).toContain("Bash(prx triage:*)");
    // GH-1530 PR-6: the cross-namespace intake search migrated to dispatch, so
    // it is no longer a direct `Bash(prx intake search:*)` grant on the allowlist.
    expect(prompt).not.toContain("Bash(prx intake search:*)");
  });

  test("triage claude profile is plan-mode, work-unit-unbound, badged mainx-triage", () => {
    const profile = buildOpsTriageClaudeRuntimeProfile();

    expect(profile.command).toBe("claude");
    expect(profile.profile).toBe("user");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("triage");

    const args = profile.args;
    const nameIdx = args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(args[nameIdx + 1]).toBe("mainx-triage");

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");

    const promptIdx = args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = args[promptIdx + 1];
    expect(prompt).toContain("triage operator on mainx");

    // No GH-N binding, no resume.
    expect(args).not.toContain("--continue");
    expect(args.join(" ")).not.toMatch(/GH-\d+/);

    expect(profile.allowedActors).toEqual(["gh", "beads", "prx"]);
    expect(profile.disallowedActors).toContain("git");
    expect(profile.disallowedActors).toContain("wt");
  });
});

describe("session profiles config (GH-950)", () => {
  test("SESSION_PROFILES exposes plan, intake, triage, implement, submit, author, scratch as machine-readable config", () => {
    expect(sessionProfileNames).toEqual([
      "plan",
      "intake",
      "triage",
      "implement",
      "submit",
      "author",
      "scratch",
    ]);
    for (const name of sessionProfileNames) {
      const profile = SESSION_PROFILES[name];
      expect(profile.name).toBe(name);
      expect(typeof profile.banner).toBe("string");
      expect(profile.banner.length).toBeGreaterThan(0);
      expect(Array.isArray(profile.allowedTools)).toBe(true);
      expect(Array.isArray(profile.disallowedTools)).toBe(true);
      expect(Array.isArray(profile.allowedActors)).toBe(true);
      expect(Array.isArray(profile.disallowedActors)).toBe(true);
    }
  });

  // GH-1530 (object-capability redesign): the six profiles' allow/deny are
  // registry-derived via `actorRuleset(...)` rather than hand-listed arrays.
  // These lints prove the derivation without re-listing each profile's exact
  // transitional `extraAllow` (that would just duplicate the source): every
  // profile carries the shared raw-CLI deny, the role base toolset, and its own
  // `Bash(prx <actor>:*)` namespace glob (submit excepted — it scopes within
  // its own namespace so `publish` stays unreachable).
  // Scoped to the six profiles GH-1530 rebuilt from `actorRuleset`. GH-2394's
  // `scratch` is a separately-authored least-privilege profile (not part of
  // this work unit), so it is excluded from these helper-derivation lints.
  const PROFILE_ROLE = {
    plan: "reader",
    intake: "reader",
    triage: "reader",
    implement: "executor",
    submit: "reader",
    author: "reader",
  } as const satisfies Record<string, "reader" | "executor">;
  const GH1530_PROFILES = Object.keys(PROFILE_ROLE) as Array<keyof typeof PROFILE_ROLE>;

  test("every profile's disallowedTools is a superset of SHARED_DENY (AC1/AC3)", () => {
    for (const name of GH1530_PROFILES) {
      const deny = SESSION_PROFILES[name].disallowedTools;
      for (const shared of SHARED_DENY) {
        expect(deny, `profile '${name}' must inherit shared deny '${shared}'`).toContain(shared);
      }
      // AC1: raw gh/bd/git are denied for every actor's session.
      expect(deny).toContain("Bash(gh:*)");
      expect(deny).toContain("Bash(bd:*)");
      expect(deny).toContain("Bash(git:*)");
    }
  });

  test("every profile's allowedTools starts with its role base toolset (AC3)", () => {
    for (const name of GH1530_PROFILES) {
      const allow = SESSION_PROFILES[name].allowedTools;
      for (const base of BASE_TOOLS_BY_ROLE[PROFILE_ROLE[name]]) {
        expect(allow, `profile '${name}' must include role base tool '${base}'`).toContain(base);
      }
    }
  });

  test("each profile exposes its own `Bash(prx <actor>:*)` namespace glob; submit scopes within its namespace (AC1/AC4)", () => {
    // AC4: the own-namespace glob makes any new `prx <actor> <verb>` runnable
    // with zero `runtime_profiles.ts` edits.
    for (const name of ["plan", "intake", "triage", "implement", "author"] as const) {
      expect(SESSION_PROFILES[name].allowedTools).toContain(`Bash(prx ${name}:*)`);
    }
    // submit deliberately omits the broad glob so `prx submit publish` is not
    // re-admitted; it keeps verb-specific own-namespace grants instead.
    expect(SESSION_PROFILES.submit.allowedTools).not.toContain("Bash(prx submit:*)");
    expect(SESSION_PROFILES.submit.allowedTools).toContain("Bash(prx submit stage:*)");
  });

  test("plan profile is work-unit-bound; intake and triage are mainx-bound; implement, author, and submit are work-unit-bound (GH-1900)", () => {
    expect(SESSION_PROFILES.plan.binding).toBe("work-unit");
    expect(SESSION_PROFILES.intake.binding).toBe("mainx");
    expect(SESSION_PROFILES.triage.binding).toBe("mainx");
    expect(SESSION_PROFILES.implement.binding).toBe("work-unit");
    expect(SESSION_PROFILES.submit.binding).toBe("work-unit");
    expect(SESSION_PROFILES.author.binding).toBe("work-unit");
  });

  test("author allowlist is own-namespace + forge-dispatch — no raw gh, no Edit/Write, no `git push` (GH-1206 / ai-home-2ow2v)", () => {
    const author = SESSION_PROFILES.author;
    // Read/Grep/Glob built-ins + own actor surface (covers `prx author dispatch …`).
    expect(author.allowedTools).toContain("Read");
    expect(author.allowedTools).toContain("Grep");
    expect(author.allowedTools).toContain("Glob");
    expect(author.allowedTools).toContain("Bash(prx author:*)");
    expect(author.allowedTools).toContain("TodoWrite");
    // ai-home-2ow2v: the raw `gh pr {create,edit,ready,view,comment}` working
    // set is GONE — PR writes go through the forge actor via dispatch.
    expect(author.allowedTools).not.toContain("Bash(gh pr create:*)");
    expect(author.allowedTools).not.toContain("Bash(gh pr edit:*)");
    expect(author.allowedTools).not.toContain("Bash(gh pr ready:*)");
    expect(author.allowedTools).not.toContain("Bash(gh pr view:*)");
    expect(author.allowedTools).not.toContain("Bash(gh pr comment:*)");
    // git is a SURFACE, not an ambient grant: `prx tools git` is NOT granted —
    // git reads route through dispatch / body-template / Read-Grep-Glob.
    expect(author.allowedTools).not.toContain("Bash(prx tools git:*)");
    expect(author.allowedTools).not.toContain("Bash(prx tools bd:*)");
    expect(author.allowedTools).not.toContain("Bash(prx tools wt:*)");
    // Edit/Write on source must NOT be on the allowlist.
    expect(author.allowedTools).not.toContain("Edit");
    expect(author.allowedTools).not.toContain("Write");
    // Capability boundary: Edit/Write and ALL raw gh/git/bd denied at the flag
    // layer (the blanket `Bash(gh:*)` deny subsumes `gh pr merge`).
    expect(author.disallowedTools).toContain("Edit");
    expect(author.disallowedTools).toContain("Write");
    expect(author.disallowedTools).toContain("Bash(gh:*)");
    expect(author.disallowedTools).toContain("Bash(git:*)");
    expect(author.disallowedTools).toContain("Bash(bd:*)");
    expect(author.disallowedTools).toContain("Bash(git push:*)");
    expect(author.disallowedTools).toContain("Bash(prx plan agent --create:*)");
    // Actor boundary: prx only — git/gh/wt/beads are all denied (cross-surface
    // work routes through dispatch to the owning actor, not the session).
    expect(author.allowedActors).toEqual(["prx"]);
    expect(author.disallowedActors).toContain("git");
    expect(author.disallowedActors).toContain("gh");
    expect(author.disallowedActors).toContain("wt");
    expect(author.disallowedActors).toContain("beads");
    // Dispatch capability (advisory): scout (body composition) + the forge
    // (publisher) for PR writes + repo for PR-thread reads.
    expect(author.allowedDispatchTargets).toEqual(["scout", "publisher", "repo"]);
  });

  test("submit allowlist is narrow + artifact-staging shape — own actor namespace only (GH-1740 + GH-1900)", () => {
    const submit = SESSION_PROFILES.submit;
    // Read/Search built-ins.
    expect(submit.allowedTools).toContain("Read");
    expect(submit.allowedTools).toContain("Grep");
    expect(submit.allowedTools).toContain("Glob");
    // GH-1900: submit toolset verbs (body-template + postmerge); the broad
    // `prx submit:*` glob is replaced with verb-specific scopes so `publish`
    // is NOT reachable from inside the session.
    expect(submit.allowedTools).toContain("Bash(prx submit body-template:*)");
    expect(submit.allowedTools).toContain("Bash(prx submit postmerge:*)");
    expect(submit.allowedTools).not.toContain("Bash(prx submit:*)");
    // GH-1530 PR-6: the cross-namespace plan reads (show/load) migrated to
    // `prx submit dispatch --actor=plan -- …`. Because the own-namespace glob
    // is omitted, the dispatch verb is granted explicitly (own head `submit`).
    expect(submit.allowedTools).toContain("Bash(prx submit dispatch:*)");
    expect(submit.allowedTools).not.toContain("Bash(prx plan dispatch --actor=submit:*)");
    expect(submit.allowedTools).not.toContain("Bash(prx plan show:*)");
    expect(submit.allowedTools).not.toContain("Bash(prx plan load:*)");
    // Raw gh/bd/git surface must NOT be on the allowlist.
    expect(submit.allowedTools).not.toContain("Bash(gh issue create:*)");
    expect(submit.allowedTools).not.toContain("Bash(gh pr edit:*)");
    expect(submit.allowedTools).not.toContain("Bash(bd update:*)");
    expect(submit.allowedTools).not.toContain("Bash(prx intake:*)");
    // Capability boundary: Edit/Write blocked + raw gh/bd/git denied at the
    // flag layer so accidental raw-tool use fails as a permission denial.
    expect(submit.disallowedTools).toContain("Edit");
    expect(submit.disallowedTools).toContain("Write");
    expect(submit.disallowedTools).toContain("Bash(gh:*)");
    expect(submit.disallowedTools).toContain("Bash(bd:*)");
    expect(submit.disallowedTools).toContain("Bash(git:*)");
    expect(submit.disallowedTools).toContain("Bash(prx plan agent --create:*)");
    // GH-1900: publish runs outside the session — must NOT be reachable.
    expect(submit.disallowedTools).toContain("Bash(prx submit publish:*)");
    // Actor boundary matches the intake shape: gh/beads/prx allowed; no git/wt.
    expect(submit.allowedActors).toEqual(["gh", "beads", "prx"]);
    expect(submit.disallowedActors).toContain("git");
    expect(submit.disallowedActors).toContain("wt");
    // Dispatch capability: scout-only (parity with intake/triage).
    expect(submit.allowedDispatchTargets).toEqual(["scout"]);
  });

  test("gc is a role spec (taskAgentRoles + uow→gc_report contract), NOT a SESSION_PROFILES entry (GH-2326)", () => {
    // Operator steer 2026-05-27: gc rides the smaller-blast-radius role path,
    // not the ambient session-profile toolset. The destructive authority
    // boundary is the GC_DELETE_CAPABILITY token + mark→sweep contract in
    // src/machine/gc/capability.ts, surfaced via capability-gated CLI verbs.
    expect(taskAgentRoles as readonly string[]).toContain("gc");
    // GH-1822 disjointness invariant: a role lives in exactly one list.
    expect(sessionProfileNames as readonly string[]).not.toContain("gc");
    expect(SESSION_PROFILES as Record<string, unknown>).not.toHaveProperty("gc");
    // 1→1 contract: uow → gc_report.
    const contract = getTaskRoleContract("gc");
    expect(contract.role).toBe("gc");
    expect(contract.inputArtifact).toBe("uow");
    expect(contract.outputArtifact).toBe("gc_report");
    // gc is a peer dispatch actor (prune-absorb) with no cross-actor reach.
    expect([...defaultDispatchCapabilities.gc]).toEqual([]);
  });

  test("triage allowlist matches the documented operator surface", () => {
    const triage = SESSION_PROFILES.triage;
    // GH-1530 PR-6: the cross-namespace dedupe read migrated to `prx triage
    // dispatch --actor=intake -- search` (own glob covers the dispatch verb).
    expect(triage.allowedTools).not.toContain("Bash(prx intake search:*)");
    // GH-1530: classify/apply collapsed onto the own-namespace glob, which also
    // covers `prx triage dispatch --actor=intake -- …`.
    expect(triage.allowedTools).toContain("Bash(prx triage:*)");
    expect(triage.allowedTools).not.toContain("Bash(prx triage classify:*)");
    // prx-arl: `prx tools labels sync` retired (dead operator surface).
    expect(triage.allowedTools).not.toContain("Bash(prx tools labels sync:*)");
    expect(triage.allowedTools).toContain("Bash(bd create:*)");
    expect(triage.allowedTools).toContain("Bash(bd update:*)");
    expect(triage.allowedTools).toContain("Bash(bd dep:*)");
    expect(triage.allowedTools).toContain("Bash(gh issue comment:*)");
    expect(triage.allowedTools).toContain("Bash(gh issue edit:*)");
    expect(triage.disallowedTools).toContain("Edit");
    expect(triage.disallowedTools).toContain("Write");
  });

  test("GH-1530 PR-6: no profile carries a foreign `Bash(prx <actor>:*)` grant — own namespace + dispatch only", () => {
    // The ocap end-state: a session may run only its OWN `prx <actor>` namespace
    // directly; all cross-actor reach goes through `prx <actor> dispatch
    // --actor=<target>`. This lint asserts the resolved profiles carry no
    // foreign actor namespace. Exceptions that are NOT cross-actor reach:
    //   - the profile's own namespace (`head === name`)
    //   - the sanctioned `prx tools *` write-policy wrappers (`head === "tools"`)
    //   - top-level operator verbs (next/phase/snapshot/statusline/actions/run)
    //     whose head is NOT an actor name — they are the shared operator surface
    //   - scratch's broad `Bash(prx:*)` glob (no space ⇒ matches no actor head)
    const actorSet = new Set<string>(actorNames as readonly string[]);
    for (const name of sessionProfileNames) {
      const allowed = SESSION_PROFILES[name].allowedTools ?? [];
      const foreign = allowed.filter((t) => {
        if (!t.startsWith("Bash(prx ")) return false;
        const head = (t.match(/^Bash\(prx ([a-z_]+)/) ?? [])[1];
        if (!head) return false;
        if (head === name || head === "tools") return false;
        return actorSet.has(head); // only ACTOR namespaces count as foreign reach
      });
      expect(
        foreign,
        `profile '${name}' leaked foreign prx namespace grants — migrate to ` +
          `dispatch (prx ${name} dispatch --actor=<target>): ${foreign.join(", ")}`,
      ).toEqual([]);
    }
  });

  test("intake allowlist collapses onto the prx intake actor namespace (GH-1004)", () => {
    const intake = SESSION_PROFILES.intake;
    // Read/Search built-ins + own actor surface (sub-verb discovery via
    // `prx intake --help`).
    expect(intake.allowedTools).toContain("Read");
    expect(intake.allowedTools).toContain("Grep");
    expect(intake.allowedTools).toContain("Glob");
    expect(intake.allowedTools).toContain("Bash(prx intake:*)");
    // GH-1004: raw gh/bd/git surface — and the `prx tools issue` shim that
    // wrapped them — must NOT be on the allowlist anymore. The five intake
    // verbs (search/view/merge/mirror/bd) cover the documented operator
    // surface; raw tools are denied at the flag layer below.
    expect(intake.allowedTools).not.toContain("Bash(prx tools issue:*)");
    expect(intake.allowedTools).not.toContain("Bash(gh issue create:*)");
    expect(intake.allowedTools).not.toContain("Bash(gh issue comment:*)");
    expect(intake.allowedTools).not.toContain("Bash(gh issue list:*)");
    expect(intake.allowedTools).not.toContain("Bash(gh issue view:*)");
    expect(intake.allowedTools).not.toContain("Bash(bd create:*)");
    expect(intake.allowedTools).not.toContain("Bash(bd update:*)");
    expect(intake.allowedTools).not.toContain("Bash(bd list:*)");
    expect(intake.allowedTools).not.toContain("Bash(bd memories:*)");
    // Capability boundary: Edit/Write blocked + raw gh/bd/git denied as a
    // wide deny so accidental raw-tool use fails as a permission denial.
    expect(intake.disallowedTools).toContain("Edit");
    expect(intake.disallowedTools).toContain("Write");
    expect(intake.disallowedTools).toContain("Bash(gh:*)");
    expect(intake.disallowedTools).toContain("Bash(bd:*)");
    expect(intake.disallowedTools).toContain("Bash(git:*)");
    expect(intake.disallowedTools).toContain("Bash(prx plan agent --create:*)");
  });

  test("implement allowlist collapses onto the executor's actor namespace (GH-1238)", () => {
    const implement = SESSION_PROFILES.implement;
    // File-edit + in-session task tracking + bun verifications stay.
    expect(implement.allowedTools).toContain("Read");
    expect(implement.allowedTools).toContain("Edit");
    expect(implement.allowedTools).toContain("Write");
    expect(implement.allowedTools).toContain("TodoWrite");
    expect(implement.allowedTools).toContain("Bash(bun test:*)");
    expect(implement.allowedTools).toContain("Bash(bun run:*)");
    expect(implement.allowedTools).toContain("Bash(bun typecheck:*)");
    // Own actor surface only — discovery is pushed to the system prompt.
    expect(implement.allowedTools).toContain("Bash(prx implement:*)");
    // ai-home-emsht (st3a3 clarification): the executor stages + hands off;
    // it NEVER opens a PR autonomously. `prx publisher pr open` / `pr update`
    // were a GH-1558 forward pre-allowlist for verbs #1559 never landed (it
    // moved merge/ready/draft only) — they 404 in-checkout AND the executor
    // has no business opening PRs, so they are off the allowlist. Removing
    // them closes the gh-pr-create fallback (#1899 then hard-blocks raw gh).
    expect(implement.allowedTools).not.toContain("Bash(prx publisher pr open:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx publisher pr update:*)");
    // GH-1530 PR-6: publisher ready/draft (publication-state toggles) migrated
    // to `prx implement dispatch --actor=publisher -- ready|draft` (publisher
    // admits implement). They are no longer direct grants.
    expect(implement.allowedTools).not.toContain("Bash(prx publisher ready:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx publisher draft:*)");
    // GH-1558: negative boundary — destructive/handoff-only publisher
    // verbs must NOT be on the implement allowlist. Locks out scope creep
    // from ticket #2 (verb move) into this foundation ticket.
    expect(implement.allowedTools).not.toContain("Bash(prx publisher merge:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx publisher push:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx publisher branch:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx publisher close-issue:*)");
    // GH-1559 + GH-1530 PR-6: the doctor/publisher diagnostics moved to
    // `prx publisher`/`prx doctor` and are now reached via `prx implement
    // dispatch --actor=doctor|publisher -- <verb>` (both admit implement).
    // None are direct grants any longer.
    expect(implement.allowedTools).not.toContain("Bash(prx doctor merge:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx doctor ready:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx doctor draft:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx doctor inventory:*)");
    // GH-1530 PR-6: the submit producer (stage/body-template/postmerge) is now
    // reached via `prx implement dispatch --actor=submit -- stage` (submit
    // admits implement). `prx submit publish` stays operator-only (never granted).
    expect(implement.allowedTools).not.toContain("Bash(prx submit stage:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx submit publish:*)");
    // GH-1530 PR-6: the consumed-slot plan reads migrated to `prx implement
    // dispatch --actor=plan -- show|load|close` (plan admits implement).
    expect(implement.allowedTools).not.toContain("Bash(prx plan show:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx plan load:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx plan close:*)");
    // Policy-enforcing wrapped CLIs for code/branch writes.
    // GH-874: `prx tools gh` was hard-removed; internal callers use execGh()
    // directly through other actor-scoped verbs. prx-arl: `prx tools wt`
    // retired (worktrunk gone; prx owns the worktree lifecycle).
    expect(implement.allowedTools).toContain("Bash(prx tools git:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx tools gh:*)");
    expect(implement.allowedTools).toContain("Bash(prx tools bd:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx tools wt:*)");
    // GH-1238: the long pre-collapse tail must NOT be on the implement
    // allowlist anymore. Discovery via `prx implement agent --help`.
    expect(implement.allowedTools).not.toContain("Bash(prx model:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx scout:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx phase:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx snapshot:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx contract show:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx worktree status:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx repo overview:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx chain status:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx triage status:*)");
    // Disallow shape: destructive ops + recursive session entry + raw
    // beads writes + gh pr merge.
    expect(implement.disallowedTools).toContain("Bash(git push --force:*)");
    expect(implement.disallowedTools).toContain("Bash(git reset --hard:*)");
    expect(implement.disallowedTools).toContain("Bash(rm -rf:*)");
    expect(implement.disallowedTools).toContain("Bash(prx plan agent --create:*)");
    expect(implement.disallowedTools).toContain("Bash(gh pr merge:*)");
    expect(implement.disallowedTools).toContain("Bash(bd create:*)");
    expect(implement.disallowedTools).toContain("Bash(bd close:*)");
  });

  test("implement is the only profile with the OCAP typed-dispatch gate flipped on (GH-2418)", () => {
    expect(SESSION_PROFILES.implement.typedDispatchRejection).toBe(true);
    for (const name of sessionProfileNames) {
      if (name === "implement") continue;
      // Every other profile leaves the gate to the env flag (absent/false),
      // so the behavior change is confined to the executor profile.
      expect(SESSION_PROFILES[name].typedDispatchRejection ?? false).toBe(false);
    }
  });

  test("implement banner names the stage+handoff ship-out path, not raw PR-open (ai-home-emsht)", () => {
    const banner = SESSION_PROFILES.implement.banner;
    // The sanctioned ship-out the executor must reach for: stage the CAS
    // artifact, then exit to the submit operator session. GH-1530 PR-6: the
    // stage verb is reached via dispatch (submit is foreign to implement).
    expect(banner).toContain("prx implement dispatch --actor=submit -- stage");
    // GH-2380: ship-out handoff renamed `prx submit session` → `prx submit agent`.
    expect(banner).toContain("prx submit agent");
    // The executor profile must NOT advertise a PR-open path.
    expect(banner).not.toContain("prx publisher pr open");
    expect(banner).not.toContain("gh pr create");
    // GH-874: `prx tools gh` was hard-removed; the banner must not advertise
    // a gh wrapper that no longer exists.
    expect(banner).not.toContain("/gh/");
  });

  test("implement hard-blocks raw git/gh, leaving only prx wrappers + submit handoff (ai-home-d39ug / GH-1899)", () => {
    const implement = SESSION_PROFILES.implement;
    // GH-1899: raw `git` / `gh` are fully disallowed from the executor. The
    // only sanctioned writes route through `prx tools git` and the
    // `prx submit session` handoff. This closes st3a3's final AC: the
    // `gh pr create` fallback the 2026-05-27 repro hit was reachable only
    // because bare gh sat un-denied below the specific `gh pr merge` block.
    expect(implement.disallowedTools).toContain("Bash(git:*)");
    expect(implement.disallowedTools).toContain("Bash(gh:*)");
    // The policy-wrapped git surface MUST survive the blanket block — the
    // permission matcher keys on the command head (`prx`), not `git`.
    expect(implement.allowedTools).toContain("Bash(prx tools git:*)");
    // No raw gh path is allowlisted; gh access is fully mediated by prx verbs
    // (GH-874 removed `prx tools gh`, so there is no wrapper to re-admit).
    expect(implement.allowedTools).not.toContain("Bash(gh:*)");
    expect(implement.allowedTools).not.toContain("Bash(prx tools gh:*)");
  });

  test("plan allowlist consolidates onto prx verbs (GH-1147)", () => {
    const plan = SESSION_PROFILES.plan;
    // Read/Search/Inspect built-ins
    expect(plan.allowedTools).toContain("Read");
    expect(plan.allowedTools).toContain("Grep");
    expect(plan.allowedTools).toContain("Glob");
    expect(plan.allowedTools).toContain("TodoWrite");
    // GH-1530 PR-6: the cross-namespace reads (model/scout/chain/contract/repo/
    // worktree/delegate/beads/triage/submit) migrated to `prx plan dispatch
    // --actor=<target> -- <verb>` (covered by the own `Bash(prx plan:*)` glob;
    // each target admits plan). They are no longer direct grants.
    expect(plan.allowedTools).not.toContain("Bash(prx model:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx scout:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx chain status:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx contract show:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx repo overview:*)");
    // The top-level operator reads (owned by `work`, exposed top-level — not a
    // foreign actor namespace) stay direct.
    expect(plan.allowedTools).toContain("Bash(prx phase:*)");
    expect(plan.allowedTools).toContain("Bash(prx next:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx session status:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx session next:*)");
    // Policy-enforcing wrapped CLIs.
    // GH-874: `prx tools gh` was hard-removed; internal callers use execGh()
    // directly through other actor-scoped verbs.
    expect(plan.allowedTools).toContain("Bash(prx tools git:*)");
    expect(plan.allowedTools).not.toContain("Bash(prx tools gh:*)");
    expect(plan.allowedTools).toContain("Bash(prx tools bd:*)");
    // prx-arl: `prx tools wt` retired (worktrunk gone).
    expect(plan.allowedTools).not.toContain("Bash(prx tools wt:*)");
    // Capability boundary: Edit blocked. GH-1175: bare Write is intentionally
    // NOT in disallowedTools — it would override the path-scoped
    // `Write(<staging>/**)` carve-out injected by
    // `buildOpsPlanClaudeRuntimeProfile`. Bare Write is denied by virtue of
    // not being on the strict `--allowedTools` allowlist.
    expect(plan.disallowedTools).toContain("Edit");
    expect(plan.disallowedTools).not.toContain("Write");
    expect(plan.disallowedTools).toContain("Bash(git push:*)");
    // GH-1316 (epic GH-1235): raw CLI deny — planner must route through
    // `prx tools <cli>` wrappers or read-only prx verbs.
    expect(plan.disallowedTools).toContain("Bash(gh:*)");
    expect(plan.disallowedTools).toContain("Bash(bd:*)");
    expect(plan.disallowedTools).toContain("Bash(git:*)");
    // GH-1316: search-shell deny — Claude has native Read/Grep/Glob.
    expect(plan.disallowedTools).toContain("Bash(grep:*)");
    expect(plan.disallowedTools).toContain("Bash(find:*)");
    expect(plan.disallowedTools).toContain("Bash(rg:*)");
    // Raw write tools must NOT be on the allowlist (consolidated under prx)
    expect(plan.allowedTools).not.toContain("Edit");
    expect(plan.allowedTools).not.toContain("Write");
    expect(plan.allowedTools).not.toContain("Bash");
    expect(plan.allowedTools).not.toContain("Bash(gh issue view:*)");
    expect(plan.allowedTools).not.toContain("Bash(bd show:*)");
    expect(plan.allowedTools).not.toContain("Bash(git log:*)");
    // Banner enumerates the constraint
    expect(plan.banner).toContain("read/search/inspect");
    expect(plan.banner).toContain("Edit/Write");
  });
});

// GH-1989: phrases that gate filing on recurrence ("if it bites again",
// "becomes a pattern", etc.). Intake must file on first observation; triage
// disposes weak signals. Centralized so the targeted intake test and the
// cross-prompt lint below stay in lockstep.
const RECURRENCE_GATE_PHRASES = [
  "if it recurs",
  "if it bites again",
  "becomes a pattern",
  "worth filing",
  "worth a bug",
];

describe("ops intake runtime profile (GH-950)", () => {
  test("intake prompt covers the search-then-file-or-merge rules", () => {
    const prompt = buildOpsMainxIntakePrompt();
    expect(prompt).toContain("intake operator on mainx");
    expect(prompt).toContain("not an execution surface");
    expect(prompt).toContain("Search before file");
    // GH-1366: dedupe step points at the unified `prx intake search` verb
    // (already on the intake allowlist), not raw `gh issue list --search`
    // (which `Bash(gh:*)` in disallowedTools denies at the flag layer).
    expect(prompt).toContain("prx intake search");
    expect(prompt).not.toContain("gh issue list");
    expect(prompt).toContain("pre-triage");
    expect(prompt).toContain("Allowed tools:");
    expect(prompt).toContain("Disallowed tools:");
    // Allowlist text is sourced from SESSION_PROFILES.intake (config, not
    // hard-coded prompt strings).
    expect(prompt).toContain("Bash(prx intake:*)");
    expect(prompt).toContain("does not promote to beads or classify labels");
    expect(prompt).toContain("triage operator");
    expect(prompt).not.toContain("2+ filings");
    // GH-1989: file on first observation; trust triage to dispose weak signal.
    expect(prompt).toContain("File on first observation");
    expect(prompt).toContain("Triage disposes");
    for (const phrase of RECURRENCE_GATE_PHRASES) {
      expect(prompt).not.toContain(phrase);
    }
  });

  test("intake claude profile is plan-mode, work-unit-unbound, badged mainx-intake", () => {
    const profile = buildOpsIntakeClaudeRuntimeProfile();

    expect(profile.command).toBe("claude");
    expect(profile.profile).toBe("user");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("intake");

    const args = profile.args;
    const nameIdx = args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(args[nameIdx + 1]).toBe("mainx-intake");

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");

    const promptIdx = args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = args[promptIdx + 1];
    expect(prompt).toContain("intake operator on mainx");

    // No GH-N binding, no resume.
    expect(args).not.toContain("--continue");
    expect(args.join(" ")).not.toMatch(/GH-\d+/);

    expect(profile.allowedActors).toEqual(["gh", "beads", "prx"]);
    expect(profile.disallowedActors).toContain("git");
    expect(profile.disallowedActors).toContain("wt");
  });

  test("intake claude profile enforces the toolset at the flag layer (GH-1004)", () => {
    const profile = buildOpsIntakeClaudeRuntimeProfile();
    const args = profile.args;

    // GH-1004 toolset-layer enforcement: --allowedTools and --disallowedTools
    // are passed as Claude flags, not just enumerated in the prompt. Mirrors
    // the GH-1147 plan-profile precedent.
    expect(args).toContain("--allowedTools");
    const allowedIdx = args.indexOf("--allowedTools");
    const allowedJoined = args[allowedIdx + 1];
    expect(allowedJoined).toContain("Read");
    expect(allowedJoined).toContain("Grep");
    expect(allowedJoined).toContain("Glob");
    expect(allowedJoined).toContain("Bash(prx intake:*)");
    // The collapsed-away surface stays out of the allowed flag.
    expect(allowedJoined).not.toContain("Bash(gh issue");
    expect(allowedJoined).not.toContain("Bash(bd create");
    expect(allowedJoined).not.toContain("Edit");
    expect(allowedJoined).not.toContain("Write");

    expect(args).toContain("--disallowedTools");
    const disallowedIdx = args.indexOf("--disallowedTools");
    const disallowedJoined = args[disallowedIdx + 1]!;
    expect(disallowedJoined).toContain("Edit");
    expect(disallowedJoined).toContain("Write");
    expect(disallowedJoined).toContain("Bash(gh:*)");
    expect(disallowedJoined).toContain("Bash(bd:*)");
    expect(disallowedJoined).toContain("Bash(git:*)");
  });
});

// GH-1989: lint every operator prompt builder for the recurrence-gate
// antipattern. The rule is rooted in the intake operator profile (intake
// must file on first observation), but the lint covers the full operator
// surface so a future PR copying the antipattern into any operator prompt
// fails CI with a clear pointer to GH-1989.
describe("operator prompts — no recurrence-gate antipattern (GH-1989)", () => {
  const operatorPrompts: Array<{ name: string; render: () => string }> = [
    { name: "buildOpsMainxIntakePrompt", render: () => buildOpsMainxIntakePrompt() },
    { name: "buildOpsMainxTriagePrompt", render: () => buildOpsMainxTriagePrompt() },
    { name: "buildOpsPlanPrompt", render: () => buildOpsPlanPrompt("GH-1989") },
    {
      name: "buildOpsImplementPrompt",
      render: () => buildOpsImplementPrompt({ workUnitId: "GH-1989" }),
    },
    {
      name: "buildOpsImplementFallbackPrompt",
      render: () => buildOpsImplementFallbackPrompt("GH-1989"),
    },
    {
      name: "buildOpsSubmitPrompt",
      render: () => buildOpsSubmitPrompt({ workUnitId: "GH-1989" }),
    },
    {
      name: "buildOpsAuthorPrompt",
      render: () => buildOpsAuthorPrompt({ workUnitId: "GH-1989" }),
    },
  ];

  for (const { name, render } of operatorPrompts) {
    test(`${name} contains no recurrence-gate phrasing`, () => {
      const prompt = render();
      for (const phrase of RECURRENCE_GATE_PHRASES) {
        expect(prompt).not.toContain(phrase);
      }
    });
  }
});

describe("ops plan runtime profile (GH-1147)", () => {
  test("plan prompt embeds work-unit id, planner role, and allowlist", () => {
    const prompt = buildOpsPlanPrompt("GH-5431");
    expect(prompt).toContain("GH-5431");
    expect(prompt).toContain("planner");
    expect(prompt).toContain("plan profile");
    expect(prompt).toContain("Allowed tools:");
    expect(prompt).toContain("Disallowed tools:");
    // Allowlist text is sourced from SESSION_PROFILES.plan (config, not
    // hard-coded prompt strings). GH-1530 PR-6: the cross-namespace reads
    // migrated to dispatch (covered by the own `Bash(prx plan:*)` glob).
    expect(prompt).toContain("Bash(prx plan:*)");
    expect(prompt).not.toContain("Bash(prx model:*)");
    expect(prompt).toContain("Bash(prx tools git:*)");
    // Ratchet hint — GH-1172: plan-mode now points operators at `prx implement`
    // (the executor profile) rather than the deprecated `prx session open` alias.
    // GH-1981: the canonical entry verb is now `prx implement agent`; the flat
    // form has been removed and `prx implement session` is a deprecated alias.
    expect(prompt).toContain("Ratchet");
    expect(prompt).toContain("prx implement agent");
  });

  test("plan prompt redirects reads to prx plan view/search (GH-1233)", () => {
    const prompt = buildOpsPlanPrompt("GH-5431");
    // Assert on text unique to the redirect clause, not just verb names that
    // already appear in the allowlist enumeration. The clause names the
    // wrong-shape tools (raw gh/bd, beads MCP) as denied, and routes code
    // inspection to the actually-allowed Read/Grep/Glob tools.
    expect(prompt).toContain("not raw `gh issue view`");
    expect(prompt).toContain("beads MCP");
    expect(prompt).toContain("canonical issue read path");
    expect(prompt).toContain("`Read`/`Grep`/`Glob`");
  });

  test("plan prompt names prx plan save as terminal write (GH-1233)", () => {
    const prompt = buildOpsPlanPrompt("GH-5431");
    // Unique-to-redirect-clause assertions: the wrong-path tools and the
    // GH-1237 zero-byte-stdin warning are not present via the allowlist.
    expect(prompt).toContain("--from-stdin");
    expect(prompt).toContain("ExitPlanMode");
    expect(prompt).toContain("zero-byte plan");
    expect(prompt).toContain("GH-1237");
  });

  test("plan prompt forward-references scout dispatch (GH-1233/GH-1228)", () => {
    const prompt = buildOpsPlanPrompt("GH-5431");
    // Forward-reference to scout dispatch is unique to the redirect clause —
    // neither "scout dispatch" nor "GH-1228" appears via the allowlist.
    expect(prompt).toContain("scout dispatch");
    expect(prompt).toContain("GH-1228");
  });

  test("plan prompt names typed scout-dispatch inventory verbs (GH-1384)", () => {
    const prompt = buildOpsPlanPrompt("GH-5431");
    // Unique-to-clause assertions per the priming-test-unique-text rule:
    // the CAS handle prefix and GH-1384 reference appear only in the new
    // inventory-clause, not via the allowlist enumeration of verb names.
    expect(prompt).toContain("scout://sha256:");
    expect(prompt).toContain("GH-1384");
    // GH-1530: `prx plan dispatch` is covered by the registry-derived
    // own-namespace glob `Bash(prx plan:*)`, so the allowlist line surfaces the
    // glob (the dispatch verb stays runnable for the planner).
    expect(prompt).toContain("Bash(prx plan:*)");
  });

  test("plan claude profile is work-unit-bound, plan-mode, flag-layer enforced", () => {
    const profile = buildOpsPlanClaudeRuntimeProfile({
      workUnitId: "GH-5431",
      hasPriorSession: false,
    });

    expect(profile.command).toBe("claude");
    expect(profile.profile).toBe("work-unit");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("planner");

    const args = profile.args;

    const nameIdx = args.indexOf("--name");
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(args[nameIdx + 1]).toBe("GH-5431");

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");

    // GH-1147 toolset-layer enforcement: --allowedTools and --disallowedTools
    // are passed as Claude flags, not just enumerated in the prompt.
    expect(args).toContain("--allowedTools");
    const allowedIdx = args.indexOf("--allowedTools");
    const allowedJoined = args[allowedIdx + 1];
    expect(allowedJoined).toContain("Read");
    expect(allowedJoined).toContain("Grep");
    // GH-1530 PR-6: own-namespace glob (covers `prx plan dispatch …`); the
    // former direct `Bash(prx model:*)` cross-namespace read migrated to dispatch.
    expect(allowedJoined).toContain("Bash(prx plan:*)");
    expect(allowedJoined).not.toContain("Edit");

    expect(args).toContain("--disallowedTools");
    const disallowedIdx = args.indexOf("--disallowedTools");
    const disallowedJoined = args[disallowedIdx + 1]!;
    expect(disallowedJoined).toContain("Edit");
    // GH-1175: bare `Write` is intentionally NOT in --disallowedTools — it
    // would override the path-scoped `Write(<staging>/**)` carve-out.
    expect(disallowedJoined.split(",")).not.toContain("Write");
    expect(disallowedJoined).toContain("Bash(git push:*)");
    // GH-1316 (epic GH-1235): raw CLI + search-shell deny entries thread
    // through into the comma-joined --disallowedTools argv.
    expect(disallowedJoined).toContain("Bash(gh:*)");
    expect(disallowedJoined).toContain("Bash(bd:*)");
    expect(disallowedJoined).toContain("Bash(git:*)");
    expect(disallowedJoined).toContain("Bash(grep:*)");
    expect(disallowedJoined).toContain("Bash(find:*)");
    expect(disallowedJoined).toContain("Bash(rg:*)");

    const promptIdx = args.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = args[promptIdx + 1];
    expect(prompt).toContain("GH-5431");
    expect(prompt).toContain("planner");

    // First-entry: no --continue.
    expect(args).not.toContain("--continue");
  });

  test("plan claude profile resumes prior session via --continue", () => {
    const profile = buildOpsPlanClaudeRuntimeProfile({
      workUnitId: "GH-5431",
      hasPriorSession: true,
    });
    expect(profile.args).toContain("--continue");
    const nameIdx = profile.args.indexOf("--name");
    expect(profile.args[nameIdx + 1]).toBe("GH-5431");
  });
});

describe("prx-pln — plan-print enforces the structured plan artifact", () => {
  test("the plan-print profile sets capturePlanArtifact so submit_plan is enforced", () => {
    // Without this, executeAgentProfile never injects the `prx-plan` submit_plan
    // tool, the planner emits free prose, and the draft fails the `## Scope`
    // shape gate — so `prx implement agent` refuses. (prx-pln regression.)
    const p = buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "GH-1" });
    expect(p.sdkSpec?.capturePlanArtifact).toBe(true);
  });

  test("the planner embeds the consumed source body; falls back when absent (prx-pl2)", () => {
    const withSrc =
      buildWorkUnitClaudePlanPrintRuntimeProfile({
        workUnitId: "prx-2c4",
        sourceBody: "task: Document the opt-out\n\nAdd a note to keymaker.ts.",
      }).sdkSpec?.prompt ?? "";
    expect(withSrc).toContain("BEGIN WORK UNIT SOURCE");
    expect(withSrc).toContain("Add a note to keymaker.ts");
    expect(withSrc).toContain("do NOT run `prx`/`bd` to re-fetch");
    expect(withSrc).toContain("submit_plan");
    // GH-261: NO hydrate path. Absent source ⇒ a no-fabricate notice pointing at
    // intake (real headless launches hard-fail upstream), NOT "fetch it yourself".
    const noSrc =
      buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "prx-2c4" }).sdkSpec?.prompt ?? "";
    expect(noSrc).not.toContain("BEGIN WORK UNIT SOURCE");
    expect(noSrc).not.toContain("Hydrate workflow context");
    expect(noSrc).toContain("must NOT fetch or fabricate");
    expect(noSrc).toContain("prx intake source");
  });

  test("the planner prompt instructs calling submit_plan, not emitting prose (prx-ei6)", () => {
    // The capture contract is only honored if the prompt tells the model to
    // call the tool. The old prompt said "Output plain markdown", so the model
    // never called submit_plan → "planner did not call submit_plan".
    const p = buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "GH-1" });
    const prompt = p.sdkSpec?.prompt ?? "";
    expect(prompt).toContain("submit_plan");
    // The old contradictory instruction ("Output plain markdown …") is gone.
    expect(prompt.toLowerCase()).not.toContain("output plain markdown");
  });

  test("the resume-draft planner prompt also routes through submit_plan (prx-ei6)", () => {
    const p = buildWorkUnitClaudePlanPrintRuntimeProfile({
      workUnitId: "GH-1",
      resumePartialPlan: "## Problem\npartial",
    });
    const prompt = p.sdkSpec?.prompt ?? "";
    expect(prompt).toContain("submit_plan");
    expect(prompt.toLowerCase()).not.toContain("output plain markdown");
  });
});

describe("GH-1407 — non-interactive sdkSpec cache split", () => {
  test("plan-print stable prefix is byte-identical across different workUnitIds", () => {
    const a = buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "GH-1111" });
    const b = buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "GH-2222" });
    expect(a.sdkSpec?.systemPromptStable).toEqual(b.sdkSpec?.systemPromptStable);
    // The dynamic suffix must differ; it carries the workUnitId anchor.
    expect(a.sdkSpec?.systemPromptDynamic).not.toEqual(b.sdkSpec?.systemPromptDynamic);
    expect(a.sdkSpec?.systemPromptDynamic?.join(" ")).toContain("GH-1111");
    expect(b.sdkSpec?.systemPromptDynamic?.join(" ")).toContain("GH-2222");
  });

  test("plan-print stable prefix carries no workUnitId leakage", () => {
    const a = buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "GH-1111" });
    const stable = a.sdkSpec?.systemPromptStable?.join(" ") ?? "";
    expect(stable).not.toContain("GH-1111");
  });

  test("plan-print sdkSpec drops the legacy preset-append shape", () => {
    const a = buildWorkUnitClaudePlanPrintRuntimeProfile({ workUnitId: "GH-1111" });
    // GH-1407 — appendSystemPrompt is removed; profile authors must use the
    // (stable, dynamic) split so the SDK can cache the prefix.
    expect((a.sdkSpec as Record<string, unknown>).appendSystemPrompt).toBeUndefined();
    expect(a.sdkSpec?.systemPromptStable).toBeDefined();
    expect(a.sdkSpec?.systemPromptDynamic).toBeDefined();
  });

  test("triage Haiku classifier puts the per-batch system prompt entirely in the stable slot", () => {
    const profile = buildTriageHaikuClassifierRuntimeProfile({
      model: "claude-haiku-4-5-20251001",
      systemPrompt: "constant type-pass system prompt",
      userPrompt: "row body to classify",
    });
    expect(profile.sdkSpec?.systemPromptStable).toEqual(["constant type-pass system prompt"]);
    // user prompt goes to the user message, not the system slot.
    expect(profile.sdkSpec?.systemPromptDynamic).toBeUndefined();
    expect(profile.sdkSpec?.prompt).toBe("row body to classify");
  });
});

describe("buildWorkUnitClaudeImplementSdkRuntimeProfile (headless-first step 2)", () => {
  test("is a headless SDK profile that derives the sdk backend", () => {
    const p = buildWorkUnitClaudeImplementSdkRuntimeProfile({ workUnitId: "GH-1234" });
    expect(p.command).toBe("claude");
    expect(p.interaction).toBe("headless");
    expect(p.agentRuntime).toBe("sdk");
    expect(resolveAgentBackend(p)).toBe("sdk");
  });

  test("sdkSpec carries an edit-capable posture bounded by the implement allowlist", () => {
    const p = buildWorkUnitClaudeImplementSdkRuntimeProfile({ workUnitId: "GH-1234" });
    expect(p.sdkSpec?.permissionMode).toBe("acceptEdits");
    expect(p.sdkSpec?.allowedTools).toEqual([...SESSION_PROFILES.implement.allowedTools]);
    // executor role posture is cache-stable; only the workUnit anchor varies.
    expect(p.sdkSpec?.systemPromptStable?.length).toBeGreaterThan(0);
    expect(p.sdkSpec?.systemPromptDynamic?.join(" ")).toContain("GH-1234");
  });

  test("cache-stable system prefix is identical across work units (GH-1407)", () => {
    const a = buildWorkUnitClaudeImplementSdkRuntimeProfile({ workUnitId: "GH-1111" });
    const b = buildWorkUnitClaudeImplementSdkRuntimeProfile({ workUnitId: "GH-2222" });
    expect(a.sdkSpec?.systemPromptStable).toEqual(b.sdkSpec?.systemPromptStable);
    expect(a.sdkSpec?.systemPromptDynamic).not.toEqual(b.sdkSpec?.systemPromptDynamic);
  });

  test("embeds the input plan artifact in the prompt so the executor has scope (prx-pe1)", () => {
    // The plan→implement edge consumed: the validated plan body is the
    // executor's confirmed scope, embedded directly so it never reaches for
    // prx/bd (denied in the headless allowlist) to read scope.
    const planBody = "## Problem\nREADME drift\n## Scope\nUpdate the README only.";
    const p = buildWorkUnitClaudeImplementSdkRuntimeProfile({
      workUnitId: "prx-0v5",
      planBody,
    });
    const prompt = p.sdkSpec?.prompt ?? "";
    expect(prompt).toContain("BEGIN APPROVED PLAN");
    expect(prompt).toContain("Update the README only.");
    expect(prompt).toContain("do not widen it");
    // The cache-stable system prefix must NOT carry the per-unit plan body.
    expect(p.sdkSpec?.systemPromptStable?.join(" ")).not.toContain("README drift");
  });

  test("falls back to the fetch-it-yourself prompt when no plan body is supplied", () => {
    const p = buildWorkUnitClaudeImplementSdkRuntimeProfile({ workUnitId: "prx-0v5" });
    const prompt = p.sdkSpec?.prompt ?? "";
    expect(prompt).not.toContain("BEGIN APPROVED PLAN");
    expect(prompt).toContain("Execute the implementation plan for prx-0v5");
  });

  test("prompt tells the executor to commit WITHOUT running checks — prx signs them (prx-who)", () => {
    // bun is outside the executor's exec sandbox, so "run the project checks"
    // wasted a real run's budget. prx runs + signs checks/v1 post-commit.
    const withPlan =
      buildWorkUnitClaudeImplementSdkRuntimeProfile({
        workUnitId: "prx-0v5",
        planBody: "## Scope\nx",
      }).sdkSpec?.prompt ?? "";
    expect(withPlan).toContain("Do NOT run the project checks");
    expect(withPlan).toContain("commit");
    const noPlan =
      buildWorkUnitClaudeImplementSdkRuntimeProfile({ workUnitId: "prx-0v5" }).sdkSpec?.prompt ??
      "";
    expect(noPlan).toContain("Do NOT run the project checks");
  });

  test("headless system prompt does not order denied CLIs; works from the artifact (prx-pe1 slice 2)", () => {
    // The shared interactive mandate ("inspect prx graph/model/actors") orders
    // tools the headless allowlist denies — the executor's stated refusal
    // reason. The headless system prompt must not carry it.
    const sys =
      buildWorkUnitClaudeImplementSdkRuntimeProfile({
        workUnitId: "prx-0v5",
      }).sdkSpec?.systemPromptStable?.join(" ") ?? "";
    expect(sys).not.toContain("prx graph");
    expect(sys).not.toContain("prx model");
    expect(sys).not.toContain("prx actors");
    // It tells the executor to work from the embedded plan + its real toolset.
    expect(sys).toContain("embedded in the task prompt");
    expect(sys).toContain("prx tools git");
  });

  test("injects the plan path into the dynamic segment when provided", () => {
    const p = buildWorkUnitClaudeImplementSdkRuntimeProfile({
      workUnitId: "GH-1234",
      planPath: "/tmp/plan.md",
    });
    expect(p.sdkSpec?.systemPromptDynamic?.join(" ")).toContain("/tmp/plan.md");
  });
});

describe("scratch session profile (GH-2394)", () => {
  // The safe-mode builder writes a sandbox settings file under
  // `<cwd>/.pr/local/runtime/` when present, else `$TMPDIR`. Use a fresh tmp
  // cwd (no `.pr/local/runtime/`) so the file lands in $TMPDIR and we can read
  // it back from the `--settings` arg without touching the repo.
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prx-scratch-test-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("SESSION_PROFILES.scratch is least-privilege, mainx-bound, connectors denied", () => {
    const scratch = SESSION_PROFILES.scratch;
    expect(scratch.binding).toBe("mainx");
    // Strict allowlist: read/search + the prx surface only.
    expect(scratch.allowedTools).toEqual(["Read", "Grep", "Glob", "Bash(prx:*)"]);
    // No Edit/Write/raw-tool surface.
    expect(scratch.allowedTools).not.toContain("Edit");
    expect(scratch.allowedTools).not.toContain("Write");
    expect(scratch.allowedTools).not.toContain("Bash(gh:*)");
    expect(scratch.allowedTools).not.toContain("Bash(git:*)");
    // Explicit legibility denies layered on the strict allowlist.
    for (const denied of [
      "Edit",
      "Write",
      "Bash(gh:*)",
      "Bash(bd:*)",
      "Bash(git:*)",
      "Bash(rm:*)",
      "WebFetch",
      "Agent",
    ]) {
      expect(scratch.disallowedTools).toContain(denied);
    }
    // Actor boundary: only prx + the llm_agent; the connector actors are denied.
    expect(scratch.allowedActors).toEqual(["prx", "llm_agent"]);
    for (const denied of ["git", "gh", "wt", "beads", "gmail", "gcal", "notion_mcp"]) {
      expect(scratch.disallowedActors).toContain(denied);
    }
    // Ad-hoc sessions never fan out.
    expect(scratch.allowedDispatchTargets).toEqual([]);
  });

  test("safe mode (default): all three layers on", () => {
    const profile = buildOpsScratchClaudeRuntimeProfile({ cwd });
    const args = profile.args;
    expect(profile.command).toBe("claude");

    // Layer 1 — permission flag-layer.
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).toContain("--allowedTools");
    const allowed = args[args.indexOf("--allowedTools") + 1] ?? "";
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Bash(prx:*)");
    // Edit/Write/Bash(non-prx) are NOT on the allowlist.
    expect(allowed).not.toContain("Edit");
    expect(allowed).not.toContain("Write");
    expect(allowed).not.toMatch(/Bash\(git/);
    expect(args).toContain("--disallowedTools");

    // Layer 2 — MCP lockdown: strict-mcp-config + inline empty MCP map + the
    // connector kill-switch env.
    expect(args).toContain("--strict-mcp-config");
    const mcpIdx = args.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[mcpIdx + 1]!)).toEqual({ mcpServers: {} });
    expect(profile.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(profile.env?.PRX_AGENT_ROLE).toBe("scratch");

    // Layer 3 — sandbox via --settings.
    expect(args).toContain("--settings");
    const settingsPath = args[args.indexOf("--settings") + 1]!;
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.filesystem.allowWrite).toContain(cwd);
    expect(settings.sandbox.filesystem.allowWrite).toContain("$TMPDIR");
    expect(settings.sandbox.network.allowedDomains).toEqual([...SCRATCH_SANDBOX_ALLOWED_DOMAINS]);
  });

  test("--unsafe: bare ambient projection, no safe-mode flags or kill-switch", () => {
    const profile = buildOpsScratchClaudeRuntimeProfile({ cwd, unsafe: true });
    const args = profile.args;
    expect(profile.command).toBe("claude");
    // Name is pinned, but none of the safe-mode flags are present.
    expect(args).toContain("--name");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--mcp-config");
    // The connector kill-switch is omitted — ambient authority is intentional.
    expect(profile.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
    expect(profile.env?.PRX_AGENT_ROLE).toBe("scratch");
  });

  test("--continue threads through when a prior session exists", () => {
    const safe = buildOpsScratchClaudeRuntimeProfile({ cwd, hasPriorSession: true });
    expect(safe.args).toContain("--continue");
    const unsafe = buildOpsScratchClaudeRuntimeProfile({
      cwd,
      unsafe: true,
      hasPriorSession: true,
    });
    expect(unsafe.args).toContain("--continue");
    const fresh = buildOpsScratchClaudeRuntimeProfile({ cwd });
    expect(fresh.args).not.toContain("--continue");
  });

  test("prompt documents the safe/unsafe contract", () => {
    const safe = buildOpsScratchPrompt(false);
    expect(safe).toContain("safe-by-default");
    expect(safe).toContain("ENABLE_CLAUDEAI_MCP_SERVERS=false");
    expect(safe).toContain("--unsafe");
    const unsafe = buildOpsScratchPrompt(true);
    expect(unsafe).toContain("UNSAFE");
    expect(unsafe).toContain("ambient authority");
  });
});

describe("ops session SDK runtime profiles (headless-first step 2/2b, GH-2380)", () => {
  const cases = [
    {
      name: "intake" as const,
      build: () => buildOpsIntakeSdkRuntimeProfile(),
      role: "intake",
      profile: "user" as const,
    },
    {
      name: "triage" as const,
      build: () => buildOpsTriageSdkRuntimeProfile(),
      role: "triage",
      profile: "user" as const,
    },
    {
      name: "submit" as const,
      build: () => buildOpsSubmitSdkRuntimeProfile({ workUnitId: "GH-1900" }),
      role: "submit",
      profile: "work-unit" as const,
    },
    {
      name: "author" as const,
      build: () => buildOpsAuthorSdkRuntimeProfile({ workUnitId: "GH-1206" }),
      role: "author",
      profile: "work-unit" as const,
    },
  ];

  for (const c of cases) {
    test(`${c.name} → headless SDK profile, derives the sdk backend, role=${c.role}`, () => {
      const p = c.build();
      expect(p.command).toBe("claude");
      expect(p.interaction).toBe("headless");
      expect(p.agentRuntime).toBe("sdk");
      expect(resolveAgentBackend(p)).toBe("sdk");
      expect(p.profile).toBe(c.profile);
      expect(p.env?.PRX_AGENT_ROLE).toBe(c.role);
    });

    test(`${c.name} → sdkSpec carries SESSION_PROFILES.${c.name} allowlist/denylist verbatim; autonomous (non-blocking) posture`, () => {
      const p = c.build();
      // prx-hz1: a headless run has no operator to approve ExitPlanMode, so
      // `plan` mode hangs forever. acceptEdits runs autonomously; the
      // allow/deny lists (asserted below) are the authority boundary.
      expect(p.sdkSpec?.permissionMode).toBe("acceptEdits");
      expect(p.sdkSpec?.allowedTools).toEqual([...SESSION_PROFILES[c.name].allowedTools]);
      expect(p.sdkSpec?.disallowedTools).toEqual([...SESSION_PROFILES[c.name].disallowedTools]);
      // None of the four ops profiles edit source.
      expect(p.sdkSpec?.allowedTools).not.toContain("Edit");
      expect(p.sdkSpec?.allowedTools).not.toContain("Write");
    });
  }

  test("submit SDK profile exports PRX_SUBMIT_SESSION_UNIT (GH-1900 parity)", () => {
    const p = buildOpsSubmitSdkRuntimeProfile({ workUnitId: "GH-1900" });
    expect(p.env?.PRX_SUBMIT_SESSION_UNIT).toBe("GH-1900");
  });

  test("submit/author SDK allowlists are deterministic across work-unit ids", () => {
    const s1 = buildOpsSubmitSdkRuntimeProfile({ workUnitId: "GH-1" });
    const s2 = buildOpsSubmitSdkRuntimeProfile({ workUnitId: "GH-2" });
    expect(s1.sdkSpec?.allowedTools).toEqual(s2.sdkSpec?.allowedTools);
    const a1 = buildOpsAuthorSdkRuntimeProfile({ workUnitId: "GH-1" });
    const a2 = buildOpsAuthorSdkRuntimeProfile({ workUnitId: "GH-2" });
    expect(a1.sdkSpec?.allowedTools).toEqual(a2.sdkSpec?.allowedTools);
  });
});
