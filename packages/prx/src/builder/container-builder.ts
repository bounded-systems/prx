/**
 * The nix-builder CONTAINER as the host's nix remote builder (prx-zj8 capstone)
 * — the render layer. Pure functions (unit-tested); the `prx builder` verb drives
 * the live podman run + keygen, and the operator applies the host-side
 * registration (prx never edits `/etc/nix/*` itself — see scripts/prx62h-builder.sh).
 *
 * The host's nix offloads aarch64-linux builds over `ssh-ng://root@<alias>`,
 * where the alias resolves (via ~/.config/ssh/config) to the container's
 * published sshd port. The container runs single-user nix as root (it owns
 * /nix); the host's PUBLIC key is mounted as the container's authorized_keys, and
 * /nix is a persistent named volume (cache survives restarts). Replaces the Lima
 * builder VM (nix/oci/nix-builder-box.nix + room/nix-builder-service.ts).
 */

import { join } from "node:path";

import { getEnv } from "@bounded-systems/env";

import {
  NIX_BUILDER_IMAGE,
  NIX_BUILDER_SSH_PORT,
  NIX_BUILDER_STORE_VOLUME,
  NIX_BUILDER_AUTHKEYS_PATH,
} from "../room/nix-builder-service.ts";

/** The podman container name for the builder. */
export const BUILDER_CONTAINER_NAME = "prx-nix-builder";
/** The ssh host alias the `/etc/nix/machines` line dials (resolved by ssh config). */
export const BUILDER_SSH_ALIAS = "nix-builder-box";

/** Host dir holding the builder keypair (the privkey nix dials with; the pubkey
 *  is mounted into the container as authorized_keys). */
export function builderStateDir(env: typeof getEnv = getEnv): string {
  const xdg = env("XDG_STATE_HOME");
  if (xdg) return join(xdg, "prx", "builder");
  return join(env("HOME") ?? "/tmp", ".local", "state", "prx", "builder");
}
/** The builder private key path (`<dir>/id_ed25519`; pubkey is `<…>.pub`). */
export function builderKeyPath(env: typeof getEnv = getEnv): string {
  return join(builderStateDir(env), "id_ed25519");
}

export interface BuilderRunOpts {
  /** Container name (default {@link BUILDER_CONTAINER_NAME}). */
  name?: string | undefined;
  /** Image ref (default {@link NIX_BUILDER_IMAGE}). */
  image?: string | undefined;
  /** Host port published → the container's sshd :22 (default {@link NIX_BUILDER_SSH_PORT}). */
  port?: number | undefined;
  /** Named volume for the persistent /nix store (default {@link NIX_BUILDER_STORE_VOLUME}). */
  storeVolume?: string | undefined;
  /** Host path to the PUBLIC key mounted as the container's authorized_keys. */
  pubKeyPath: string;
}

/** The `podman run` argv (after `podman`) that starts the builder container. */
export function renderBuilderRunArgs(o: BuilderRunOpts): string[] {
  return [
    "run",
    "-d",
    "--replace",
    "--restart",
    "always",
    "--name",
    o.name ?? BUILDER_CONTAINER_NAME,
    "-p",
    `${o.port ?? NIX_BUILDER_SSH_PORT}:22`,
    "-v",
    `${o.storeVolume ?? NIX_BUILDER_STORE_VOLUME}:/nix`,
    "-v",
    `${o.pubKeyPath}:${NIX_BUILDER_AUTHKEYS_PATH}:ro`,
    o.image ?? NIX_BUILDER_IMAGE,
  ];
}

export interface BuilderMachineOpts {
  /** The private key path the host nix dials with (a field in the machines line). */
  keyPath: string;
  /** Builder system(s), comma-separated. Default `aarch64-linux`. */
  systems?: string | undefined;
  /** Max parallel jobs the host dispatches. Default 4. */
  maxJobs?: number | undefined;
  /** Speed factor among the host's builders. Default 1. */
  speedFactor?: number | undefined;
  /** Builder features. Default `["big-parallel"]`. */
  supportedFeatures?: readonly string[] | undefined;
}

/**
 * The `/etc/nix/machines` line registering the container builder. Fields:
 * `uri systems sshKey maxJobs speedFactor supportedFeatures mandatoryFeatures
 * base64SSHHostKey`. The URI dials the {@link BUILDER_SSH_ALIAS} ssh-config host
 * (which carries the port); the explicit key path is the private key.
 */
export function renderBuilderMachineLine(o: BuilderMachineOpts): string {
  const features = o.supportedFeatures ?? (["big-parallel"] as const);
  return [
    `ssh-ng://root@${BUILDER_SSH_ALIAS}`,
    o.systems ?? "aarch64-linux",
    o.keyPath,
    String(o.maxJobs ?? 4),
    String(o.speedFactor ?? 1),
    features.length > 0 ? features.join(",") : "-",
    "-", // mandatoryFeatures: none
    "-", // base64 ssh host key: not pinned (StrictHostKeyChecking no in the alias)
  ].join(" ");
}

/**
 * The `~/.config/ssh/config` block so `root@nix-builder-box` resolves to the
 * published sshd port on localhost. The operator adds this (prx renders it).
 */
export function renderBuilderSshConfig(o: { port?: number | undefined; keyPath: string }): string {
  return [
    `Host ${BUILDER_SSH_ALIAS}`,
    "    HostName 127.0.0.1",
    `    Port ${o.port ?? NIX_BUILDER_SSH_PORT}`,
    "    User root",
    `    IdentityFile ${o.keyPath}`,
    "    IdentitiesOnly yes",
    "    StrictHostKeyChecking no",
    "    UserKnownHostsFile /dev/null",
  ].join("\n");
}
