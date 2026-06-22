// Invariant guard for the `bounded` block every published package carries
// (seeded in #711). The bounded.tools site sources each seam's tagline from
// `package.json` → `bounded.tagline` and classifies it by `bounded.kind`, so a
// package that ships without a well-formed block silently falls back to the
// site's stale seed copy. This test makes the convention an enforced invariant:
// a new `@bounded-systems/*` package can't merge without a valid `bounded`.
//
// The contract:
//   - `bounded.tagline` is a non-empty string equal to the package `description`
//     (one source of truth — the tagline mirrors the description, never drifts).
//   - `bounded.kind` is one of door | room | guest (the room/door/guest paradigm).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@bounded-systems/";
const KINDS = ["door", "room", "guest"] as const;

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type Manifest = {
  name?: string;
  description?: string;
  bounded?: { tagline?: unknown; kind?: unknown };
};

/** Every `@bounded-systems/*` workspace package, by short name. */
function workspacePackages(): Array<{ short: string; manifest: Manifest }> {
  const out: Array<{ short: string; manifest: Manifest }> = [];
  for (const dirent of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(
        readFileSync(resolve(packagesDir, dirent.name, "package.json"), "utf8"),
      ) as Manifest;
    } catch {
      continue; // not a workspace package
    }
    if (typeof manifest.name !== "string" || !manifest.name.startsWith(SCOPE)) continue;
    out.push({ short: manifest.name.slice(SCOPE.length), manifest });
  }
  return out.sort((a, b) => a.short.localeCompare(b.short));
}

describe("bounded metadata", () => {
  const packages = workspacePackages();

  test("there are packages to check", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  for (const { short, manifest } of packages) {
    test(`${short} carries a well-formed bounded block`, () => {
      const bounded = manifest.bounded;
      expect(bounded, `${short}: missing "bounded" block — seed it (tagline + kind)`).toBeDefined();

      expect(
        KINDS,
        `${short}: bounded.kind must be one of ${KINDS.join(" | ")}, got ${JSON.stringify(bounded?.kind)}`,
      ).toContain(bounded?.kind as (typeof KINDS)[number]);

      const tagline = bounded?.tagline;
      expect(typeof tagline, `${short}: bounded.tagline must be a string`).toBe("string");
      expect(
        (tagline as string).length,
        `${short}: bounded.tagline must be non-empty`,
      ).toBeGreaterThan(0);

      const description =
        typeof manifest.description === "string" ? manifest.description.trim() : "";
      expect(
        tagline,
        `${short}: bounded.tagline must mirror the package description verbatim (one source of truth)`,
      ).toBe(description);
    });
  }
});
