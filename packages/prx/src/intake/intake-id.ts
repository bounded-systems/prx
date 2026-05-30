/**
 * Back-compat shim — the canonical home is `src/issues/resolver.ts`. This
 * file kept its original surface (`resolveIntakeViewId`, `IntakeViewError`,
 * `IntakeViewResolvedId`) so existing intake call sites and tests don't move.
 *
 * GH-1186 promoted the resolver to `src/issues/` so plan-side and triage-side
 * read verbs share a single parser instead of forking copies.
 */

import {
  IssueResolveError,
  resolveIssueId,
  type IssueResolvedId,
} from "../issues/resolver.ts";

export {
  EXTERNAL_REF_ISSUE_RE,
  GH_PREFIX_RE,
  HASH_NUMBER_RE,
  BARE_NUMBER_RE,
  GH_ISSUE_URL_RE,
  FORBIDDEN_INPUT_RE,
} from "../issues/resolver.ts";

export type IntakeViewResolvedId = IssueResolvedId;

export const IntakeViewError = IssueResolveError;
export type IntakeViewError = IssueResolveError;

export function resolveIntakeViewId(raw: string): IntakeViewResolvedId {
  return resolveIssueId(raw, "prx intake view");
}
