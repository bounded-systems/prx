/**
 * Back-compat shim — the canonical home is `src/issues/resolver.ts`. This
 * file kept its original surface (`resolveIntakeViewId`, `IntakeViewError`,
 * `IntakeViewResolvedId`) so existing intake call sites and tests don't move.
 *
 * GH-1186 promoted the resolver to `src/issues/` so plan-side and triage-side
 * read verbs share a single parser instead of forking copies.
 */

import {
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

// Live re-export binding (not an eager `const X = IssueResolveError`): a value
// alias evaluated at module-init time is a TDZ hazard inside the
// resolver ↔ intake-id import cycle — `export { … as … } from` is resolved
// lazily, so it stays safe regardless of module evaluation order (GH-296).
export { IssueResolveError as IntakeViewError } from "../issues/resolver.ts";

export type IntakeViewResolvedId = IssueResolvedId;

export function resolveIntakeViewId(raw: string): IntakeViewResolvedId {
  return resolveIssueId(raw, "prx intake view");
}
