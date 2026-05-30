export {
  type PrxLayout,
  type MuxStep,
  compileLayout,
  muxSessionName,
} from "./layout.ts";

export {
  PRX_TMUX_SOCKET,
  PRX_RESURRECT_DIR,
  type MuxSessionState,
  muxSessionState,
  spawnMuxSession,
  attachMuxSession,
  killMuxSession,
  clearResurrectEntry,
  resurrectSaveMentions,
  restoreMuxSession,
  sendMuxKeys,
} from "./tmux.ts";

export {
  type CommandResult,
  type CommandRunner,
  defaultRunner,
} from "@bounded-systems/proc";
