/**
 * Marker-append helpers for the bd arms of `prx intake comment` / `prx intake
 * merge` (GH-1913). bd has no native comment surface, so the bd `notes` column
 * (single string field) is treated as an append-only thread carrying a
 * content-hash marker. The marker is deterministic per (verb, body) so
 * re-running the same invocation is an idempotent no-op.
 *
 * If bd grows a first-class comment primitive later, both arms migrate cleanly
 * by swapping these helpers for the new bd verb.
 */

import { createHash } from "node:crypto";

export type NotesAppendVerb = "prx-intake-comment" | "prx-intake-merge";

/**
 * Build the marker line for a (verb, body) pair. Format:
 *   `[<verb> sha256-prefix=<8 hex>]`
 *
 * The 8-hex prefix of sha256(body) is enough to distinguish reasonable bodies
 * while keeping the marker compact. Same body → same marker → idempotent
 * re-run on `notesAlreadyContains`.
 */
export function buildNotesAppendMarker(
  verb: NotesAppendVerb,
  body: string,
): string {
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  return `[${verb} sha256-prefix=${digest.slice(0, 8)}]`;
}

/**
 * True when `currentNotes` already contains `marker` as a substring. Treats
 * null/undefined as empty. Case-sensitive — markers are lowercase hex.
 */
export function notesAlreadyContains(
  currentNotes: string | null | undefined,
  marker: string,
): boolean {
  if (!currentNotes) return false;
  return currentNotes.includes(marker);
}

/**
 * Compose the new notes value by appending `marker\n<body>` to `currentNotes`.
 * Null/empty prior notes → first-write (no leading separator); otherwise a
 * blank-line separator (`\n\n`) is inserted to keep prior content visually
 * distinct.
 *
 * Callers should call {@link notesAlreadyContains} first and short-circuit
 * when the marker is present.
 */
export function composeAppendedNotes(
  currentNotes: string | null | undefined,
  marker: string,
  body: string,
): string {
  const entry = `${marker}\n${body}`;
  if (!currentNotes || currentNotes.length === 0) {
    return entry;
  }
  return `${currentNotes}\n\n${entry}`;
}
