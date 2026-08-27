/**
 * intake→triage edge (prx-4fa, epic prx-997) — the pipeline's front edge.
 *
 * The artifact is a `uow` (unit of work). A uow is git-persisted (it lives as a
 * GH issue / bead), so it is NOT emitted directly into the CAS — it is brought
 * in via the fixed-output pin ({@link pinSource}): `intake` fetches the uow from
 * its impure home and pins the snapshot by content hash; `triage` consumes that
 * snapshot. The pinned sha is the uow's identity + freshness key, so `triage`
 * works against an immutable snapshot and {@link uowFresh} reports when the live
 * issue/bead has drifted from it — the Nix fixed-output-derivation pattern.
 *
 * The impure read is injected ({@link UowReader}) by the caller (e.g. a
 * Front-Desk/gh-backed reader). So the edge is fully testable without live I/O.
 */
import { type Uow, uowSchema } from "../../machine/contracts/lifecycle_artifacts.ts";
import {
  type ArtifactEdge,
  type Fetcher,
  consumeArtifact,
  defineEdge,
  isFresh,
  pinSource,
} from "../edge.ts";

/** intake → triage. The uow lives in git; pinned into the CAS via FOD. */
export const intakeToTriage: ArtifactEdge<Uow> = defineEdge({
  kind: "uow",
  slot: "snapshot",
  source: "intake",
  target: "triage",
  persistence: "git",
  schema: uowSchema,
});

/** A raw work-unit record as read from its impure home (gh / Front Desk). */
export interface RawUow {
  id: string;
  title: string;
  status: string;
}

/** Map a raw gh/Front Desk record onto the typed uow contract (validates the status). */
export function normalizeUow(raw: RawUow): Uow {
  return uowSchema.parse({ id: raw.id, title: raw.title, status: raw.status });
}

/** The injected impure read — the I/O half of the FOD fetcher. */
export type UowReader = (unit: string) => Promise<RawUow> | RawUow;

/** The FOD fetcher for a uow: impure read → normalized + validated. */
export function uowFetcher(read: UowReader): Fetcher<Uow> {
  return async (unit) => normalizeUow(await read(unit));
}

/** intake: pin the uow snapshot into the CAS (FOD) so triage can consume it. */
export function pinUow(unit: string, read: UowReader) {
  return pinSource(intakeToTriage, unit, uowFetcher(read));
}

/** triage: consume the pinned uow snapshot. */
export function consumeUow(unit: string) {
  return consumeArtifact(intakeToTriage, unit);
}

/** Is the pinned uow snapshot still fresh vs its live (gh/Front Desk) source? */
export function uowFresh(unit: string, read: UowReader) {
  return isFresh(intakeToTriage, unit, uowFetcher(read));
}
