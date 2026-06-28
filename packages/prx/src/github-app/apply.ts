// Startup glue: when a GitHub App is configured, mint an installation token and
// publish it as GH_TOKEN so prx's `gh` subprocesses and HTTP readers
// (front-desk/coverage, classifier) all authenticate as the app — headless, no
// `gh auth login`. Called once from the CLI edge (scripts/pr_state.ts).
//
// Precedence (so CI never double-mints): an explicit GH_TOKEN/GITHUB_TOKEN
// already in env wins; else a configured app mints; else fail-open to personal
// `gh` auth. Env is read/written via @bounded-systems/env (ambient guard).
import {
  deleteEnv as defaultDeleteEnv,
  getEnv as defaultGetEnv,
  setEnv as defaultSetEnv,
} from "@bounded-systems/env";

import {
  resolveBrokerConfig as defaultResolveBrokerConfig,
  type ResolveBrokerConfigDeps,
} from "./broker-config.ts";
import { createBroker as defaultCreateBroker, type Broker, type BrokerDeps } from "./broker.ts";
import { createDoorBroker as defaultCreateDoorBroker } from "./door-source.ts";

/** Non-secret outcome of {@link applyBrokeredGhToken}. */
export type ApplyResult =
  | { readonly applied: false; readonly reason: "env-token-present" | "not-configured" }
  | {
      readonly applied: true;
      readonly source: "inline" | "file" | "door";
      readonly expiresAt: number;
      readonly permissions: Readonly<Record<string, string>>;
    };

export interface ApplyBrokeredGhTokenDeps {
  readonly getEnv?: (key: string) => string | undefined;
  readonly setEnv?: (key: string, value: string) => void;
  /** Env unset seam — used to scrub the inline PEM after it is read. */
  readonly deleteEnv?: (key: string) => void;
  /** fs-seam: forwarded to the config resolver to read PRX_GH_APP_KEY_FILE. */
  readonly readFile?: (path: string) => string;
  readonly resolveConfig?: typeof defaultResolveBrokerConfig;
  readonly createBroker?: typeof defaultCreateBroker;
  readonly createDoorBroker?: typeof defaultCreateDoorBroker;
  readonly brokerDeps?: BrokerDeps;
}

let processBroker: Broker | null = null;

/** The broker created by the last successful apply — daemons re-`ensure()` it
 *  before a GitHub burst to refresh across the ~1h token lifetime. */
export function getProcessBroker(): Broker | null {
  return processBroker;
}

/**
 * Resolve-and-publish GH_TOKEN if a GitHub App is reachable. Precedence:
 * explicit GH_TOKEN/GITHUB_TOKEN (CI) > a ghappd door (PRX_GH_APP_DOOR) > a local
 * App key (PRX_GH_APP_*) > fail-open to personal `gh`. Returns a non-secret
 * summary. Throws (fail-closed) only when a door/key IS configured but the
 * lease/mint fails — in cloud/OCI there is no personal `gh` fallback.
 */
export async function applyBrokeredGhToken(
  deps: ApplyBrokeredGhTokenDeps = {},
): Promise<ApplyResult> {
  const getEnv = deps.getEnv ?? defaultGetEnv;
  const setEnv = deps.setEnv ?? defaultSetEnv;
  const deleteEnv = deps.deleteEnv ?? defaultDeleteEnv;
  const resolveConfig = deps.resolveConfig ?? defaultResolveBrokerConfig;
  const createBroker = deps.createBroker ?? defaultCreateBroker;
  const createDoorBroker = deps.createDoorBroker ?? defaultCreateDoorBroker;

  // CI / explicit override wins — don't double-mint.
  if (getEnv("GH_TOKEN") ?? getEnv("GITHUB_TOKEN")) {
    return { applied: false, reason: "env-token-present" };
  }

  // DOOR backend (preferred when present): lease from ghappd over the door
  // transport so the agent holds no App key — only a reference to the door. Wins
  // over the local-PEM path. Fail-closed: a lease failure throws (no fallback).
  const doorEndpoint = getEnv("PRX_GH_APP_DOOR");
  if (doorEndpoint) {
    const broker = createDoorBroker({ endpoint: doorEndpoint });
    processBroker = broker;
    const leased = await broker.ensure();
    setEnv("GH_TOKEN", leased.token);
    return {
      applied: true,
      source: "door",
      expiresAt: leased.expiresAt,
      permissions: leased.permissions,
    };
  }

  const cfgDeps: ResolveBrokerConfigDeps = {
    getEnv,
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
  };
  const config = resolveConfig(cfgDeps); // throws on misconfig — intentional
  if (!config) return { applied: false, reason: "not-configured" };

  const broker = createBroker(config, deps.brokerDeps);
  processBroker = broker;

  // Harden the inline-PEM cloud-agent path: the broker now holds the PEM in
  // memory (for re-mints), so scrub it from the env. Otherwise it is inherited
  // by every child process prx spawns and is readable via /proc/<pid>/environ.
  // The file-path source keeps only a (non-secret) path in env — nothing to scrub.
  if (config.source === "inline") deleteEnv("PRX_GH_APP_PRIVATE_KEY");

  const t = await broker.ensure(); // throws on mint failure — fail-closed
  setEnv("GH_TOKEN", t.token);
  return { applied: true, source: config.source, expiresAt: t.expiresAt, permissions: t.permissions };
}
