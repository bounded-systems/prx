import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEP_MANIFEST_RELATIVE_PATH,
  DepManifestError,
  formatDepManifestJson,
  formatDepManifestPlain,
  loadDepManifest,
} from "../../src/dep-research/manifest.ts";

function repoRootWith(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "dep-research-"));
  mkdirSync(join(dir, ".prx", "dep-research"), { recursive: true });
  writeFileSync(join(dir, DEP_MANIFEST_RELATIVE_PATH), JSON.stringify(manifest), "utf8");
  return dir;
}

describe("loadDepManifest", () => {
  test("loads and parses a valid on-disk manifest", () => {
    const root = repoRootWith({
      version: 1,
      entries: [
        {
          name: "xstate",
          source: {
            kind: "git",
            url: "https://github.com/statelyai/xstate",
            paths: ["packages/core/src/types.ts"],
          },
          classification_hints: { schema: ["types\\.ts$"], state: [], cli: [], config: [] },
        },
      ],
    });
    const entries = loadDepManifest(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("xstate");
  });

  test("NOT_FOUND when manifest is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-research-empty-"));
    try {
      loadDepManifest(dir);
      throw new Error("expected DepManifestError");
    } catch (err) {
      expect(err).toBeInstanceOf(DepManifestError);
      expect((err as DepManifestError).code).toBe("NOT_FOUND");
    }
  });

  test("INVALID_JSON when file is not JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "dep-research-badjson-"));
    mkdirSync(join(dir, ".prx", "dep-research"), { recursive: true });
    writeFileSync(join(dir, DEP_MANIFEST_RELATIVE_PATH), "{not json", "utf8");
    try {
      loadDepManifest(dir);
      throw new Error("expected DepManifestError");
    } catch (err) {
      expect(err).toBeInstanceOf(DepManifestError);
      expect((err as DepManifestError).code).toBe("INVALID_JSON");
    }
  });

  test("SCHEMA when manifest is structurally invalid", () => {
    const root = repoRootWith({ version: 1, entries: [{ name: "x" }] });
    try {
      loadDepManifest(root);
      throw new Error("expected DepManifestError");
    } catch (err) {
      expect(err).toBeInstanceOf(DepManifestError);
      expect((err as DepManifestError).code).toBe("SCHEMA");
    }
  });
});

// Resolve the repo root containing the checked-in manifest; null when absent.
// The prx repo has no .prx/dep-research/manifest.json (that's ai-home content),
// so this describe is skipped there. Computed at module scope (returning null
// instead of throwing) so a missing manifest can't crash test collection.
const checkedInManifestRoot = (() => {
  let cur = new URL(".", import.meta.url).pathname;
  for (let i = 0; i < 6; i++) {
    try {
      loadDepManifest(cur);
      return cur;
    } catch {
      cur = join(cur, "..");
    }
  }
  return null;
})();

describe.skipIf(checkedInManifestRoot === null)(
  "checked-in manifest at .prx/dep-research/manifest.json",
  () => {
    const repoRoot = checkedInManifestRoot as string;

    test("parses cleanly", () => {
      const entries = loadDepManifest(repoRoot);
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    test("every entry has a well-formed URL", () => {
      const entries = loadDepManifest(repoRoot);
      for (const entry of entries) {
        expect(() => new URL(entry.source.url)).not.toThrow();
      }
    });

    test("entry names are unique", () => {
      const entries = loadDepManifest(repoRoot);
      const names = entries.map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
    });
  },
);

describe("format helpers", () => {
  const entries = [
    {
      name: "xstate",
      source: {
        kind: "git" as const,
        url: "https://github.com/statelyai/xstate",
        paths: ["packages/core/src/types.ts"],
      },
      classification_hints: { schema: [], state: [], cli: [], config: [] },
      notes: "owns prSystem",
    },
  ];

  test("formatDepManifestPlain includes name, kind, url, paths, and notes", () => {
    const out = formatDepManifestPlain(entries);
    expect(out).toContain("xstate");
    expect(out).toContain("git");
    expect(out).toContain("https://github.com/statelyai/xstate");
    expect(out).toContain("packages/core/src/types.ts");
    expect(out).toContain("owns prSystem");
  });

  test("formatDepManifestJson is parseable JSON with the same shape", () => {
    const out = formatDepManifestJson(entries);
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].name).toBe("xstate");
  });
});
