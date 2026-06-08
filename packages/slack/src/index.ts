// @bounded-systems/slack — policy-gated, provenance-tracked Slack read surface.
//
// slack .2 (prx-src): the read-op types, the transport port, and the keymaker
// capability port. No transport impl, no auth resolution, no proc dependency —
// those land in later tasks of epic prx-zes (.3 policy, .4/.4b auth+keymaker,
// .5 execSlackRead core, .6 provenance, .7 MCP, .8 CLI, .9 verb).

export type {
  SlackReadOp,
  SlackChannelsParams,
  SlackHistoryParams,
  SlackThreadParams,
  SlackUsersParams,
  SlackReadParams,
  SlackRawResult,
  SlackReadErrorCode,
} from "./types.ts";
export { SLACK_READ_OPS, SlackReadError } from "./types.ts";

export type {
  SlackKeyScope,
  SlackRequest,
  AuthorizedSlackRequest,
  ScopedSlackKey,
  SlackKeyGrant,
  SlackKeymaker,
  BaseScopedCredential,
  BaseKeymaker,
  SlackScopedKeymakerOptions,
} from "./keymaker.ts";
export { slackScopedKeymaker } from "./keymaker.ts";

export type { SlackReadTransport } from "./transport.ts";

export type { ExecSlackReadDeps, SlackReadEnvelope } from "./read.ts";
export { execSlackRead, formatSlackReadEnvelope, DEFAULT_KEY_TTL_MS } from "./read.ts";

export { canonicalJson } from "./canonical.ts";
