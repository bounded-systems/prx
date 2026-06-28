// Startup glue: when a GitHub App is configured, mint an installation token and
// publish it as GH_TOKEN so prx's `gh` subprocesses and HTTP readers
// (front-desk/coverage, classifier) all authenticate as the app — headless, no
// `gh auth login`. Called once from the CLI edge (scripts/pr_state.ts).
//
// Precedence (so CI never double-mints): an explicit GH_TOKEN/GITHUB_TOKEN
// already in env wins; else a configured app mints; else fail-open to personal
// `gh` auth. Env is read/written via @bounded-systems/env (ambient guard).
import { getEnv as defaultGetEnv, setEnv as defaultSetEnv } from "@bounded-systems/env";

import {
  resolveBrokerConfig as defaultResolveBrokerConfig,
  type ResolveBrokerConfigDeps,
} from "./broker-config.ts";
import { createBroker as defaultCreateBroker, type Broker, type BrokerDeps } from "./broker.ts";

/** Non-secret outcome of {@link applyBrokeredGhToken}. */
export type ApplyResult =
  | { readonly applied: false; readonly reason: "env-token-present" | "not-configured" }
  | {
      readonly applied: true;
      readonly source: "inline" | "file";
      readonly expiresAt: number;
      readonly permissions: Readonly<Record<string, string>>;
    };

export interface ApplyBrokeredGhTokenDeps {
  readonly getEnv?: (key: string) => string | undefined;
  readonly setEnv?: (key: string, value: string) => void;
  /** fs-seam: forwarded to the config resolver to read PRX_GH_APP_KEY_FILE. */
  readonly readFile?: (path: string) => string;
  readonly resolveConfig?: typeof defaultResolveBrokerConfig;
  readonly createBroker?: typeof defaultCreateBroker;
  readonly brokerDeps?: BrokerDeps;
}

let processBroker: Broker | null = null;

/** The broker created by the last successful apply — daemons re-`ensure()` it
 *  before a GitHub burst to refresh across the ~1h token lifetime. */
export function getProcessBroker(): Broker | null {
  return processBroker;
}

/**
 * Mint-and-publish GH_TOKEN if an App is configured. Returns a non-secret
 * summary. Throws (fail-closed) only when an App IS configured but resolving the
 * key or minting fails — in cloud/OCI there is no personal `gh` fallback, so a
 * silent degrade would mislead. Unconfigured environments fail-open (no throw).
 */
export async function applyBrokeredGhToken(
  deps: ApplyBrokeredGhTokenDeps = {},
): Promise<ApplyResult> {
  const getEnv = deps.getEnv ?? defaultGetEnv;
  const setEnv = deps.setEnv ?? defaultSetEnv;
  const resolveConfig = deps.resolveConfig ?? defaultResolveBrokerConfig;
  const createBroker = deps.createBroker ?? defaultCreateBroker;

  // CI / explicit override wins — don't double-mint.
  if (getEnv("GH_TOKEN") ?? getEnv("GITHUB_TOKEN")) {
    return { applied: false, reason: "env-token-present" };
  }

  const cfgDeps: ResolveBrokerConfigDeps = {
    getEnv,
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
  };
  const config = resolveConfig(cfgDeps); // throws on misconfig — intentional
  if (!config) return { applied: false, reason: "not-configured" };

  const broker = createBroker(config, deps.brokerDeps);
  processBroker = broker;
  const t = await broker.ensure(); // throws on mint failure — fail-closed
  setEnv("GH_TOKEN", t.token);
  return { applied: true, source: config.source, expiresAt: t.expiresAt, permissions: t.permissions };
}
