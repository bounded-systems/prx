/**
 * The linux-builder room (prx-62h) — prx's Linux build substrate as a typed
 * {@link RoomSpec}.
 *
 * Why a room: dockerTools/OCI images (e.g. the beadsd-box image, prx-634) are
 * Linux-only, but prx's dev host is darwin. The builder is the textbook "house
 * in a room" case from the kata spike: on darwin a Linux build substrate needs
 * a VM (`tier: "vm"`) to exist at all, so its *house* is a Lima VM. On a native
 * Linux host the same room collapses to a `sandbox`-tier container — the spec is
 * the constant; only the executor driver changes.
 *
 * It does not *consume* doors (a builder needs no daemon egress) — it **exposes**
 * a `builder` door granting `nix:build` / `oci:image`, so other rooms
 * (claude-box) can request a build over the socket without themselves holding
 * build authority (ocap: the capability lives behind the door, not in the
 * occupant). Wiring the door's server + the host→builder remote-build transport
 * is the next slice; this is the spec.
 */

import type { RoomSpec } from "./spec.ts";

const DOOR_SOCKET = "/run/prx/doors/builder.sock";

export const linuxBuilderRoom: RoomSpec = {
  name: "linux-builder",
  // On darwin the build substrate is a VM (hardware boundary); a native-Linux
  // deploy would render the same spec to a sandbox-tier container instead.
  tier: "vm",
  executor: {
    name: "prx-linux-builder",
    arch: "aarch64",
    cpus: 4,
    memoryGiB: 8,
    diskGiB: 40,
    // The host drives `nix build --builders 'ssh://…'` into this VM, so it must
    // accept the host's key. loadDotSSHPubKeys seeds authorized_keys.
    ssh: { loadDotSSHPubKeys: true, forwardAgent: false },
    provision: [
      {
        // Multi-user nix so the VM is a remote builder; trust the SSH user so
        // it may push derivations. TODO(prx-62h): pin the installer + channel.
        mode: "system",
        script: [
          "set -eu",
          "if ! command -v nix >/dev/null; then",
          "  sh <(curl -L https://nixos.org/nix/install) --daemon --yes",
          "fi",
          "install -d -m 0755 /etc/nix",
          "printf 'experimental-features = nix-command flakes\\ntrusted-users = root %s\\n' \"${LIMA_CIDATA_USER:-builder}\" > /etc/nix/nix.conf",
        ].join("\n"),
      },
      {
        // containerd host for loading/running the OCI images this builder emits.
        // TODO(prx-62h): pin containerd + confirm rootless vs system scope.
        mode: "system",
        script: [
          "set -eu",
          "command -v containerd >/dev/null || (apt-get update -qq && apt-get install -y -qq containerd)",
          "systemctl enable --now containerd || true",
        ].join("\n"),
      },
    ],
  },
  doors: [
    // The build door: other rooms dial this to get a build; the builder serves
    // it. nix:build covers `nix build` of any flake output; oci:image covers the
    // dockerTools image builds (beadsd-box / keeperd-box / claude-box).
    { name: "builder", direction: "expose", capability: "nix:build", socket: DOOR_SOCKET },
    { name: "builder", direction: "expose", capability: "oci:image", socket: DOOR_SOCKET },
  ],
  // What the builder's OWN occupant may do inside the room.
  grants: ["nix:build", "oci:image"],
};
