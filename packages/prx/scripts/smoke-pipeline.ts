#!/usr/bin/env bun
/**
 * Pipeline-edge E2E smoke (prx-4fa, epic prx-997).
 *
 * Proves the intake→triage edge end-to-end against a REAL work-unit: `intake`
 * pins the uow from its impure home (Front Desk) into the CAS via the
 * fixed-output pin, `triage` consumes the snapshot, and freshness holds right
 * after the pin. This is the first edge of the pipeline DAG shown to work end
 * to end on real data.
 *
 * Skips (exit 0) when Front Desk is unavailable or there is no open work-unit —
 * same convention as smoke-release.ts, so CI without a Front Desk workspace
 * doesn't fail.
 *
 * Usage: bun packages/prx/scripts/smoke-pipeline.ts [unit-id]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAllBeadsViaDaemon, showBeadViaDaemon } from "../src/beads/frontdesk-reads.ts";
import { consumeUow, pinUow, type RawUow, uowFresh } from "../src/pipeline/edges/intake-triage.ts";

/** The injected impure read: pull the uow from its home on Front Desk. */
async function readUow(unit: string): Promise<RawUow> {
  const rec = await showBeadViaDaemon(unit);
  if (!rec) throw new Error(`Front Desk has no work-unit ${unit}`);
  return { id: rec.id, title: rec.title, status: rec.status };
}

async function anyOpenUnit(): Promise<string | null> {
  try {
    const rows = await loadAllBeadsViaDaemon();
    return rows.find((r) => r.status === "open")?.id ?? null;
  } catch {
    return null;
  }
}

const unit = process.argv[2] ?? (await anyOpenUnit());
if (!unit) {
  console.log("[SKIP] pipeline-edge — Front Desk unavailable or no open work-unit");
  process.exit(0);
}

// Isolate the CAS so the proof never touches the operator's store.
process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-smoke-pipeline-"));

const pinned = await pinUow(unit, readUow); // intake: fetch uow from Front Desk → pin into CAS
const got = await consumeUow(unit); // triage: consume the pinned snapshot
const fresh = await uowFresh(unit, readUow); // freshness vs the live uow

const ok = !!got.value && got.value.id === unit && fresh.fresh === true;
console.log(
  `[${ok ? "PASS" : "FAIL"}] intake→triage edge — unit=${unit} ref=${pinned.ref} fresh=${fresh.fresh}`,
);
if (got.value) console.log(`        uow: ${JSON.stringify(got.value)}`);
console.log(ok ? "\nsmoke-pipeline: OK" : "\nsmoke-pipeline: FAILED");
process.exit(ok ? 0 : 1);
