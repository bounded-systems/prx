// Registry contract tests (GH-975).
//
// These tests assert the IA invariants from `docs/prx/help-surface.md` are
// honored by `prxCommandRegistry`, plus a dispatch-coverage check that fails
// loudly if a future cli.ts edit adds a c0 verb or session-namespace leaf
// without a matching registry entry.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  ActorName,
  CommandSpec,
  Deprecation,
  SessionContext,
} from "../../src/cli/registry.ts";
import {
  prxCommandRegistry,
  promotedFor,
} from "../../src/cli/registry.data.ts";
import { sessionProfileNames } from "../../src/machine/runtime_profiles.ts";

const cliPath = fileURLToPath(
  new URL("../../src/pr-state/cli.ts", import.meta.url),
);
const cliSource = readFileSync(cliPath, "utf8");

describe("CommandSpec schema", () => {
  test("registry parses against the schema (already enforced at module load)", () => {
    for (const spec of prxCommandRegistry) {
      expect(() => CommandSpec.parse(spec)).not.toThrow();
    }
  });

  test("description shorter than 4 words fails parse (§6.4)", () => {
    expect(() =>
      CommandSpec.parse({
        name: "foo",
        description: "too few words",
        domain: "system",
      }),
    ).toThrow();
  });

  test("description longer than 12 words fails parse (§6.4)", () => {
    expect(() =>
      CommandSpec.parse({
        name: "foo",
        description:
          "this description has way too many words to satisfy the help surface rule",
        domain: "system",
      }),
    ).toThrow();
  });

  test("Deprecation requires a non-empty stderr_hint (§3 / §8)", () => {
    expect(() =>
      Deprecation.parse({
        alias_for: "plan session",
        removal_target: "#582",
        stderr_hint: "",
      }),
    ).toThrow();
  });
});

describe("IA invariants", () => {
  test("§6.4 — every description is 4-12 words", () => {
    for (const spec of prxCommandRegistry) {
      const words = spec.description
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0);
      expect(
        words.length,
        `'${spec.name}' description has ${words.length} words: ${spec.description}`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        words.length,
        `'${spec.name}' description has ${words.length} words: ${spec.description}`,
      ).toBeLessThanOrEqual(12);
    }
  });

  test("§6.2 — at most six promoted entries per session context", () => {
    for (const ctx of SessionContext.options) {
      const count = prxCommandRegistry.filter((c) =>
        c.promoted_in.includes(ctx),
      ).length;
      expect(
        count,
        `${count} entries promoted in '${ctx}' context (limit: 6)`,
      ).toBeLessThanOrEqual(6);
    }
  });

  test("§6.2 — mainx promotion is the canonical six (GH-1166)", () => {
    // GH-1166: bare-session retirement renamed two slots:
    //   `session next`  → `next`
    //   `session close` → `plan handoff` (also stays plan-promoted)
    const promoted = promotedFor("mainx").map((c) => c.name);
    expect(promoted).toEqual([
      "tui",
      "plan session",
      "next",
      "do",
      "review",
      "plan handoff",
    ]);
  });

  test("§6.2 — plan promotion is the canonical six (GH-978, GH-1057)", () => {
    const promoted = promotedFor("plan").map((c) => c.name);
    expect(promoted).toEqual([
      "plan session",
      "plan handoff",
      "plan close",
      "plan ci",
      "plan status",
      "plan next",
    ]);
  });

  test("§4 — every session-profile entry uses verb-object name", () => {
    // GH-1981: `implement` carved out first; its canonical entry is
    // `implement agent`. GH-2380: intake/triage/submit/author followed —
    // the canonical entry is `<name> agent` (headless-first). `plan` keeps
    // the `plan session` shape (it is not an `agent`-verb profile).
    for (const spec of prxCommandRegistry) {
      if (spec.session_profile === undefined) continue;
      // GH-2394: scratch is a bare command (`prx scratch`) — work-unit-UNBOUND
      // and outside the `<profile> session` lifecycle family, so its entry name
      // has no ` session` suffix.
      const expectedName =
        spec.session_profile === "plan"
          ? "plan session"
          : spec.session_profile === "scratch"
            ? "scratch"
            : `${spec.session_profile} agent`;
      expect(
        spec.name,
        `session-profile '${spec.session_profile}' entry name should be '${expectedName}'`,
      ).toBe(expectedName);
    }
  });

  test("§3 / §8 — every deprecation carries a non-empty stderr_hint", () => {
    const deprecated = prxCommandRegistry.filter((c) => c.deprecation);
    expect(deprecated.length).toBeGreaterThan(0);
    for (const spec of deprecated) {
      expect(spec.deprecation!.stderr_hint.length).toBeGreaterThan(0);
      expect(spec.deprecation!.alias_for.length).toBeGreaterThan(0);
      expect(spec.deprecation!.removal_target.length).toBeGreaterThan(0);
    }
  });

  test("session_profile values are drawn from runtime_profiles.sessionProfileNames", () => {
    for (const spec of prxCommandRegistry) {
      if (spec.session_profile === undefined) continue;
      expect(
        sessionProfileNames as readonly string[],
      ).toContain(spec.session_profile);
    }
  });

  test("GH-1242 PR-1 — every entry's actor is in the canonical ActorName enum", () => {
    // Defense-in-depth alongside the Zod parse: if a future entry adds an
    // actor that drifts off the canonical set, this fails loudly with the
    // offending entry's name in the message rather than the generic Zod
    // module-load error.
    const canonical: ReadonlySet<string> = new Set(ActorName.options);
    for (const spec of prxCommandRegistry) {
      expect(
        canonical.has(spec.actor),
        `'${spec.name}' has actor '${spec.actor}' which is not in the canonical ActorName enum`,
      ).toBe(true);
    }
  });
});

describe("dispatch coverage (GH-975 mechanical port)", () => {
  // Plural ergonomic alias that maps onto canonical `repo` parent.
  const ALIAS_PARENT: Record<string, string> = {
    repos: "repo",
  };

  function hasEntryForVerb(verb: string): boolean {
    const target = ALIAS_PARENT[verb] ?? verb;
    return prxCommandRegistry.some(
      (c) => c.parent === target || c.name === target || c.name === verb,
    );
  }

  test("every c0 namespace verb in cli.ts has a registry entry", () => {
    const c0Verbs = new Set<string>();
    const re = /c0 === "([a-z][a-z-]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(cliSource)) !== null) {
      c0Verbs.add(match[1]!);
    }
    expect(c0Verbs.size).toBeGreaterThan(0);
    for (const verb of c0Verbs) {
      expect(
        hasEntryForVerb(verb),
        `c0 verb '${verb}' has no registry entry (parent or name match)`,
      ).toBe(true);
    }
  });

  test("GH-1166 — bare `prx session <verb>` namespace is retired", () => {
    // GH-1166 hard-removed the bare-session namespace. Read-side subcommands
    // moved to canonical homes. Only `session open` (deprecated alias for
    // `plan session`, retired separately under #582 / #833 / #1084) may
    // remain with a `session` parent, and only because it has a deprecation
    // record. No other `session.*` registry entries are allowed.
    const sessionParented = prxCommandRegistry.filter(
      (c) => c.parent === "session",
    );
    for (const spec of sessionParented) {
      expect(
        spec.deprecation,
        `'${spec.name}' is parented under 'session' but has no deprecation record (GH-1166: only deprecated aliases may keep the session parent)`,
      ).toBeDefined();
    }
  });

  test("GH-1166 — bare `prx session` retired-verb redirects map to live registry entries", () => {
    // The cli.ts dispatcher exposes RETIRED_SESSION_VERB_REDIRECTS as a
    // record from retired subverb → canonical command string. Each redirect
    // target must be a real registered command so users following the hint
    // land somewhere real.
    const blockMatch = cliSource.match(
      /const RETIRED_SESSION_VERB_REDIRECTS:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/,
    );
    expect(
      blockMatch,
      "could not locate RETIRED_SESSION_VERB_REDIRECTS block in cli.ts",
    ).not.toBeNull();
    const targets = Array.from(blockMatch![1]!.matchAll(/"prx ([a-z][a-z\- ]*)"/g)).map(
      (m) => m[1]!.trim(),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const found = prxCommandRegistry.some(
        (c) => c.name === target || c.parent === target.split(" ")[0],
      );
      expect(
        found,
        `retired-verb redirect target 'prx ${target}' has no matching registry entry`,
      ).toBe(true);
    }
  });

  test("every session-profile in runtime_profiles.ts has a session-entry registry entry", () => {
    // GH-1981: `implement` carved out first — canonical name is now
    // `implement agent`. GH-2380: intake/triage/submit/author followed
    // (`<name> agent`, headless-first). `plan` keeps `plan session`.
    for (const profile of sessionProfileNames) {
      // GH-2394: scratch's canonical entry is the bare `prx scratch`.
      const expected =
        profile === "plan"
          ? "plan session"
          : profile === "scratch"
            ? "scratch"
            : `${profile} agent`;
      const found = prxCommandRegistry.find(
        (c) => c.name === expected && c.session_profile === profile,
      );
      expect(
        found,
        `session profile '${profile}' has no registry entry '${expected}'`,
      ).toBeDefined();
    }
  });
});

describe("registry consistency", () => {
  test("names are unique", () => {
    const seen = new Map<string, number>();
    for (const spec of prxCommandRegistry) {
      seen.set(spec.name, (seen.get(spec.name) ?? 0) + 1);
    }
    for (const [name, count] of seen) {
      expect(count, `duplicate registry entry: '${name}'`).toBe(1);
    }
  });

  test("namespaced entries declare their parent", () => {
    for (const spec of prxCommandRegistry) {
      const parts = spec.name.split(" ");
      if (parts.length === 1) continue;
      expect(
        spec.parent,
        `'${spec.name}' is namespaced but has no parent`,
      ).toBe(parts[0]);
    }
  });

  test("prx-rgr: session open / session plan are retired — no longer registered", () => {
    expect(prxCommandRegistry.find((c) => c.name === "session open")).toBeUndefined();
    expect(prxCommandRegistry.find((c) => c.name === "session plan")).toBeUndefined();
  });

  test("prx-rgr: the claude runtime launcher is registered (formerly session open-claude)", () => {
    const spec = prxCommandRegistry.find((c) => c.name === "claude");
    expect(spec).toBeDefined();
    expect(spec!.binding).toBe("work-unit");
    expect(spec!.actor).toBe("plan");
  });

  test("author agent and author body-template are registered under author actor (GH-1206 / GH-2380)", () => {
    const session = prxCommandRegistry.find((c) => c.name === "author agent");
    expect(session).toBeDefined();
    expect(session!.parent).toBe("author");
    expect(session!.actor).toBe("author");
    expect(session!.binding).toBe("work-unit");
    expect(session!.session_profile).toBe("author");
    expect(session!.session_role).toBe("lifecycle");

    const template = prxCommandRegistry.find((c) => c.name === "author body-template");
    expect(template).toBeDefined();
    expect(template!.parent).toBe("author");
    expect(template!.actor).toBe("author");
    expect(template!.binding).toBe("work-unit");
    expect(template!.session_role).toBe("toolset");
    // Toolset verb — no session_profile (it does not boot a session).
    expect(template!.session_profile).toBeUndefined();
  });

  test("ActorName enum includes 'author' (GH-1206)", () => {
    expect(ActorName.options).toContain("author");
  });

  test("plan prime is registered under plan parent (GH-1056)", () => {
    const spec = prxCommandRegistry.find((c) => c.name === "plan prime");
    expect(spec).toBeDefined();
    expect(spec!.parent).toBe("plan");
    expect(spec!.binding).toBe("work-unit");
    expect(spec!.domain).toBe("work-units");
    // Non-promoted by IA decision GH-1082 — see registry.ts entry comment.
    expect(spec!.promoted_in).toEqual([]);
  });
});

describe("session_role tagging (GH-1311)", () => {
  test("every parent='plan' entry declares a session_role", () => {
    const planChildren = prxCommandRegistry.filter((c) => c.parent === "plan");
    expect(planChildren.length).toBeGreaterThan(0);
    for (const spec of planChildren) {
      expect(
        spec.session_role,
        `'${spec.name}' is parented under 'plan' but has no session_role`,
      ).toBeDefined();
    }
  });

  test("session_role is scoped to plan and author actors (GH-1206)", () => {
    const allowedParents: ReadonlySet<string> = new Set(["plan", "author"]);
    for (const spec of prxCommandRegistry) {
      if (spec.session_role === undefined) continue;
      expect(
        spec.parent !== undefined && allowedParents.has(spec.parent),
        `'${spec.name}' carries session_role but parent is '${spec.parent}' (allowed: ${[...allowedParents].join(", ")})`,
      ).toBe(true);
    }
  });

  test("plan session_role tagging matches the canonical partition", () => {
    const partition: Record<string, "lifecycle" | "toolset" | "preflight"> = {
      "plan session": "lifecycle",
      "plan prime": "lifecycle",
      "plan close": "lifecycle",
      "plan handoff": "lifecycle",
      "plan view": "toolset",
      "plan search": "toolset",
      "plan save": "toolset",
      "plan load": "toolset",
      "plan show": "toolset",
      "plan ci": "preflight",
      "plan ultrareview": "preflight",
      "plan status": "preflight",
      "plan next": "preflight",
      "plan preflight": "preflight",
    };
    for (const [name, role] of Object.entries(partition)) {
      const spec = prxCommandRegistry.find((c) => c.name === name);
      expect(spec, `'${name}' missing from registry`).toBeDefined();
      expect(spec!.session_role).toBe(role);
    }
  });
});
