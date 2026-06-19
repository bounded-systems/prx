/**
 * Shared id resolver for issue read verbs (`prx intake view`, `prx intake
 * merge`, `prx plan view`, `prx plan search`, future `prx triage view`).
 *
 * Accepts GH-N / #N / bare integer / GitHub URL forms (canonical "gh"),
 * Notion page UUIDs and configured Task-IDs (canonical "notion"), and
 * falls through to a bd id catch-all. Rejects shell metacharacters and
 * empty input early so downstream callers never have to revalidate.
 *
 * Originally lived under `src/intake/intake-id.ts`; promoted to `src/issues/`
 * so plan-side and triage-side read verbs share the same parser without
 * forking a copy. GH-874 extended the discriminated union with a Notion arm
 * so issue-read verbs route to `runScoutNotion` for Notion-shaped ids.
 */

import { localWorkspacePrefixForCwd } from "../pr-state/repos.ts";
import {
  detectNotionId,
  NOTION_UUID_RE,
  TASK_ID_SHAPE_RE,
  ScoutNotionError,
  type DetectedNotionId,
} from "../scout/notion.ts";

export type IssueResolvedId =
  | { kind: "gh"; number: number; repo?: string }
  | { kind: "notion"; id: DetectedNotionId }
  | { kind: "bd"; id: string };

export const GH_PREFIX_RE = /^GH-(\d+)$/i;
export const HASH_NUMBER_RE = /^#(\d+)$/;
export const BARE_NUMBER_RE = /^\d+$/;
export const GH_ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?(?:[?#].*)?$/;
// Matches the trailing `/issues/<n>` segment with optional query/fragment
// (e.g. `…/issues/123?source=…` or `…/issues/123#comment-1`). Aligns with
// `extractIssueNumber` in `src/issues/dedupe.ts` so external_ref strings
// emitted by GitHub link helpers parse cleanly. Prefer that helper for new
// callers; this is kept for callers that already have a regex shape.
export const EXTERNAL_REF_ISSUE_RE = /\/issues\/(\d+)(?:[/?#].*)?$/;

// Reject inputs that contain shell metacharacters or whitespace — bd ids and
// GH ids are well-formed strings, so anything with a space, quote, redirect,
// or pipe is operator error and should fail early instead of being routed to
// bd as a "look-alike" id. GH URLs are exempted (matched before this check)
// so `?foo=1&bar=2` query strings don't trip the `&`/`?` rejection.
export const FORBIDDEN_INPUT_RE = /[\s"'`$()<>|;&\\]/;

export class IssueResolveError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "IssueResolveError";
    this.exitCode = exitCode;
  }
}

export function resolveIssueId(
  raw: string,
  verbLabel = "prx issue",
  notionCanonicalPattern?: RegExp,
): IssueResolvedId {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new IssueResolveError(`${verbLabel}: id must not be empty`);
  }

  // Match well-formed GH issue URLs *before* the forbidden-char check: legal
  // GH URLs may include `?foo=1&bar=2` query strings, and `&` is in the
  // forbidden set for bd ids. The URL regex anchors both ends, so anything
  // matching here is a real URL — not a smuggled shell expression.
  const urlMatch = trimmed.match(GH_ISSUE_URL_RE);
  if (urlMatch) {
    return {
      kind: "gh",
      number: Number.parseInt(urlMatch[3]!, 10),
      repo: `${urlMatch[1]!}/${urlMatch[2]!}`,
    };
  }

  if (FORBIDDEN_INPUT_RE.test(trimmed)) {
    throw new IssueResolveError(`${verbLabel}: id contains invalid characters: ${raw}`);
  }

  const ghMatch = trimmed.match(GH_PREFIX_RE);
  if (ghMatch) {
    return { kind: "gh", number: Number.parseInt(ghMatch[1]!, 10) };
  }

  const hashMatch = trimmed.match(HASH_NUMBER_RE);
  if (hashMatch) {
    return { kind: "gh", number: Number.parseInt(hashMatch[1]!, 10) };
  }

  if (BARE_NUMBER_RE.test(trimmed)) {
    return { kind: "gh", number: Number.parseInt(trimmed, 10) };
  }

  // GH-874: Notion arm runs after GH-prefix matches because the Task-ID
  // shape `[A-Z][A-Z0-9]+-\d+` also matches `GH-123`. bd surface ids
  // (`BD-<8hex>` short form) carry hex letters in the tail so they fall
  // through to the bd catch-all below. Shape-check inline so a malformed
  // canonical-pattern *Task-ID* (input looked Notion-shaped but failed the
  // operator's configured pattern) surfaces as an error instead of silently
  // routing to bd.
  if (NOTION_UUID_RE.test(trimmed) || TASK_ID_SHAPE_RE.test(trimmed)) {
    try {
      const detected = detectNotionId(trimmed, notionCanonicalPattern);
      return { kind: "notion", id: detected };
    } catch (err) {
      if (err instanceof ScoutNotionError) {
        throw new IssueResolveError(`${verbLabel}: ${err.message}`);
      }
      throw err;
    }
  }

  return { kind: "bd", id: trimmed };
}

/**
 * GH-1766: capture the 8-hex tail of a `BD-`-prefixed surface id (short or
 * long). Returns the tail in lowercase, or `null` when the input does not end
 * in an 8-hex group (e.g. semantic-id workspaces like `pin.9.4.2`). Internal
 * helper used by {@link normalizeToBdSurfaceShort}.
 */
const BD_SURFACE_HEX8_TAIL_RE = /-([0-9a-f]{8})$/i;

/**
 * GH-1766: normalise an operator-supplied bd id to the canonical
 * `BD-<8hex>` short surface form. Accepts three input shapes:
 *
 *   1. `BD-<8hex>` — returned as-is (uppercased prefix).
 *   2. `BD-<workspace>-<ts>-<seq>-<hex8>` — the 8-hex tail is extracted.
 *   3. `<workspace>-…-<hex8>` (bare bd-native long id) — the 8-hex tail is
 *      extracted. The workspace prefix is not validated here — callers that
 *      need foreign-prefix rejection should use the `BdDomainAdapter`
 *      `surfaceIdToExternalId` arm instead, which throws
 *      `ForeignWorkspacePrefixError`.
 *
 * Returns `null` when the input does not carry an 8-hex tail (e.g. semantic-
 * id workspaces). Callers must fall back to a deterministic-hash derivation
 * or surface an error.
 */
export function normalizeToBdSurfaceShort(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const short = trimmed.match(/^BD-([0-9a-f]{8})$/i);
  if (short) return `BD-${short[1]!.toLowerCase()}`;
  const tail = trimmed.match(BD_SURFACE_HEX8_TAIL_RE);
  if (tail) return `BD-${tail[1]!.toLowerCase()}`;
  return null;
}

/**
 * GH-1766: recognise a bare bd long-id whose workspace prefix matches the
 * cwd repo's registered `bd_workspace_prefix`. The recognition is index-
 * only (no bd subprocess) so callers can fork on `canonical=bd` before
 * spawning. Returns `null` when the input is not a bare workspace-long-id
 * shape or when the cwd is not covered by a `LocalRepo` advertising a
 * matching prefix.
 *
 * `resolveIssueId` itself stays GH-first per its existing contract; this
 * helper is exported so callers that have already determined `canonical=bd`
 * can short-circuit to a bd resolver without forking the parser.
 */
export function recognizeBareWorkspaceLongId(
  raw: string,
  cwd: string = process.cwd(),
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toUpperCase().startsWith("BD-")) return null;
  const prefix = localWorkspacePrefixForCwd(cwd);
  if (!prefix) return null;
  if (!trimmed.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)) return null;
  if (trimmed.length <= prefix.length + 1) return null;
  return trimmed;
}
