// Pure helpers for auto-repinning room images to a freshly-built box digest.
// The publish-oci-boxes workflow rebuilds each box on a release tag, then a repin
// job uses these to bump the `<image>@sha256:…` constant in each room's source —
// so the manual repin hop (prx-hfgg / prx-zee7) goes away.

/** A box image and the source file that pins its digest. */
export interface BoxPin {
  /** The image ref WITHOUT the `@sha256:…` suffix. */
  readonly image: string;
  /** Repo-relative source file holding `<image>@sha256:<digest>`. */
  readonly file: string;
}

/** The prx-published boxes whose room digests are pinned in source. */
export const BOX_PINS: readonly BoxPin[] = [
  { image: "ghcr.io/bounded-systems/prx/beadsd-box", file: "packages/prx/src/room/beadsd-room.ts" },
  {
    image: "ghcr.io/bounded-systems/prx/forge-d-box",
    file: "packages/prx/src/room/forge-d-room.ts",
  },
  { image: "ghcr.io/bounded-systems/prx/dolt-box", file: "packages/prx/src/room/dolt-service.ts" },
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace `<image>@sha256:<hex>` with `<image>@<digest>` in `text`. `digest` is
 * the full `sha256:<hex>` form (as `skopeo inspect --format '{{.Digest}}'` emits).
 * Returns the new text and whether anything changed (no-op if absent or identical).
 */
export function repinImage(
  text: string,
  image: string,
  digest: string,
): { readonly text: string; readonly changed: boolean } {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`repinImage: not a sha256 digest: ${digest}`);
  }
  const re = new RegExp(`(${escapeRegExp(image)}@)sha256:[a-f0-9]+`);
  if (!re.test(text)) return { text, changed: false };
  const next = text.replace(re, `$1${digest}`);
  return { text: next, changed: next !== text };
}
