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
 * SEEDING the data volume — a RUNTIME clone, not a nix build artifact.
 *
 * A content-addressed nix FOD was tried (the old nix/oci/dolt-data.nix) but
 * `dolt clone` + `dolt gc` are NOT byte-reproducible across builders (or runs),
 * so the FOD's fixed output hash mismatched on any rebuild — proven: the same
 * pinned commit yielded different NAR hashes on the Lima vs the container
 * builder. So the seed is builder-INDEPENDENT and deterministic only PER-COMMIT:
 * clone the DoltHub remote at the pinned commit straight into the volume:
 *
 *   podman run --rm -v prx-dolt-data:/var/lib/dolt:U -e HOME=/tmp \
 *     <dolt-box> dolt clone <remote> /var/lib/dolt/io_github_bounded_systems_prx
 *   # then `dolt reset --hard <pinnedCommit>` for the pin (optional)
 *
 * One-time at provision; the volume then persists. This is what `prx dolt
 * provision` (the stubbed GH-1685 verb) should do when wired — no nix FOD, no
 * cross-builder hash to break.
 */
