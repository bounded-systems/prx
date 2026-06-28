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

/**
 * dolt's noms writes temp files to `$TMPDIR`; the minimal nix image has no
 * writable `/tmp`, so the pod points TMPDIR at the (writable) data volume.
 * Verified: without this dolt-box exits `open /tmp/<n>: no such file or
 * directory`; with it the server starts and serves the database.
 */
export const DOLT_BOX_ENV: Readonly<Record<string, string>> = {
  DOLT_PORT: String(DOLT_BOX_PORT),
  TMPDIR: DOLT_DATA_DIR,
};

/**
 * The deterministic data SEED is the `dolt-data` nix FOD
 * (nix/oci/dolt-data.nix) — the network-fetch stage. The COPY stage populates
 * the {@link DOLT_DATA_VOLUME} from that artifact with NO network, via:
 *
 *   tar -C "$(nix path)" -cf - . | podman volume import prx-dolt-data -
 *   podman run --rm -v prx-dolt-data:/d alpine chmod -R a+rwX /d   # nix store is read-only
 *
 * (podman-machine can't see the host /nix/store, so a tar stream — not a bind —
 * is the transport; the chmod makes the read-only store bytes writable for the
 * dolt server.) Wired into pod provisioning in the pod-model phase.
 */
