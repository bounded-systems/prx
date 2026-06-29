// Container-backed bd lifecycle runner (prx-82b Slice 2c.2) — the adapter that
// lets `runBdInit` / `runMigrate` / the bootstrap `config set` run their bd op in
// an EPHEMERAL beadsd-box container instead of host `bd`. It satisfies the
// `BdInitRunner`/`BdMigrateRunner` seam shape `(cmd, {cwd}) => SpawnCaptureResult`,
// so it drops in as the production default at those call sites with no flow
// rewrite. `cmd[0]` ("bd") becomes the container `--entrypoint`; `options.cwd` is
// the repo bound at `/work`. The `env`/`homeOverride` arg is intentionally
// ignored — it existed to disarm host bd's legacy-store discovery, which a clean
// container fs makes moot (and the runner sets a writable `HOME=/tmp`).

import type { SpawnCaptureResult } from "@bounded-systems/proc";

import { readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";

import { getEnv } from "@bounded-systems/env";

import { runBdLifecycle, DOLT_CREDS_SECRET } from "../room/lifecycle-runner.ts";
import { spawnPodman, type PodmanRun } from "../room/podman-runtime.ts";

/** The shared `BdInitRunner` / `BdMigrateRunner` seam shape. */
export type BdLifecycleRunner = (
  cmd: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => SpawnCaptureResult;

/**
 * A {@link BdLifecycleRunner} that runs the bd op in an ephemeral beadsd-box
 * container (via {@link runBdLifecycle}) against `options.cwd`. The default
 * production runner for the setup lifecycle ops — host bd is no longer invoked.
 */
export function containerBdRunner(run: PodmanRun = spawnPodman): BdLifecycleRunner {
  return (cmd, options = {}) => {
    const repo = options.cwd ?? process.cwd();
    const [bin, ...args] = cmd as readonly string[];
    const res = runBdLifecycle({ repo, bin, args }, run);
    return { status: res.status, signal: null, stdout: res.stdout, stderr: res.stderr };
  };
}

/**
 * A `RepoRunner`-shaped variant (returns `{stdout, stderr, status: number}` —
 * non-null status) for the `bd dolt remote add` site in repo_add_dolthub. The
 * inline return type avoids a beads↔pr-state import cycle; it's structurally a
 * `RepoRunner` at the call site. Only cred-FREE dolt ops belong here — `dolt
 * push` needs DoltHub creds the container lacks (left on host; the sync agent
 * owns recurring push).
 */
export function containerRepoRunner(
  run: PodmanRun = spawnPodman,
): (
  cmd: string[],
  options?: { cwd?: string; check?: boolean },
) => { stdout: string; stderr: string; status: number } {
  return (cmd, options = {}) => {
    const repo = options.cwd ?? process.cwd();
    const [bin, ...args] = cmd;
    const res = runBdLifecycle({ repo, bin, args }, run);
    return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
  };
}

// ── cred-bearing dolt push (prx-82b Slice 2c.5) ──────────────────────────────

/** The host's dolt identity (non-secret) — the active creds pubkey + author. */
export interface DoltIdentity {
  /** `user.creds` — the active creds pubkey (= the jwk filename, base32). */
  credsKey: string;
  email: string;
  name: string;
}

/** Read the host dolt identity from `~/.dolt/config_global.json` (injectable). */
export function readHostDoltIdentity(read: (p: string) => string = (p) => readFileSync(p, "utf8")): DoltIdentity {
  const home = getEnv("HOME") ?? "";
  const cfg = JSON.parse(read(join(home, ".dolt", "config_global.json"))) as Record<string, string>;
  const credsKey = cfg["user.creds"];
  if (!credsKey) throw new Error("no `user.creds` in ~/.dolt/config_global.json — run `dolt login` first");
  return { credsKey, email: cfg["user.email"] ?? "", name: cfg["user.name"] ?? "" };
}

// The in-container wrapper: install the mounted jwk into dolt's creds dir + set
// the active creds/author from the (non-secret) env, then exec the op. Validated
// live: `dolt creds check` authenticates to DoltHub with this setup.
const DOLT_CREDS_INSTALL = [
  'mkdir -p "$HOME/.dolt/creds"',
  'install -m600 /run/secrets/dolt-creds "$HOME/.dolt/creds/$DOLT_CREDS_KEY.jwk"',
  'dolt config --global --add user.creds "$DOLT_CREDS_KEY" >/dev/null',
  'dolt config --global --add user.email "$DOLT_USER_EMAIL" >/dev/null',
  'dolt config --global --add user.name "$DOLT_USER_NAME" >/dev/null',
].join(" && ");

/** The non-secret identity env every credentialed dolt op installs the creds with. */
function doltCredsEnv(id: DoltIdentity): Record<string, string> {
  return { DOLT_CREDS_KEY: id.credsKey, DOLT_USER_EMAIL: id.email, DOLT_USER_NAME: id.name };
}

/**
 * A push runner `(cwd, branch) => {stdout,stderr,status}` (the repo_add_dolthub
 * seam) that runs `bd dolt push` in an EPHEMERAL beadsd-box container with the
 * DoltHub creds mounted via the room-secret rail ({@link DOLT_CREDS_SECRET}) —
 * no host bd, no ad-hoc cred bind. The jwk is a podman secret; the (non-secret)
 * active-creds pubkey + author come from {@link readHostDoltIdentity} as env.
 */
export function containerBdDoltPush(
  run: PodmanRun = spawnPodman,
  identity?: DoltIdentity,
): (cwd: string, branch: "main") => { stdout: string; stderr: string; status: number } {
  return (cwd, branch) => {
    // Read the host dolt identity lazily — only when a push actually runs.
    const id = identity ?? readHostDoltIdentity();
    const script = `${DOLT_CREDS_INSTALL} && exec bd dolt push origin "$1"`;
    const res = runBdLifecycle(
      {
        repo: cwd,
        bin: "sh",
        args: ["-c", script, "_", branch],
        secrets: [DOLT_CREDS_SECRET],
        env: doltCredsEnv(id),
      },
      run,
    );
    return { stdout: res.stdout, stderr: res.stderr, status: res.status ?? 1 };
  };
}

/**
 * A `dolt clone` runner `(url, dest) => {exitCode, stderr}` (the hydrate
 * `doltClone` dep) that clones in an EPHEMERAL beadsd-box container with DoltHub
 * creds on the room-secret rail — no host dolt. The host clone dest's PARENT is
 * bound at `/work` and dolt clones into it (so the host buffer gets the clone,
 * host-owned via keep-id); hydrate's host-side rename then promotes it.
 */
export function containerDoltClone(
  run: PodmanRun = spawnPodman,
  identity?: DoltIdentity,
): (url: string, dest: string) => { exitCode: number; stderr: string } {
  return (url, dest) => {
    const id = identity ?? readHostDoltIdentity();
    const script = `${DOLT_CREDS_INSTALL} && exec dolt clone "$1" "/work/$2"`;
    const res = runBdLifecycle(
      {
        repo: dirname(dest),
        bin: "sh",
        args: ["-c", script, "_", url, basename(dest)],
        secrets: [DOLT_CREDS_SECRET],
        env: doltCredsEnv(id),
      },
      run,
    );
    return { exitCode: res.status ?? 1, stderr: res.stderr };
  };
}

/**
 * A `schema_repair` `BdRunner`-shaped runner `(args, cwd) => {exitCode,stdout,stderr}`
 * (note: `args` is WITHOUT the leading "bd") that runs the cold bootstrap
 * schema-repair op in an ephemeral beadsd-box container, not host bd.
 */
export function containerBdSchemaRunner(
  run: PodmanRun = spawnPodman,
): (args: string[], cwd: string) => { exitCode: number; stdout: string; stderr: string } {
  return (args, cwd) => {
    const res = runBdLifecycle({ repo: cwd, bin: "bd", args }, run);
    return { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
  };
}
