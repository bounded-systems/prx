/**
 * The nix-builder backing service (prx-zj8 / prx-62h capstone) — the nix remote
 * BUILDER as a pinned container, replacing the Lima builder VM.
 *
 * It runs `sshd` (port 22) over the pod/host network; the host's nix offloads
 * aarch64-linux builds over `ssh-ng://builder@127.0.0.1:<port>`, ssh-ing in as
 * root and running `nix-store --serve` against the container's /nix (single-user
 * nix; root owns the store). The /nix store is a persistent NAMED VOLUME so the
 * build cache survives restarts; the host's PUBLIC key is mounted at
 * `/run/builder/authorized_keys`.
 *
 * Registered in `/etc/nix/machines` by the `prx builder` verb (the host-side
 * registration is the operator's privileged step; prx renders the line). See
 * nix/oci/nix-builder-box.nix.
 */

/** Pinned nix-builder-box image (published by .github/workflows/publish-oci-boxes.yml). */
export const NIX_BUILDER_IMAGE =
  "ghcr.io/bounded-systems/prx/nix-builder-box:latest"; // TODO(prx-zj8): pin @sha256 after first publish

/** The host port the builder's sshd is published on (→ `ssh-ng://builder@127.0.0.1:PORT`). */
export const NIX_BUILDER_SSH_PORT = 2226;

/** The named volume holding the builder's persistent /nix store (cache). */
export const NIX_BUILDER_STORE_VOLUME = "prx-nix-store";

/** Where the host's public key is mounted inside the container (authorized_keys source). */
export const NIX_BUILDER_AUTHKEYS_PATH = "/run/builder/authorized_keys";
