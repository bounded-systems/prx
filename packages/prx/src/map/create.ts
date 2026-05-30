// `prx map create` — capture a named, cross-tree initiative as a JSON record
// under `<repoRoot>/.prx/maps/<name>.json` (GH-2016 PR-1).
//
// Two input shapes:
//   1. Inline — `--tickets <ids…> --rationale <text>`. The sequence is built
//      with a default role of "implementation" and no inter-ticket deps.
//      Operators wanting role/depends/relates structure use the file form.
//   2. From-file — `--from-file <path>` reads a JSON file matching the
//      {@link MapRecord} schema and round-trips it through `writeMapRecord`.
//
// Idempotency: writes overwrite on rerun. Edit-then-recreate is the supported
// workflow (no separate `prx map edit` verb in the MVP).

import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  MapRecord,
  MapSequenceEntry,
  MapTicketId,
} from "./schemas/index.ts";
import { writeMapRecord } from "./record-io.ts";

const mapCreateInlineSchema = z.object({
  kind: z.literal("inline"),
  name: z.string().min(1),
  tickets: z.array(MapTicketId).min(1),
  rationale: z.string().min(1),
  /**
   * Defaults to today (UTC). Override exists for tests so the on-disk
   * snapshot is reproducible without freezing the system clock.
   */
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  parents: z.array(MapTicketId).default([]),
  repoRoot: z.string().min(1),
});

const mapCreateFromFileSchema = z.object({
  kind: z.literal("from-file"),
  path: z.string().min(1),
  repoRoot: z.string().min(1),
});

export const mapCreateOptionsSchema = z.discriminatedUnion("kind", [
  mapCreateInlineSchema,
  mapCreateFromFileSchema,
]);
export type MapCreateOptions = z.infer<typeof mapCreateOptionsSchema>;

export type MapCreateActorResult = {
  name: string;
  path: string;
  record: MapRecord;
};

function todayUtc(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function buildInlineRecord(
  opts: z.infer<typeof mapCreateInlineSchema>,
): MapRecord {
  const sequence: MapSequenceEntry[] = opts.tickets.map((id) =>
    MapSequenceEntry.parse({
      id,
      role: "implementation",
      depends: [],
      relates: [],
    }),
  );
  return MapRecord.parse({
    name: opts.name,
    created: opts.created ?? todayUtc(),
    rationale: opts.rationale,
    parents: opts.parents,
    sequence,
  });
}

function loadFromFile(path: string): MapRecord {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return MapRecord.parse(raw);
}

export async function runMapCreate(
  opts: MapCreateOptions,
): Promise<MapCreateActorResult> {
  const parsed = mapCreateOptionsSchema.parse(opts);
  const record =
    parsed.kind === "inline" ? buildInlineRecord(parsed) : loadFromFile(parsed.path);
  const path = writeMapRecord(parsed.repoRoot, record);
  return { name: record.name, path, record };
}
