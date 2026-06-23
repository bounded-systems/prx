/**
 * @module
 * TUI configuration schema parser/emitter for the L1 Claude and L2 Warp tools.
 * Parses raw JSON config objects into typed values + structured drift reports.
 */

export type { DriftIssue, DriftReport } from "./drift.ts";

export {
  TuiSubsetSchema,
  TUI_KEYS,
  type TuiSubset,
  type TuiL1Claude,
  type ParseResult,
  parse,
  emit,
  driftReport,
  parseFile,
  emitToFile,
} from "./tui_l1_claude.ts";

export {
  TuiL2WarpSchema,
  WARP_KEYS,
  type TuiL2WarpSubset,
  type TuiL2Warp,
  type ParseResult as ParseResultWarp,
  parse as parseWarp,
  emit as emitWarp,
  driftReport as driftReportWarp,
  parseFile as parseFileWarp,
  emitToFile as emitToFileWarp,
} from "./tui_l2_warp.ts";
