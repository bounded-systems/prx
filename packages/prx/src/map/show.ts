// `prx map show <name>` — render a stored map's sequence, parents, and
// rationale (GH-2016 PR-1).
//
// PR-1 surface: schema-faithful pretty-print + JSON, no bd-state lookups yet.
// The plan's "per-ticket bd state + next-up" overlay is a PR-3 follow-up that
// composes with `runMapNext`; isolating that here keeps the read path free of
// bd dependencies so `prx map show` works on a freshly-cloned repo with no
// `.beads/` substrate.

import { z } from "zod";

import { MapRecord, MapSequenceEntry } from "./schemas/index.ts";
import { readMapRecord } from "./record-io.ts";

export const mapShowOptionsSchema = z.object({
  name: z.string().min(1),
  repoRoot: z.string().min(1),
  format: z.enum(["plain", "json"]).default("plain"),
});
export type MapShowOptions = z.infer<typeof mapShowOptionsSchema>;

export type MapShowActorResult = {
  record: MapRecord;
  rendered: string;
};

function renderPlain(record: MapRecord): string {
  const lines: string[] = [];
  lines.push(`map: ${record.name}`);
  lines.push(`created: ${record.created}`);
  if (record.parents.length > 0) {
    lines.push(`parents: ${record.parents.join(", ")}`);
  }
  lines.push("");
  lines.push("rationale:");
  for (const r of record.rationale.split("\n")) {
    lines.push(`  ${r}`);
  }
  lines.push("");
  lines.push("sequence:");
  for (const entry of record.sequence) {
    lines.push(`  - ${renderEntry(entry)}`);
  }
  return lines.join("\n");
}

function renderEntry(entry: MapSequenceEntry): string {
  const parts = [`${entry.id} [${entry.role}]`];
  if (entry.priority) parts.push(entry.priority);
  if (entry.depends.length > 0) parts.push(`depends=${entry.depends.join(",")}`);
  if (entry.relates.length > 0) parts.push(`relates=${entry.relates.join(",")}`);
  return parts.join(" ");
}

export async function runMapShow(opts: MapShowOptions): Promise<MapShowActorResult> {
  const parsed = mapShowOptionsSchema.parse(opts);
  const record = readMapRecord(parsed.repoRoot, parsed.name);
  const rendered = parsed.format === "json" ? JSON.stringify(record, null, 2) : renderPlain(record);
  return { record, rendered };
}
