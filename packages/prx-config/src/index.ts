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
