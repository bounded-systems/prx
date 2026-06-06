/**
 * keeperd Lima transport driver (GH-201; generalized in GH-228 slice 3).
 *
 * A thin keeper-typed wrapper over the daemon-agnostic {@link ../lima/channel}:
 * the SSH forward + open/use/close lifecycle now live there (shared with
 * beadsd's {@link ../beadsd/lima}); this module only binds the keeper request
 * type and builds an {@link IsolatedKeeperClient} over the framed transport. The
 * host's client is unchanged — it just talks to a socket.
 *
 * Exports are kept stable (`openLimaKeeperChannel`, `withLimaKeeperClient`,
 * `LimaChannelDeps`, `RunResult`) so existing callers and tests are untouched.
 */

import { IsolatedKeeperClient, type KeeperTransport } from "./client.ts";
import {
  openLimaChannel,
  withLimaChannel,
  type LimaChannel,
  type LimaChannelDeps as GenericLimaChannelDeps,
  type LimaChannelOptions,
} from "../lima/channel.ts";

export type { RunResult } from "../lima/channel.ts";

/** keeper-typed channel deps (its `makeTransport` yields a {@link KeeperTransport}). */
export type LimaChannelDeps = GenericLimaChannelDeps<KeeperTransport>;

export type LimaKeeperChannelOptions = LimaChannelOptions;

/** An established host↔VM keeperd forward. */
export type LimaKeeperChannel = LimaChannel<KeeperTransport>;

const NAME_PREFIX = "keeperd-lima-";

/**
 * Establish a Lima-SSH-forwarded unix socket to the in-VM keeperd and return a
 * keeper-typed channel over it. Delegates to {@link openLimaChannel}.
 */
export function openLimaKeeperChannel(
  opts: LimaKeeperChannelOptions,
  deps: LimaChannelDeps = {},
): Promise<LimaKeeperChannel> {
  return openLimaChannel<KeeperTransport>({ ...opts, namePrefix: opts.namePrefix ?? NAME_PREFIX }, deps);
}

/**
 * Open a Lima keeperd channel, run `fn` with an {@link IsolatedKeeperClient} over
 * it, and always close the forward afterward (even on throw).
 */
export async function withLimaKeeperClient<T>(
  opts: LimaKeeperChannelOptions,
  fn: (client: IsolatedKeeperClient) => Promise<T>,
  deps: LimaChannelDeps = {},
): Promise<T> {
  return withLimaChannel<KeeperTransport, T>(
    { ...opts, namePrefix: opts.namePrefix ?? NAME_PREFIX },
    (transport) => fn(new IsolatedKeeperClient(transport)),
    deps,
  );
}
