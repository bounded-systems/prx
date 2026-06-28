/**
 * The dolt-box backing service (prx-asr / prx-zj8).
 *
 * Unlike the rooms, dolt-box is NOT a door-exposing member — it is a standalone
 * backing service that serves the MySQL wire protocol on a TCP port (3307,
 * `DOLT_PORT` in nix/oci/dolt-box.nix), which beadsd-box's bd reaches over the
 * pod network ("connect-to-external-dolt"). It owns the beads dolt database on a
 * NAMED VOLUME (`/var/lib/dolt`, the image's `DOLT_DATA_DIR`), seeded by
 * `prx dolt provision` (a deterministic, network-separated build artifact).
 *
 * The pod model renders this as a non-door container with the named data volume;
 * see {@link ./pod.PodServiceSchema} and the per-repo pod's `services`.
 */

/** Pinned dolt-box image (published by .github/workflows/publish-oci-boxes.yml). */
export const DOLT_BOX_IMAGE =
  "ghcr.io/bounded-systems/prx/dolt-box@sha256:71fa665e3d8f1b2152f3538c5c1922ed532fa9cf801b78974637a48e0d7ebf22";

/** The dolt server's TCP port inside the pod (matches dolt-box.nix `DOLT_PORT`). */
export const DOLT_BOX_PORT = 3307;

/** The named volume holding the dolt database (mounted at the image's data dir). */
export const DOLT_DATA_VOLUME = "prx-dolt-data";

/** The in-container data dir dolt-box serves (`DOLT_DATA_DIR` in dolt-box.nix). */
export const DOLT_DATA_DIR = "/var/lib/dolt";
