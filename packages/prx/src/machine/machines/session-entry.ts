import { assign, setup } from "xstate";

import {
  buildOpsAuthorClaudeRuntimeProfile,
  buildOpsAuthorSdkRuntimeProfile,
  buildOpsImplementClaudeRuntimeProfile,
  buildOpsIntakeClaudeRuntimeProfile,
  buildOpsIntakeSdkRuntimeProfile,
  buildOpsPlanClaudeRuntimeProfile,
  buildOpsScratchClaudeRuntimeProfile,
  buildOpsSubmitClaudeRuntimeProfile,
  buildOpsSubmitSdkRuntimeProfile,
  buildOpsTriageClaudeRuntimeProfile,
  buildOpsTriageSdkRuntimeProfile,
  type RuntimeProfileProjection,
} from "../runtime_profiles.ts";
import { PRX_SESSION_OPEN_ALIAS_HINT } from "../session_open.ts";

/**
 * GH-977: session-entry XState machine.
 *
 * Promotes the four `prx <profile> session` entry points (`session open`,
 * `plan session`, `intake session`, `triage session`) from per-command
 * branches in `src/pr-state/cli.ts` into a single typed surface:
 *
 *   argv  →  eventForArgv()  →  actor.send(event)  →  side-effects
 *                                                     (stderr hint, profile build)
 *
 * The machine owns two pieces of behaviour that previously lived as ad-hoc
 * `if`-shims in cli.ts:
 *   1. Aliases-as-data — the `prx session open` ↔ `prx plan session`
 *      equivalence is a one-property tag on the event (`viaAlias: true`).
 *      Adding the next deprecation alias is one line in `eventForArgv` plus
 *      zero changes to the machine.
 *   2. State-as-context-source — the active state value (`plan` / `intake` /
 *      `triage` / `mainx`) is the source of truth for `getCurrentSessionContext()`,
 *      so the future renderer (GH-974 Child 2) can project a different help
 *      overview per session context.
 *
 * The `bootClaude*` actions only *build* the runtime-profile projection into
 * `context.profile`. cli.ts owns the actual exec/spawn so the machine stays
 * pure-ish and free of subprocess-spawning side-effects.
 */

export const SESSION_CONTEXTS = ["mainx", "plan", "intake", "triage", "implement", "submit", "author", "scratch"] as const;
export type SessionContext = (typeof SESSION_CONTEXTS)[number];

export type SessionEntryEvent =
  | {
      type: "OPEN_PLAN_SESSION";
      workUnitId: string;
      viaAlias?: boolean | undefined;
      hasPriorSession?: boolean | undefined;
      planPath?: string | undefined;
      // GH-1661: optional repo context threaded through to `resolveUoW`
      // (and downstream `BdDomainAdapter`). When `cwd` is set the field
      // doubles as the recursion guard for `runRepoRouter` re-dispatch
      // (caller passes the foreign barePath here on the second hop).
      repoCtx?: { repo?: string | undefined; cwd?: string | undefined } | undefined;
      // GH-1421: optional source-registry binding. When `source` is set,
      // canonical-id dispatch consults `[sources.<source>]` in prx.toml
      // outright (pattern-mismatch is an error). When absent, dispatch
      // walks the registry by first-pattern-match.
      sourceCtx?: { source?: string | undefined } | undefined;
      // GH-2014: foreground vs background tmux attach. Default is
      // "foreground" (legacy behaviour); "background" tells the cli
      // handler to skip `attachMuxSession` and print a re-entry hint.
      attachMode?: "foreground" | "background" | undefined;
    }
  | {
      type: "OPEN_INTAKE_SESSION";
      // GH-2380: headless-first axis. Default (absent) → headless SDK;
      // `"interactive"` is the explicit tmux/PTY opt-in.
      interaction?: "headless" | "interactive" | undefined;
    }
  | {
      type: "OPEN_TRIAGE_SESSION";
      // GH-2380: see OPEN_INTAKE_SESSION.
      interaction?: "headless" | "interactive" | undefined;
    }
  | {
      // GH-1900: submit is now work-unit-bound — the session prepares a
      // CAS-backed submit artifact for a specific unit and hands off to
      // `prx submit publish --from-cas <ref>`. Mirrors the author event
      // shape (workUnitId + optional planPath/planBody/hasPriorSession).
      type: "OPEN_SUBMIT_SESSION";
      workUnitId: string;
      hasPriorSession?: boolean | undefined;
      planPath?: string | undefined;
      planBody?: string | undefined;
      // GH-2380: headless-first axis. See OPEN_INTAKE_SESSION.
      interaction?: "headless" | "interactive" | undefined;
    }
  | {
      // GH-1172: dedicated event for `prx implement`. Previously dispatched
      // through OPEN_PLAN_SESSION, which gave the executor a read-only
      // toolset. The implement profile (Edit/Write enabled) is now built
      // here.
      // GH-1238: `planBody` carries the auto-primed draft slot inline into
      // the executor system prompt. Mutually exclusive with `planPath`
      // (which is the GH-1044 explicit-path override).
      type: "OPEN_IMPLEMENT_SESSION";
      workUnitId: string;
      hasPriorSession?: boolean | undefined;
      planPath?: string | undefined;
      planBody?: string | undefined;
      // GH-1421: optional source-registry binding. See OPEN_PLAN_SESSION.
      sourceCtx?: { source?: string | undefined } | undefined;
      // GH-2014: foreground vs background tmux attach. Default is
      // "foreground" (legacy behaviour); "background" tells the cli
      // handler to skip `attachMuxSession` and print a re-entry hint.
      attachMode?: "foreground" | "background" | undefined;
    }
  | {
      // GH-1206: work-unit-bound author session — PR-body authoring profile
      // between `implement` and `prune`. Read+gh-pr-only allowlist
      // (no Edit/Write on source, no `git push`, no `gh pr merge`).
      // `planBody` carries the auto-primed plan slot into the author
      // system prompt; `planPath` is the GH-1044 explicit-path override.
      type: "OPEN_AUTHOR_SESSION";
      workUnitId: string;
      hasPriorSession?: boolean | undefined;
      planPath?: string | undefined;
      planBody?: string | undefined;
      // GH-2380: headless-first axis. See OPEN_INTAKE_SESSION.
      interaction?: "headless" | "interactive" | undefined;
    }
  | {
      // GH-2394: ad-hoc, work-unit-UNBOUND scratch session. Safe by default;
      // `unsafe: true` is the single escape hatch back to ambient authority.
      // `cwd` is the sandbox FS-jail root (the launch dir, resolved at
      // dispatch time). No work-unit binding, no plan injection.
      type: "OPEN_SCRATCH_SESSION";
      cwd: string;
      unsafe?: boolean | undefined;
      hasPriorSession?: boolean | undefined;
    };

export type SessionEntryContext = {
  workUnitId?: string | undefined;
  profile?: RuntimeProfileProjection | undefined;
  emittedAliasHint: boolean;
};

export const initialSessionEntryContext: SessionEntryContext = {
  emittedAliasHint: false,
};

type StderrSink = (line: string) => void;
const defaultStderrSink: StderrSink = (line) => {
  process.stderr.write(`${line}\n`);
};

let stderrSink: StderrSink = defaultStderrSink;

/**
 * Test seam: replaces the stderr writer used by `emitStderrHint` so unit
 * tests can capture hint emission without monkey-patching `process.stderr`.
 * Returns a restore function; call it (or `resetSessionEntryStderr()`) when
 * the test is done.
 */
export function setSessionEntryStderrSink(sink: StderrSink): () => void {
  const previous = stderrSink;
  stderrSink = sink;
  return () => {
    stderrSink = previous;
  };
}

export function resetSessionEntryStderr(): void {
  stderrSink = defaultStderrSink;
}

export const sessionEntryMachine = setup({
  types: {
    context: {} as SessionEntryContext,
    events: {} as SessionEntryEvent,
  },
  actions: {
    emitStderrHint: ({ event }) => {
      if (event.type === "OPEN_PLAN_SESSION" && event.viaAlias) {
        stderrSink(PRX_SESSION_OPEN_ALIAS_HINT);
      }
    },
    markAliasHint: assign({
      emittedAliasHint: ({ event }) =>
        event.type === "OPEN_PLAN_SESSION" && event.viaAlias === true,
    }),
    bootClaudePlan: assign({
      workUnitId: ({ event }) =>
        event.type === "OPEN_PLAN_SESSION" ? event.workUnitId : undefined,
      profile: ({ event }) => {
        if (event.type !== "OPEN_PLAN_SESSION") return undefined;
        // GH-1147: plan profile carries its own work-unit-bound builder with
        // --allowed-tools / --disallowed-tools sourced from SESSION_PROFILES.plan.
        // GH-1044: optional planPath threads through to the system prompt so
        // `prx session open --plan PATH` / `prx implement --plan PATH` open the
        // session pre-instructed to execute the saved plan.
        return buildOpsPlanClaudeRuntimeProfile({
          workUnitId: event.workUnitId,
          hasPriorSession: event.hasPriorSession ?? false,
          planPath: event.planPath,
          attachMode: event.attachMode,
        });
      },
    }),
    // GH-2380: headless-first. The machine is the single source of truth for
    // "(actor, interaction) → profile": the DEFAULT (absent `interaction`) and
    // explicit `"headless"` build the SDK profile; `"interactive"` builds the
    // legacy tmux/PTY profile.
    bootClaudeIntake: assign({
      profile: ({ event }) => {
        if (event.type !== "OPEN_INTAKE_SESSION") return undefined;
        return event.interaction === "interactive"
          ? buildOpsIntakeClaudeRuntimeProfile()
          : buildOpsIntakeSdkRuntimeProfile();
      },
    }),
    bootClaudeTriage: assign({
      profile: ({ event }) => {
        if (event.type !== "OPEN_TRIAGE_SESSION") return undefined;
        return event.interaction === "interactive"
          ? buildOpsTriageClaudeRuntimeProfile()
          : buildOpsTriageSdkRuntimeProfile();
      },
    }),
    bootClaudeSubmit: assign({
      workUnitId: ({ event }) =>
        event.type === "OPEN_SUBMIT_SESSION" ? event.workUnitId : undefined,
      profile: ({ event }) => {
        if (event.type !== "OPEN_SUBMIT_SESSION") return undefined;
        return event.interaction === "interactive"
          ? buildOpsSubmitClaudeRuntimeProfile({
              workUnitId: event.workUnitId,
              hasPriorSession: event.hasPriorSession ?? false,
              planPath: event.planPath,
              planBody: event.planBody,
            })
          : buildOpsSubmitSdkRuntimeProfile({
              workUnitId: event.workUnitId,
              planPath: event.planPath,
              planBody: event.planBody,
            });
      },
    }),
    bootClaudeImplement: assign({
      workUnitId: ({ event }) =>
        event.type === "OPEN_IMPLEMENT_SESSION" ? event.workUnitId : undefined,
      profile: ({ event }) => {
        if (event.type !== "OPEN_IMPLEMENT_SESSION") return undefined;
        return buildOpsImplementClaudeRuntimeProfile({
          workUnitId: event.workUnitId,
          hasPriorSession: event.hasPriorSession ?? false,
          planPath: event.planPath,
          planBody: event.planBody,
          attachMode: event.attachMode,
        });
      },
    }),
    bootClaudeAuthor: assign({
      workUnitId: ({ event }) =>
        event.type === "OPEN_AUTHOR_SESSION" ? event.workUnitId : undefined,
      profile: ({ event }) => {
        if (event.type !== "OPEN_AUTHOR_SESSION") return undefined;
        return event.interaction === "interactive"
          ? buildOpsAuthorClaudeRuntimeProfile({
              workUnitId: event.workUnitId,
              hasPriorSession: event.hasPriorSession ?? false,
              planPath: event.planPath,
              planBody: event.planBody,
            })
          : buildOpsAuthorSdkRuntimeProfile({
              workUnitId: event.workUnitId,
              planPath: event.planPath,
              planBody: event.planBody,
            });
      },
    }),
    bootClaudeScratch: assign({
      // GH-2394: scratch is work-unit-UNBOUND — no workUnitId on context.
      profile: ({ event }) => {
        if (event.type !== "OPEN_SCRATCH_SESSION") return undefined;
        return buildOpsScratchClaudeRuntimeProfile({
          cwd: event.cwd,
          unsafe: event.unsafe ?? false,
          hasPriorSession: event.hasPriorSession ?? false,
        });
      },
    }),
  },
}).createMachine({
  id: "sessionEntry",
  initial: "idle",
  context: initialSessionEntryContext,
  states: {
    idle: {
      on: {
        OPEN_PLAN_SESSION: {
          target: "plan",
          actions: ["emitStderrHint", "markAliasHint", "bootClaudePlan"],
        },
        OPEN_INTAKE_SESSION: {
          target: "intake",
          actions: ["bootClaudeIntake"],
        },
        OPEN_TRIAGE_SESSION: {
          target: "triage",
          actions: ["bootClaudeTriage"],
        },
        OPEN_IMPLEMENT_SESSION: {
          target: "implement",
          actions: ["bootClaudeImplement"],
        },
        OPEN_SUBMIT_SESSION: {
          target: "submit",
          actions: ["bootClaudeSubmit"],
        },
        OPEN_AUTHOR_SESSION: {
          target: "author",
          actions: ["bootClaudeAuthor"],
        },
        OPEN_SCRATCH_SESSION: {
          target: "scratch",
          actions: ["bootClaudeScratch"],
        },
      },
    },
    plan: { type: "final" },
    intake: { type: "final" },
    triage: { type: "final" },
    implement: { type: "final" },
    submit: { type: "final" },
    author: { type: "final" },
    scratch: { type: "final" },
  },
});
