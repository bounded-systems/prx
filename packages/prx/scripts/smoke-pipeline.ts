#!/usr/bin/env bun
/**
 * Pipeline-edge E2E smoke (prx-4fa, epic prx-997).
 *
 * Proves the intake→triage edge end-to-end against a REAL work-unit: `intake`
 * pins the uow from its impure home (bd) into the CAS via the fixed-output pin,
 * `triage` consumes the snapshot, and freshness holds right after the pin. This
 * is the first edge of the pipeline DAG shown to work end to end on real data.
 *
 * Skips (exit 0) when bd is unavailable or there is no open work-unit — same
 * convention as smoke-release.ts, so CI without a bd workspace doesn't fail.
 *
 * Usage: bun packages/prx/scripts/smoke-pipeline.ts [bd-id]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  consumeUow,
  pinUow,
  uowFresh,
} from "../src/pipeline/edges/intake-triage.ts";

function anyOpenUnit(): string | null {
  const r = spawnSync("bd", ["list", "--status=open", "--json"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout) as Array<{ id?: string }>;
    return Array.isArray(rows) && rows[0]?.id ? String(rows[0].id) : null;
  } catch {
    return null;
  }
}

const unit = process.argv[2] ?? anyOpenUnit();
if (!unit) {
  console.log("[SKIP] pipeline-edge — bd unavailable or no open work-unit");
  process.exit(0);
}

// Isolate the CAS so the proof never touches the operator's store.
process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-smoke-pipeline-"));

const pinned = await pinUow(unit); // intake: fetch uow from bd → pin into CAS
const got = await consumeUow(unit); // triage: consume the pinned snapshot
const fresh = await uowFresh(unit); // freshness vs the live bead

const ok = !!got.value && got.value.id === unit && fresh.fresh === true;
console.log(
  `[${ok ? "PASS" : "FAIL"}] intake→triage edge — unit=${unit} ref=${pinned.ref} fresh=${fresh.fresh}`,
);
if (got.value) console.log(`        uow: ${JSON.stringify(got.value)}`);
console.log(ok ? "\nsmoke-pipeline: OK" : "\nsmoke-pipeline: FAILED");
process.exit(ok ? 0 : 1);
