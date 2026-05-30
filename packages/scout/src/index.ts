/**
 * Scout — content-addressed surface reads (the extractor core).
 *
 * The standalone module surface: bounded, read-only file exploration
 * (read/grep/files) plus the anchored-chain provenance bridge. Depends only on
 * node builtins and the CAS/anchored-chain substrate (@bounded-systems/cas, @bounded-systems/anchored-chain)
 * — the same lower-layer edges the extractability test enforces.
 *
 * The GH/Notion projection verbs (`issues`, `notion`) are NOT part of this
 * surface: they reach into pr-state/triage/fetch and are slated to become
 * scout *plugins* over this core. They keep their direct import paths until
 * that plugin boundary lands.
 */

export type { ScoutReadInput, ScoutReadResult } from "./read.ts";
export { ScoutReadError, runScoutRead, formatScoutReadJson } from "./read.ts";

export type {
  ScoutGrepInput,
  ScoutGrepMatch,
  ScoutGrepResult,
} from "./grep.ts";
export { ScoutGrepError, runScoutGrep, formatScoutGrepJsonLines } from "./grep.ts";

export type {
  ScoutFilesInput,
  ScoutFilesMatch,
  ScoutFilesResult,
} from "./files.ts";
export {
  ScoutFilesError,
  runScoutFiles,
  formatScoutFilesJsonLines,
} from "./files.ts";

export type {
  ScoutReadDerivationOptions,
  SlsaProvenanceStatement,
} from "./provenance.ts";
export {
  SCOUT_READ_PRODUCER,
  SCOUT_READ_CONTRACT,
  scoutReadDerivation,
  recordScoutReadDerivation,
  IN_TOTO_STATEMENT_TYPE,
  SLSA_PROVENANCE_PREDICATE_TYPE,
  SCOUT_READ_BUILD_TYPE,
  SCOUT_READ_BUILDER_ID,
  scoutReadProvenance,
  formatScoutReadProvenanceJson,
} from "./provenance.ts";
