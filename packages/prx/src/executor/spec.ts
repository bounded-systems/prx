/**
 * prx executor spec (GH-211) — the provider-agnostic description of an isolated
 * executor that prx OWNS, rendered to a concrete runtime by a driver.
 *
 * keeperd (GH-201) runs `prx keeper` inside such an executor; the wire contract
 * (`src/keeperd/contract.ts`) and host↔VM transport are already substrate-
 * agnostic (the runtime sits behind the `openConnection` seam), so prx should
 * own an executor *spec* and treat the runtime as a swappable driver — Lima
 * today, an OCI/microVM driver later for the fleet (#193). Owning the spec also
 * lets prx emit *correct* config (e.g. Lima 2.0's `vmOpts.vz.rosetta`) instead
 * of inheriting `lima-devshell`'s stale template.
 *
 * Spec-as-schema: the spec is a Zod schema so a malformed executor request is a
 * validation error at the seam, not a half-rendered config.
 *
 * Scope of the first slice: the typed spec + the driver interface + the Lima
 * driver's renderer (`./lima`). Credential-provisioning policy (persistent /
 * ephemeral-per-boot / tmpfs-from-vault / hardware) and the actual VM lifecycle
 * land in later slices.
 */

import { z } from "zod";

/** A host→guest mount. `mountPoint` defaults (driver-side) to `location`. */
export const ExecutorMountSchema = z.object({
  location: z.string().min(1),
  mountPoint: z.string().min(1).optional(),
  writable: z.boolean().optional(),
});
export type ExecutorMount = z.infer<typeof ExecutorMountSchema>;

/** A guest base image (location + the arch it is built for). */
export const ExecutorImageSchema = z.object({
  location: z.string().min(1),
  arch: z.string().min(1).optional(),
});
export type ExecutorImage = z.infer<typeof ExecutorImageSchema>;

/** A provisioning step run while the executor is brought up. */
export const ProvisionStepSchema = z.object({
  /** Lima provisioning modes; a driver maps these to its own lifecycle hooks. */
  mode: z.enum(["system", "user", "boot", "dependency", "data"]),
  /** The script body (multi-line); rendered as a block scalar. */
  script: z.string().min(1),
});
export type ProvisionStep = z.infer<typeof ProvisionStepSchema>;

/** Rosetta x86-on-ARM emulation (Apple Silicon + `vmType: vz`). */
export const RosettaSchema = z.object({
  enabled: z.boolean(),
  /** Register rosetta to binfmt_misc so x86_64 binaries run transparently. */
  binfmt: z.boolean().optional(),
});

/**
 * The provider-agnostic executor spec. `name` identifies the instance (passed to
 * the driver's create, not rendered into config). Everything else describes the
 * isolated environment; a driver renders the subset it supports.
 */
export const ExecutorSpecSchema = z.object({
  name: z.string().min(1),
  arch: z.enum(["aarch64", "x86_64"]).optional(),
  images: z.array(ExecutorImageSchema).optional(),
  cpus: z.number().int().positive().optional(),
  memoryGiB: z.number().positive().optional(),
  diskGiB: z.number().positive().optional(),
  mounts: z.array(ExecutorMountSchema).optional(),
  ssh: z
    .object({
      localPort: z.number().int().min(0).optional(),
      loadDotSSHPubKeys: z.boolean().optional(),
      forwardAgent: z.boolean().optional(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  provision: z.array(ProvisionStepSchema).optional(),
  rosetta: RosettaSchema.optional(),
  /** Mount backend, e.g. `virtiofs` (driver-specific vocabulary, passed through). */
  mountType: z.string().min(1).optional(),
  /** Enable inotify on mounts (experimental in Lima). */
  mountInotify: z.boolean().optional(),
});
export type ExecutorSpec = z.infer<typeof ExecutorSpecSchema>;

/**
 * A runtime driver: render an {@link ExecutorSpec} to its native config. Adding
 * a driver (OCI, microVM) must not touch keeperd's contract/client/daemon/host —
 * the runtime stays behind this seam.
 */
export interface ExecutorDriver {
  /** Stable driver id, e.g. `lima`. */
  readonly id: string;
  /** Render the spec to the driver's native config text. */
  render(spec: ExecutorSpec): string;
}
