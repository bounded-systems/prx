// GH-1239: planner-side preflight — fail-fast guard before drafting.
//
// Three axes, all deterministic, all read-only, no Claude spawn:
//
//   1. already-done — does the artifact already exist? (file / comment / body /
//      issue-state / PR)
//   2. allowlist-feasibility — can the executor profile actually perform every
//      declared action shape? Same predicate as the in-session gate
//      (`isFeasibleForRole` in src/tools/policy.ts) — refusal symmetry.
//   3. blocked-by-open-deps — does the bd dep graph or the issue body cite a
//      still-open blocker?
//
// Every external call routes through an injected CommandRunner so the unit
// tests stay DI-only (test_isolation_di_only memory). Production callers pass
// `defaultRunner`; the auto-step wires the same runner the rest of the
// session-entry path uses.

import { adapterForCanonicalId } from "../adapters/domain-adapter.ts";
import {
  defaultRunner,
  effectiveCanonicalIdPattern,
  loadIdentityConfig,
  type CommandRunner,
} from "../pr-state/github.ts";
import { resolverForCanonicalId } from "../pr-state/resolvers/dispatch.ts";
import {
  findOwningRoles,
  isFeasibleForRole,
  type FeasibilityResult,
  type PolicyState,
  type PolicyRole,
  type PolicyTool,
} from "@bounded-systems/policy";
import {
  getSessionProfile,
  SESSION_PROFILES,
  type SessionProfileName,
} from "../machine/runtime_profiles.ts";
import { detectIntakeTypeFromIssue } from "./intake_type_detect.ts";
import {
  type ExtractAllResult,
  type DeliverableTarget,
  type PlannedAction,
  extractAll,
} from "./preflight_extract.ts";
import {
  type ActionPerspective,
  type PreflightFinding,
  type PreflightResult,
  type PreflightStatus,
} from "./preflight_schema.ts";

export type RunPlanPreflightInput = {
  unit: string;
  // The session profile the planner is drafting *for* — defaults to
  // "implement" because preflight's job is to refuse plans the executor
  // cannot then carry out.
  targetProfile?: SessionProfileName;
  // Override the cwd the runner uses for repo-scoped commands. Defaults to
  // process.cwd(); tests pass a fixture path.
  cwd?: string;
  // GH-1579: which role the action-feasibility axis evaluates against.
  // Defaults to "executor" because preflight's job is to refuse plans the
  // executor cannot then carry out. Test-only override — the CLI auto-step
  // intentionally does NOT wire this to `PRX_AGENT_ROLE`, which would silently
  // widen the executor's refusal surface.
  currentRole?: PolicyRole;
};

export type RunPlanPreflightDeps = {
  runner?: CommandRunner;
  // GH-1422: overlay-aware non-GH dispatch. Default to the production
  // helpers; tests inject stubs to exercise the matched-with-resolver,
  // matched-without-resolver, and no-match branches without touching disk.
  loadIdentityConfig?: typeof loadIdentityConfig;
  buildResolver?: typeof resolverForCanonicalId;
};

const PARSE_GH_ISSUE_NUMBER = /^GH-(\d+)$/;

function parseUnitToIssueNumber(unit: string): number | null {
  const m = unit.match(PARSE_GH_ISSUE_NUMBER);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

type IssueViewLabel = { name?: string | null };

type IssueViewResult = {
  number: number;
  title: string;
  state: "open" | "closed" | string;
  body: string;
  comments: Array<{ author?: { login?: string } | null; body?: string }>;
  labels: IssueViewLabel[];
};

function readIssueView(
  runner: CommandRunner,
  cwd: string,
  issue: number,
): IssueViewResult | null {
  const res = runner(
    [
      "gh",
      "issue",
      "view",
      String(issue),
      "--json",
      "number,title,state,body,comments,labels",
    ],
    { cwd, check: false },
  );
  if (res.status !== 0) return null;
  const stdout = res.stdout.trim();
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as Partial<IssueViewResult>;
    if (
      typeof parsed.number !== "number" ||
      typeof parsed.title !== "string" ||
      typeof parsed.state !== "string"
    ) {
      return null;
    }
    return {
      number: parsed.number,
      title: parsed.title,
      state: (parsed.state as string).toLowerCase(),
      body: typeof parsed.body === "string" ? parsed.body : "",
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      labels: Array.isArray(parsed.labels) ? (parsed.labels as IssueViewLabel[]) : [],
    };
  } catch {
    return null;
  }
}

function readPrView(
  runner: CommandRunner,
  cwd: string,
  pr: number,
): { state: string; mergedAt: string | null } | null {
  const res = runner(
    ["gh", "pr", "view", String(pr), "--json", "state,mergedAt"],
    { cwd, check: false },
  );
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { state?: string; mergedAt?: string | null };
    if (typeof parsed.state !== "string") return null;
    return {
      state: parsed.state,
      mergedAt: typeof parsed.mergedAt === "string" ? parsed.mergedAt : null,
    };
  } catch {
    return null;
  }
}

function fileTracked(
  runner: CommandRunner,
  cwd: string,
  path: string,
): boolean {
  const res = runner(["git", "ls-files", "--error-unmatch", path], {
    cwd,
    check: false,
  });
  return res.status === 0;
}

// Axis 1 — does each declared deliverable already have its artifact landed?
// GH-1516: only `create` and `unknown` file mentions count — `reference`
// (cited path, parenthetical) and `modify` (path the planner will edit, not
// produce) are suppressed because file-existence is a *prerequisite* for those
// shapes, not a satisfaction signal. This is the bleed-stop fix for
// GH-1514 / GH-1515 / GH-1548.
function checkAlreadyDone(
  deliverables: DeliverableTarget[],
  runner: CommandRunner,
  cwd: string,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const d of deliverables) {
    if (d.shape === "file") {
      if (d.context !== "create" && d.context !== "unknown") continue;
      if (fileTracked(runner, cwd, d.path)) {
        const finding: PreflightFinding = {
          axis: "already-done",
          shape: "file",
          target: d.path,
        };
        // Only carry the context onto the finding when it is meaningfully
        // determined — preserves the pre-GH-1516 wire shape for callers that
        // compare against `{axis, shape, target}` exactly.
        if (d.context !== "unknown") {
          (finding as PreflightFinding & { governingContext?: string }).governingContext = d.context;
        }
        findings.push(finding);
      }
      continue;
    }
    if (d.shape === "issue-state") {
      const view = readIssueView(runner, cwd, d.issue);
      if (view && view.state === "closed" && d.targetState === "closed") {
        findings.push({
          axis: "already-done",
          shape: "issue-state",
          target: `GH-${d.issue}`,
          detail: `state=closed`,
        });
      }
      continue;
    }
    if (d.shape === "pr-merge") {
      const view = readPrView(runner, cwd, d.pr);
      if (view && view.state.toLowerCase() === "merged" && view.mergedAt) {
        findings.push({
          axis: "already-done",
          shape: "pr-merge",
          target: `#${d.pr}`,
          detail: `merged at ${view.mergedAt}`,
        });
      }
      continue;
    }
    // issue-comment / issue-body — we cannot know what content the planner
    // intends to post, so we only flag the strict subset where the issue
    // already has the canonical anchor or has been closed (a hard signal
    // that the comment/body update happened). Conservative on purpose:
    // false-positives here would block real follow-up work.
  }
  return findings;
}

type ProfileLite = {
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
};

// `Bash(...)` allowlist entries are matched literally against the tool head
// in the action shape. We keep the comparison surface narrow because the
// in-session gate already enforces full glob semantics; the preflight only
// needs the conservative "does the head appear in the disallow list" check.
function disallowedByProfile(
  profile: ProfileLite,
  toolHead: string,
): boolean {
  for (const entry of profile.disallowedTools) {
    if (entry === toolHead) return true;
    // Match `Bash(<head>:*)` and `Bash(<head> --flag:*)` shapes.
    if (entry.startsWith("Bash(") && entry.endsWith(":*)")) {
      const inner = entry.slice("Bash(".length, -":*)".length);
      if (toolHead === inner || toolHead.startsWith(`${inner} `)) return true;
    }
  }
  return false;
}

function allowedByProfile(profile: ProfileLite, toolName: string): boolean {
  return profile.allowedTools.includes(toolName);
}

function actionFinding(
  shape: PlannedAction["shape"],
  subcommand: string,
  reason: "blocked" | "not-allowlisted-for-role" | "disallowed-by-profile" | "unknown-tool",
  detail?: string,
): PreflightFinding {
  return {
    axis: "infeasible-action",
    shape: shape === "edit" ? "edit" : shape === "write" ? "write" : shape,
    subcommand,
    reason,
    detail,
  };
}

// GH-1579: best-effort mapping from a tool head (`bd update`, `gh issue
// create`, `git push`) to the session profile(s) whose allowedTools include
// the bare `Bash(<head>:*)` glob. Flag-narrowed entries (e.g.
// `Bash(bd update --status:*)`) are intentionally ignored — the profile-name
// hint should only fire for unambiguous head-level grants.
// GH-2394: the unblock-hint mapping is over the six lifecycle session
// profiles. Scratch is excluded — it is the most-restricted profile
// (Read/Grep/Glob + `prx:*` only) and work-unit-UNBOUND, so it is never a
// meaningful "go run the blocked action in this profile" target. Narrowing to
// this subset keeps the `owningProfiles` schema enum (preflight_schema.ts) as
// the six lifecycle names without widening it.
type UnblockProfileName = Exclude<SessionProfileName, "scratch">;

function findOwningProfiles(toolHead: string): UnblockProfileName[] {
  const out: UnblockProfileName[] = [];
  const needle = `Bash(${toolHead}:*)`;
  for (const [name, prof] of Object.entries(SESSION_PROFILES)) {
    if (name === "scratch") continue;
    if (prof.allowedTools.includes(needle)) {
      out.push(name as UnblockProfileName);
    }
  }
  return out;
}

// GH-1579: canonical entry verb for each session profile. Only consulted when
// exactly one profile matches — ambiguous matches drop the hint rather than
// pick arbitrarily.
const PROFILE_UNBLOCK_HINT: Record<UnblockProfileName, string> = {
  plan: "prx plan session",
  intake: "prx intake agent",
  triage: "prx triage agent",
  implement: "prx implement agent <GH-N>",
  submit: "prx submit agent <GH-N>",
  author: "prx author agent <GH-N>",
};

function toolHeadFor(
  shape: PlannedAction["shape"],
  subcommand: string,
): string {
  if (shape === "git") return `git ${subcommand}`;
  if (shape === "gh-issue") return `gh issue ${subcommand}`;
  if (shape === "gh-pr") return `gh pr ${subcommand}`;
  if (shape === "bd") return `bd ${subcommand}`;
  return subcommand;
}

function deferredFinding(
  shape: PlannedAction["shape"],
  subcommand: string,
  owningRoles: PolicyRole[],
  owningProfiles: UnblockProfileName[],
): PreflightFinding {
  const finding: PreflightFinding = {
    axis: "action-deferred-to-other-role",
    shape: shape === "edit" ? "edit" : shape === "write" ? "write" : shape,
    subcommand,
    owningRoles,
  };
  if (owningProfiles.length > 0) {
    finding.owningProfiles = owningProfiles;
  }
  if (owningProfiles.length === 1) {
    finding.suggestedUnblock = PROFILE_UNBLOCK_HINT[owningProfiles[0]!];
  }
  return finding;
}

// GH-1516: advisory finding for actions whose section-derived perspective is
// `executor-later` but the current role is not `executor` — the planner is
// describing what the executor will run, not committing to run it now. Does
// NOT contribute to refusal flags. Distinct from `action-deferred-to-other-
// role` (GH-1579): that variant fires when another role at this state can run
// the verb; this variant fires when the *section* declares the verb is
// executor-time prose.
function perspectiveMismatchFinding(
  shape: PlannedAction["shape"],
  subcommand: string,
  perspective: ActionPerspective,
  currentRole: PolicyRole,
  section: string | undefined,
  reason: "blocked" | "not-allowlisted-for-role" | "disallowed-by-profile" | "unknown-tool",
): PreflightFinding {
  const finding: PreflightFinding = {
    axis: "action-perspective-mismatch",
    shape: shape === "edit" ? "edit" : shape === "write" ? "write" : shape,
    subcommand,
    perspective,
    currentRole,
    detail: `${reason} for ${currentRole}; described as executor-later prose`,
  };
  if (section) finding.section = section;
  return finding;
}

// GH-1579: shared classifier for a non-feasible (tool, sub, state, role)
// verdict. `blocked` is always a real refusal. Otherwise, if any other role
// at this state owns the subcommand, demote to an informational deferred
// finding pointing at the owning role/profile. Only when no role anywhere
// can run the action do we fall back to an `infeasible-action` refusal.
//
// GH-1832: defense-in-depth safety net for phantom verbs that slip past the
// extraction-time vocabulary filter (callers that bypass extractPlannedActions,
// future regressions). If no role anywhere can run the subcommand AND the
// reason is just "not-allowlisted-for-role" (i.e. not BLOCKED), the verb is
// almost certainly noun-as-verb prose ("bd records", "gh issues") — demote to
// a non-fatal `warning` finding so the session is not refused.
function classifyInfeasible(
  tool: PolicyTool,
  shape: PlannedAction["shape"],
  subcommand: string,
  state: PolicyState,
  currentRole: PolicyRole,
  verdict: FeasibilityResult & { feasible: false },
  perspective: ActionPerspective = "unknown",
  section: string | undefined = undefined,
): { finding: PreflightFinding; deferred: boolean; mismatched: boolean } {
  // GH-1516: when the mention sits in an `## Approach` / `## Implementation`
  // section AND the current role is not the executor, the planner is
  // describing future executor work — not committing to run it now. Demote
  // to an advisory perspective-mismatch finding so the gate does not refuse
  // a healthy plan ticket. This applies BEFORE the blocked check so executor-
  // time uses of BLOCKED verbs (`git remote get-url`, `git rev-parse --git-
  // common-dir`) in `## Approach` prose don't refuse planner entry — the
  // executor will be the role that eventually runs them.
  if (perspective === "executor-later" && currentRole !== "executor") {
    return {
      finding: perspectiveMismatchFinding(
        shape,
        subcommand,
        perspective,
        currentRole,
        section,
        verdict.reason,
      ),
      deferred: false,
      mismatched: true,
    };
  }
  if (verdict.reason === "blocked") {
    return { finding: actionFinding(shape, subcommand, "blocked"), deferred: false, mismatched: false };
  }
  const owning = findOwningRoles(tool, subcommand, state);
  if (owning.length > 0 && !owning.includes(currentRole)) {
    const profiles = findOwningProfiles(toolHeadFor(shape, subcommand));
    return {
      finding: deferredFinding(shape, subcommand, owning, profiles),
      deferred: true,
      mismatched: false,
    };
  }
  if (owning.length === 0 && verdict.reason === "not-allowlisted-for-role") {
    const finding: PreflightFinding = {
      axis: "warning",
      message: `unrecognized subcommand '${toolHeadFor(shape, subcommand)}' — not in any role's allowlist; ignoring as likely noun-as-verb prose`,
    };
    return { finding, deferred: false, mismatched: false };
  }
  return { finding: actionFinding(shape, subcommand, verdict.reason), deferred: false, mismatched: false };
}

// Axis 2 — collapse each declared action into the (tool, subcommand) pair the
// in-session gate would receive, then run isFeasibleForRole. Edit/Write are
// gated by profile membership only (no policy table — they are pure local
// writes).
//
// GH-1579: refusals owned by a different role at this state demote to an
// informational `action-deferred-to-other-role` finding. The profile-disallow
// check is skipped on the deferred path because the operator-visible hint is
// already "run this in another profile" — adding a second refusal for the
// same action just creates noise.
export function checkActionFeasibility(
  actions: PlannedAction[],
  profile: ProfileLite,
  state: PolicyState,
  role: PolicyRole,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const dispatch = (
    tool: PolicyTool,
    shape: PlannedAction["shape"],
    subcommand: string,
    profileHead: string,
    perspective: ActionPerspective,
    section: string | undefined,
  ): void => {
    const verdict = isFeasibleForRole(tool, subcommand, state, role);
    if (!verdict.feasible) {
      const classified = classifyInfeasible(
        tool,
        shape,
        subcommand,
        state,
        role,
        verdict,
        perspective,
        section,
      );
      findings.push(classified.finding);
      return;
    }
    if (disallowedByProfile(profile, profileHead)) {
      // GH-1516: a role-feasible verb that the profile disallows can still be
      // executor-time prose in an `## Approach`-style section under a non-
      // executor role — the planner describing future work, not committing to
      // run it now. Demote to the same advisory the role-infeasible path uses
      // (classifyInfeasible) instead of refusing the planner session. Surfaced
      // by ai-home-d39ug/GH-1899: blanket `Bash(git:*)` in the implement
      // profile made read verbs like `git rev-parse` disallowed-by-profile,
      // exposing this branch's missing perspective demotion.
      if (perspective === "executor-later" && role !== "executor") {
        findings.push(
          perspectiveMismatchFinding(shape, subcommand, perspective, role, section, "disallowed-by-profile"),
        );
      } else {
        findings.push(actionFinding(shape, subcommand, "disallowed-by-profile"));
      }
    }
  };
  for (const action of actions) {
    // GH-1516: mention-shaped actions carry perspective + section. The
    // synthetic-PlannedAction callers (GH-1832 Layer 2 test) don't always set
    // these explicitly; default to `unknown` perspective so the demotion
    // branch never fires for hand-constructed inputs.
    const perspective: ActionPerspective =
      (action as { perspective?: ActionPerspective }).perspective ?? "unknown";
    const section: string | undefined =
      (action as { section?: string }).section;
    if (action.shape === "edit" || action.shape === "write") {
      const toolName = action.shape === "edit" ? "Edit" : "Write";
      if (!allowedByProfile(profile, toolName)) {
        findings.push(
          actionFinding(
            action.shape,
            toolName,
            "disallowed-by-profile",
            `tool '${toolName}' not in profile.allowedTools`,
          ),
        );
      }
      continue;
    }
    if (action.shape === "git") {
      dispatch("git", "git", action.subcommand, `git ${action.subcommand}`, perspective, section);
      continue;
    }
    if (action.shape === "gh-issue") {
      dispatch("gh", "gh-issue", action.subcommand, `gh issue ${action.subcommand}`, perspective, section);
      continue;
    }
    if (action.shape === "gh-pr") {
      dispatch("gh", "gh-pr", action.subcommand, `gh pr ${action.subcommand}`, perspective, section);
      continue;
    }
    if (action.shape === "bd") {
      dispatch("bd", "bd", action.subcommand, `bd ${action.subcommand}`, perspective, section);
    }
  }
  return findings;
}

// Axis 3 — for each blocker reference, query the issue and refuse if it is
// still open. Unresolvable refs (404, parse failure) downgrade to a warning.
function checkOpenBlockers(
  blockerNumbers: number[],
  runner: CommandRunner,
  cwd: string,
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const issue of blockerNumbers) {
    const view = readIssueView(runner, cwd, issue);
    if (!view) {
      findings.push({
        axis: "warning",
        message: `could not resolve blocker reference #${issue} — skipping`,
      });
      continue;
    }
    if (view.state === "open") {
      findings.push({
        axis: "infeasible-blocker",
        issue,
        title: view.title,
        source: "issue-body",
      });
    }
  }
  return findings;
}

function deriveStatus(
  extractedDeliverables: number,
  alreadyDone: number,
  hasInfeasibleAction: boolean,
  hasInfeasibleBlocker: boolean,
): PreflightStatus {
  const failureFlags = [
    alreadyDone > 0 && alreadyDone === extractedDeliverables && extractedDeliverables > 0,
    alreadyDone > 0 && alreadyDone < extractedDeliverables,
    hasInfeasibleAction,
    hasInfeasibleBlocker,
  ];
  const failures = failureFlags.filter(Boolean).length;
  if (failures === 0) {
    if (extractedDeliverables === 0) {
      // Nothing to verify; treat as pass. The conservative extractor under-
      // matches more often than not, so emitting `extraction-empty` would
      // turn ordinary plans into red-banner refusals.
      return "pass";
    }
    return "pass";
  }
  if (failures > 1) return "mixed-failure";
  if (alreadyDone > 0 && alreadyDone === extractedDeliverables) return "already-done";
  if (alreadyDone > 0) return "partially-done";
  if (hasInfeasibleAction) return "infeasible-action";
  return "infeasible-blocker";
}

export async function runPlanPreflight(
  input: RunPlanPreflightInput,
  deps: RunPlanPreflightDeps = {},
): Promise<PreflightResult> {
  const runner = deps.runner ?? defaultRunner;
  const cwd = input.cwd ?? process.cwd();
  const targetProfileName: SessionProfileName = input.targetProfile ?? "implement";
  const targetProfile = getSessionProfile(targetProfileName);

  let body: string;
  let issueNumber: number | undefined;
  let intakeType: ReturnType<typeof detectIntakeTypeFromIssue>;

  const ghIssue = parseUnitToIssueNumber(input.unit);
  if (ghIssue !== null) {
    const view = readIssueView(runner, cwd, ghIssue);
    if (!view) {
      throw new Error(
        `plan preflight: could not resolve ${input.unit} via gh issue view`,
      );
    }
    body = view.body;
    issueNumber = ghIssue;
    intakeType = detectIntakeTypeFromIssue(view.labels, view.title);
  } else {
    // GH-1422: overlay-aware dispatch. Mirror the `check-issue` precedent at
    // src/pr-state/cli.ts so non-GH canonical ids resolve through the
    // identity overlay instead of getting bounced at an upfront GH-only gate.
    // GH-1421: gate now consults the `[sources.*]` registry — pattern union
    // across declared sources, or the GH default when the registry is empty.
    const loadConfig = deps.loadIdentityConfig ?? loadIdentityConfig;
    const buildResolver = deps.buildResolver ?? resolverForCanonicalId;
    const identityConfig = loadConfig(cwd, runner);
    const effectivePattern = effectiveCanonicalIdPattern(identityConfig);
    // GH-2089: mirror the CLI canonical-id gate's adapter fall-through
    // (parseCanonicalWorkUnitId in src/pr-state/cli.ts). The static effective
    // pattern cannot encode cwd-dependent surface ids — BD's bare-workspace
    // arm reads `bd_workspace_prefix` from `.prx/repos/index.json`. Gate on
    // `isDefault` so a per-repo `[sources.<name>]` overlay still wins outright.
    const matchedAdapter = identityConfig.isDefault
      ? adapterForCanonicalId(input.unit.trim())
      : null;
    if (!effectivePattern.test(input.unit) && matchedAdapter === null) {
      const sourceNames = Object.keys(identityConfig.sources);
      throw new Error(
        `plan preflight: unit must match canonical_id_pattern (got ${JSON.stringify(input.unit)}); active identity config accepts /${effectivePattern.source}/. Configured sources: ${sourceNames.join(", ")}.`,
      );
    }
    const resolver = buildResolver(input.unit, identityConfig, cwd);
    if (!resolver) {
      throw new Error(
        `plan preflight: ${input.unit} matches canonical_id_pattern but no resolver is wired. Add a [sources.<name>] block to the active overlay or run \`prx plan session ${input.unit} --create --source=<name>\` (GH-1421).`,
      );
    }
    const resolved = await resolver.fetch(input.unit, { runner });
    body = resolved.body ?? "";
    issueNumber = undefined;
    // Non-GH resolvers don't carry GH labels; intake-type detection
    // degrades to title-prefix only and returns null when nothing matches.
    intakeType = detectIntakeTypeFromIssue(null, resolved.title);
  }

  const extracted: ExtractAllResult = extractAll(
    body,
    issueNumber,
    intakeType ?? undefined,
  );

  const alreadyDoneFindings = checkAlreadyDone(
    extracted.deliverables,
    runner,
    cwd,
  );

  // The executor profile drives axis-2 by default. The implement profile is
  // bound to (planning, executor) once it enters the executor session; the
  // policy table is keyed there. GH-1579: `currentRole` overrides the
  // axis-2 role for tests; production defaults to "executor" (intentionally
  // not wired to PRX_AGENT_ROLE from the CLI).
  const currentRole: PolicyRole = input.currentRole ?? "executor";
  const actionFindings = checkActionFeasibility(
    extracted.actions,
    {
      allowedTools: targetProfile.allowedTools,
      disallowedTools: targetProfile.disallowedTools,
    },
    "planning",
    currentRole,
  );

  const blockerFindings = checkOpenBlockers(
    extracted.blockers.map((b) => b.issue),
    runner,
    cwd,
  );

  const findings: PreflightFinding[] = [
    ...alreadyDoneFindings,
    ...actionFindings,
    ...blockerFindings,
  ];

  const infeasibleActions = actionFindings.filter(
    (f) => f.axis === "infeasible-action",
  ).length;
  const deferredActions = actionFindings.filter(
    (f) => f.axis === "action-deferred-to-other-role",
  ).length;
  const mismatchedActions = actionFindings.filter(
    (f) => f.axis === "action-perspective-mismatch",
  ).length;
  const counts = {
    deliverablesExtracted: extracted.deliverables.length,
    deliverablesAlreadyDone: alreadyDoneFindings.length,
    actionsExtracted: extracted.actions.length,
    // GH-1579: only un-demotable refusals count as infeasible. Deferred
    // findings are informational and carried separately below.
    actionsInfeasible: infeasibleActions,
    actionsDeferredToOtherRole: deferredActions,
    // GH-1516: actions whose section-derived perspective is `executor-later`
    // under a non-executor role. Advisory — does not contribute to refusal.
    actionsPerspectiveMismatched: mismatchedActions,
    blockersExtracted: extracted.blockers.length,
    blockersOpen: blockerFindings.filter((f) => f.axis === "infeasible-blocker").length,
  };

  const status = deriveStatus(
    counts.deliverablesExtracted,
    counts.deliverablesAlreadyDone,
    counts.actionsInfeasible > 0,
    counts.blockersOpen > 0,
  );

  return {
    unit: input.unit,
    status,
    findings,
    counts,
  };
}

// CLI plain-format renderer. JSON format prints the result verbatim from the
// schema; this function handles the human-readable output the planner sees
// in their terminal when preflight refuses.
export function formatPreflightPlain(result: PreflightResult): string {
  const lines: string[] = [];
  lines.push(`unit:   ${result.unit}`);
  lines.push(`status: ${result.status}`);
  const deferred = result.counts.actionsDeferredToOtherRole;
  const mismatched = result.counts.actionsPerspectiveMismatched;
  const axesParts = [
    `deliverables=${result.counts.deliverablesAlreadyDone}/${result.counts.deliverablesExtracted}`,
    `actions=${result.counts.actionsInfeasible}/${result.counts.actionsExtracted}`,
  ];
  // GH-1579: only render the deferred axis when something demoted, so the
  // pre-1579 axes line stays unchanged for unaffected runs.
  if (deferred > 0) axesParts.push(`deferred=${deferred}`);
  // GH-1516: render perspective-mismatched count only when non-zero so the
  // axes line stays unchanged for runs that don't trigger the new axis.
  if (mismatched > 0) axesParts.push(`perspective-mismatched=${mismatched}`);
  axesParts.push(
    `blockers=${result.counts.blockersOpen}/${result.counts.blockersExtracted}`,
  );
  lines.push(`axes:   ${axesParts.join(" ")}`);
  if (result.findings.length === 0) {
    lines.push("findings: none — safe to draft");
    return lines.join("\n");
  }
  lines.push("findings:");
  for (const f of result.findings) {
    if (f.axis === "already-done") {
      lines.push(
        `  - already-done [${f.shape}]: ${f.target}${f.detail ? ` (${f.detail})` : ""}`,
      );
      continue;
    }
    if (f.axis === "infeasible-action") {
      lines.push(
        `  - infeasible-action [${f.shape}]: ${f.subcommand} (${f.reason}${f.detail ? `: ${f.detail}` : ""})`,
      );
      continue;
    }
    if (f.axis === "action-deferred-to-other-role") {
      const rolePart = `owned by role(s) '${f.owningRoles.join(", ")}'`;
      const profilePart = f.owningProfiles && f.owningProfiles.length > 0
        ? ` / profile(s) '${f.owningProfiles.join(", ")}'`
        : "";
      const hint = f.suggestedUnblock ? ` (run \`${f.suggestedUnblock}\` first)` : "";
      lines.push(
        `  - deferred-to-other-role [${f.shape}]: ${f.subcommand} — ${rolePart}${profilePart}${hint}`,
      );
      continue;
    }
    if (f.axis === "action-perspective-mismatch") {
      const sectionPart = f.section ? ` in ## ${f.section}` : "";
      lines.push(
        `  - perspective-mismatch [${f.shape}]: ${f.subcommand} — described as ${f.perspective}${sectionPart}; ${f.currentRole} not refusing`,
      );
      continue;
    }
    if (f.axis === "infeasible-blocker") {
      lines.push(
        `  - infeasible-blocker: #${f.issue}${f.title ? ` (${f.title})` : ""}`,
      );
      continue;
    }
    lines.push(`  - warning: ${f.message}`);
  }
  return lines.join("\n");
}
