// slack .2 (prx-src) — the transport PORT.
//
// Unlike gh/bd (where the CLI-via-proc IS the transport), the slack surface puts
// the policy gate, content-addressing, and provenance ABOVE this port, so the
// backend is swappable: an MCP adapter (slack .7, first usable: OAuth+MCP), a
// CLI adapter (slack .8, proc spawn of `slack`), and later a Web API adapter are
// all the same shape behind one gated, provenance-tracked pipeline.
//
// A transport is a pure mechanism. It receives a minted ScopedSlackKey per call
// and exercises `key.authorize()`; it NEVER reads env / resolves auth itself. A
// transport handed no key has no authority.

import type { ScopedSlackKey } from "./keymaker.ts";
import type { SlackReadOp, SlackReadParams, SlackRawResult } from "./types.ts";

export interface SlackReadTransport {
  /**
   * Execute one read op. Implementations exercise `key.authorize(op, channel,
   * req)` to authorize the underlying request and return the provider-shaped
   * envelope. Must reject (SlackReadError TRANSPORT_FAILED/UNAUTHORIZED) rather
   * than return a partial result.
   */
  call<Op extends SlackReadOp>(
    op: Op,
    params: SlackReadParams[Op],
    key: ScopedSlackKey,
  ): Promise<SlackRawResult>;
}
