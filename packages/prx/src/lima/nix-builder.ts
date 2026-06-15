/**
 * Provision the prx Lima VM as a nix remote builder (prx-62h, flavor B).
 *
 * ADR `docs/prx/claude-runtime.md`: prx owns ONE linux builder that every
 * aarch64-linux/OCI build offloads to, so the OCI fleet images (prx-634
 * beadsd-box, prx-anj keeperd-box, …) can be built from a macOS host that has no
 * native Linux kernel. Flavor B reuses the existing Lima VM — already
 * aarch64-linux, already prx-managed, already hosting beadsd/keeperd/dolt:
 * install nix in it, make the VM's login user a `trusted-user` (so the host can
 * `nix-store --serve --write` over ssh), and emit the host `/etc/nix/machines`
 * registration line. `nix build` then offloads INTO the VM and the image lands
 * in the VM's store → `nerdctl load` runs it in the SAME VM's containerd: build
 * and run colocate, no host transfer.
 *
 * Mirrors {@link ../beadsd/provision.provisionVmBeads}: the in-VM effects run
 * through the injected {@link ../door/lima-exec.Run} seam (every effect is a
 * `limactl shell … bash -lc <script>`), so the orchestration is unit-tested
 * offline and the live path runs against a real VM. The host-side registration
 * is a PURE descriptor — prx renders the machines line, it never edits
 * `/etc/nix/*` here (that host-config write is the operator's, out of scope).
 */

import { spawnRun, type Run, type RunResult } from "../door/lima-exec.ts";

/** Determinate Systems installer — the prx ecosystem's nix (works headless). */
const DEFAULT_NIX_INSTALLER_URL = "https://install.determinate.systems/nix";
/** The builder's nix system. The Lima VM is aarch64-linux. */
const DEFAULT_SYSTEMS = "aarch64-linux";
/** Default parallel build jobs the host may dispatch to the VM. */
const DEFAULT_MAX_JOBS = 4;
/** Default speed factor relative to other builders in the host's set. */
const DEFAULT_SPEED_FACTOR = 1;
/** Builder features the OCI/image builds rely on. */
const DEFAULT_SUPPORTED_FEATURES = ["big-parallel"] as const;

export interface ProvisionVmNixBuilderDeps {
  run?: Run | undefined;
}

export interface ProvisionVmNixBuilderOptions {
  /** Lima instance name. */
  vm: string;
  /** nix installer URL (piped to `sh`). Default: Determinate Systems. */
  nixInstallerUrl?: string | undefined;
  /** Builder system(s), comma-separated. Default `aarch64-linux`. */
  systems?: string | undefined;
  /** Max parallel jobs the host dispatches here. Default 4. */
  maxJobs?: number | undefined;
  /** Speed factor among the host's builders. Default 1. */
  speedFactor?: number | undefined;
  /** Builder features. Default `["big-parallel"]`. */
  supportedFeatures?: readonly string[] | undefined;
}

/** A nix remote-builder descriptor — one entry in the host's `/etc/nix/machines`. */
export interface NixBuilderMachine {
  /** ssh-ng URI the host dials. */
  uri: string;
  /** Comma-separated builder systems. */
  systems: string;
  maxJobs: number;
  speedFactor: number;
  supportedFeatures: readonly string[];
}

export interface ProvisionVmNixBuilderResult {
  /** The builder descriptor. */
  machine: NixBuilderMachine;
  /** The host `/etc/nix/machines` line registering it. */
  machinesLine: string;
}

/** The ssh host alias Lima writes for `<vm>` (in `~/.lima/<vm>/ssh.config`). */
export function limaSshHostAlias(vm: string): string {
  return `lima-${vm}`;
}

/**
 * Render a `/etc/nix/machines` line for a builder. The fields, in order:
 * `uri systems sshKey maxJobs speedFactor supportedFeatures mandatoryFeatures
 * base64SSHHostKey`. We dial through Lima's ssh config (the host alias resolves
 * the key/user), so `sshKey`, `mandatoryFeatures`, and the host key are `-`.
 */
export function nixBuilderMachineLine(m: NixBuilderMachine): string {
  const features = m.supportedFeatures.length > 0 ? m.supportedFeatures.join(",") : "-";
  return [
    m.uri,
    m.systems,
    "-", // sshKey: resolved by the lima ssh config / agent
    String(m.maxJobs),
    String(m.speedFactor),
    features,
    "-", // mandatoryFeatures: none
    "-", // base64 ssh host key: pinned by the lima ssh config
  ].join(" ");
}

/** `limactl shell <vm> -- bash -lc <script>` argv (login shell: $HOME/PATH set). */
function limaBash(vm: string, script: string): string[] {
  return ["shell", "--workdir", "/", vm, "--", "bash", "-lc", script];
}

function requireOk(res: RunResult, what: string): void {
  if (res.status !== 0) {
    throw new Error(`${what} failed (${res.status}): ${res.stderr.trim()}`);
  }
}

/**
 * Provision the VM as a nix remote builder. Idempotent: skips the nix install
 * when nix is already present, and the trusted-user / nix.conf edits are
 * append-if-absent. Returns the builder descriptor + the host machines line the
 * operator registers (`nix build` offloads here once it lands in
 * `/etc/nix/machines` or the host `builders` setting).
 */
export function provisionVmNixBuilder(
  opts: ProvisionVmNixBuilderOptions,
  deps: ProvisionVmNixBuilderDeps = {},
): ProvisionVmNixBuilderResult {
  const run = deps.run ?? spawnRun;
  const installerUrl = opts.nixInstallerUrl ?? DEFAULT_NIX_INSTALLER_URL;
  const systems = opts.systems ?? DEFAULT_SYSTEMS;
  const maxJobs = opts.maxJobs ?? DEFAULT_MAX_JOBS;
  const speedFactor = opts.speedFactor ?? DEFAULT_SPEED_FACTOR;
  const supportedFeatures = opts.supportedFeatures ?? DEFAULT_SUPPORTED_FEATURES;

  // 1. Install nix (skip if already present). Determinate installer runs headless.
  requireOk(
    run(
      "limactl",
      limaBash(
        opts.vm,
        `set -e; command -v nix >/dev/null || ` +
          `curl --proto '=https' --tlsv1.2 -sSf -L ${installerUrl} | ` +
          `sh -s -- install linux --no-confirm`,
      ),
    ),
    `install nix in ${opts.vm}`,
  );

  // 2. Make the VM's login user a trusted-user (so the host can
  //    `nix-store --serve --write` over ssh) + enable flakes. Append-if-absent
  //    so re-runs don't duplicate lines; restart the daemon to pick them up.
  requireOk(
    run(
      "limactl",
      limaBash(
        opts.vm,
        `set -e; u="$(id -un)"; conf=/etc/nix/nix.conf; ` +
          `sudo touch "$conf"; ` +
          `grep -q "trusted-users = .*\\b$u\\b" "$conf" || echo "extra-trusted-users = $u" | sudo tee -a "$conf" >/dev/null; ` +
          `grep -q "experimental-features = .*flakes" "$conf" || echo "extra-experimental-features = nix-command flakes" | sudo tee -a "$conf" >/dev/null; ` +
          `sudo systemctl restart nix-daemon 2>/dev/null || sudo launchctl kickstart -k system/org.nixos.nix-daemon 2>/dev/null || true`,
      ),
    ),
    `register trusted-user + flakes in ${opts.vm}`,
  );

  const machine: NixBuilderMachine = {
    uri: `ssh-ng://${limaSshHostAlias(opts.vm)}`,
    systems,
    maxJobs,
    speedFactor,
    supportedFeatures,
  };
  return { machine, machinesLine: nixBuilderMachineLine(machine) };
}
