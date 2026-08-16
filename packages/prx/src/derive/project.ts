// GH-1768 — typed projection RawStateV1 + beads-ready + transitions → Facts.
//
// Pure, side-effect-free, deterministic. The projection is the trust
// boundary: every relation passes through its Zod schema in
// `schemas/relations.ts`. Rules never see raw JSON.

import { z } from "zod";

import { type RawStateV1, type WorkflowPhase, derivePhase } from "@bounded-systems/machine-schema";
import { fact, type Fact } from "./engine.ts";
import { factColumns, factSchemas, type FactRelation } from "./schemas/relations.ts";

export type BeadsEntry = {
  id: string;
  open: boolean;
  closed: boolean;
  blockedBy: string[];
};

export type TransitionEntryLite = {
  id: string;
  issueId: string | null;
  fromState: string;
  toState: string;
  actor: string;
  timestamp: string;
};

export type SyntheticInputs = {
  /** Optional actor↔phase eligibility table for the eligibility rule. */
  actorAllowedInPhase?: Array<{ actor: string; phase: string }>;
  /** Speculative cache-scope inputs (rule demo only). */
  scopeOwns?: Array<{ scope: string; tree: string }>;
  changedTree?: Array<{ sha: string; tree: string }>;
};

export type ProjectInput = {
  rawStates: RawStateV1[];
  beads?: BeadsEntry[] | undefined;
  transitions?: TransitionEntryLite[] | undefined;
  synthetic?: SyntheticInputs | undefined;
};

function relationFact<R extends FactRelation>(
  relation: R,
  row: z.infer<(typeof factSchemas)[R]>,
): Fact {
  const parsed = factSchemas[relation].parse(row) as Record<string, unknown>;
  const cols = factColumns[relation] as readonly string[];
  const args = cols.map((c) => parsed[c] as Fact["args"][number]);
  return fact(relation, ...args);
}

export function projectFacts(input: ProjectInput): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  const push = (f: Fact) => {
    const key = `${f.relation}|${f.args.map((a) => JSON.stringify(a)).join("|")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  for (const raw of input.rawStates) {
    const issueId = raw.unitId;
    const branchName = raw.artifacts.branch.name;

    // Always emit a branch row, even when name is null, so null-vs-null
    // equality joins against pr.headRef work natively.
    push(
      relationFact("branch", {
        issueId,
        name: branchName,
        existsLocal: raw.artifacts.branch.existsLocal,
        existsRemote: raw.artifacts.branch.existsRemote,
        headShaLocal: raw.artifacts.branch.headShaLocal,
        headShaRemote: raw.artifacts.branch.headShaRemote,
        ahead: raw.artifacts.branch.ahead,
        behind: raw.artifacts.branch.behind,
      }),
    );

    push(
      relationFact("worktree", {
        issueId,
        exists: raw.artifacts.worktree.exists,
        path: raw.artifacts.worktree.path,
        checkedOutBranch: raw.artifacts.worktree.checkedOutBranch,
        headSha: raw.artifacts.worktree.headSha,
      }),
    );

    push(
      relationFact("pr", {
        issueId,
        exists: raw.artifacts.pr.exists,
        number: raw.artifacts.pr.number,
        state: raw.artifacts.pr.state,
        isDraft: raw.artifacts.pr.isDraft,
        headRef: raw.artifacts.pr.headRef,
        autoMergeEnabled: raw.artifacts.pr.autoMergeRequest != null,
      }),
    );

    push(
      relationFact("ciRun", {
        issueId,
        state: raw.signals.ci.state,
        requiredTotal: raw.signals.ci.requiredTotal,
        requiredPassed: raw.signals.ci.requiredPassed,
      }),
    );

    // Numeric-inequality sentinels for I06/I07 (engine has no
    // arithmetic builtins). Retro-finding.
    if (raw.signals.ci.requiredPassed > raw.signals.ci.requiredTotal) {
      push(relationFact("ci_required_overflow", { issueId }));
    }
    if (
      raw.signals.ci.state === "passed" &&
      raw.signals.ci.requiredPassed !== raw.signals.ci.requiredTotal
    ) {
      push(relationFact("ci_passed_but_incomplete", { issueId }));
    }

    push(
      relationFact("review", {
        issueId,
        decision: raw.signals.review.decision,
        reviewersRequested: raw.signals.review.reviewersRequested,
        unresolvedThreads: raw.signals.review.unresolvedThreads,
      }),
    );

    push(
      relationFact("sync", {
        issueId,
        remoteFresh: raw.sync.remoteFresh,
      }),
    );

    push(
      relationFact("mergeability", {
        issueId,
        state: raw.signals.mergeability.state,
      }),
    );

    const phase: WorkflowPhase = derivePhase(raw);
    push(relationFact("phase", { issueId, phase }));
  }

  for (const bd of input.beads ?? []) {
    push(
      relationFact("issue", {
        id: bd.id,
        open: bd.open,
        closed: bd.closed,
      }),
    );
    for (const to of bd.blockedBy) {
      push(relationFact("blockedBy", { from: bd.id, to }));
    }
  }

  for (const t of input.transitions ?? []) {
    push(
      relationFact("transition", {
        id: t.id,
        issueId: t.issueId,
        fromState: t.fromState,
        toState: t.toState,
        actor: t.actor,
        timestamp: t.timestamp,
      }),
    );
  }

  for (const e of input.synthetic?.actorAllowedInPhase ?? []) {
    push(relationFact("actorAllowedInPhase", e));
  }
  for (const e of input.synthetic?.scopeOwns ?? []) {
    push(relationFact("scopeOwns", e));
  }
  for (const e of input.synthetic?.changedTree ?? []) {
    push(relationFact("changedTree", e));
  }

  return out;
}
