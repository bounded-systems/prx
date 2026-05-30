// GH-1704 — `.beads/metadata.json` `dolt_mode` patcher (GH-1695 workaround).
//
// `bd init --shared-server` writes a metadata.json whose `dolt_mode` field is
// stale (`per-project` instead of `server`) until bd-upstream's persistence
// fix lands. Both `prx beads migrate` (GH-1706) and `prx repo bootstrap`
// (GH-1704) flip the value in-verb so the on-disk shape matches the
// shared-server reality the classifier and audit code rely on.
//
// Lifted out of `migrate.ts` so both verbs depend on the same primitive.
// Pure refactor: behaviour matches the original (read → parse → overwrite the
// `dolt_mode` key → pretty-print with a trailing newline).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MetadataPatchResult =
  | { ok: true; metadataPath: string }
  | { ok: false; metadataPath: string; error: string };

/**
 * Set `.beads/metadata.json` `dolt_mode` to `"server"`. Returns a discriminated
 * result so callers can fold the failure into their own event-emitting arms
 * rather than catching exceptions.
 */
export function patchBeadsMetadataDoltMode(beadsDir: string): MetadataPatchResult {
  const metadataPath = join(beadsDir, "metadata.json");
  try {
    const raw = readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.dolt_mode = "server";
    writeFileSync(
      metadataPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
    return { ok: true, metadataPath };
  } catch (err) {
    return {
      ok: false,
      metadataPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
