// dep-research manifest loader (GH-1261, PR-1).
//
// Operator-editable JSON at `.prx/dep-research/manifest.json` parsed via Zod
// at the boundary. The on-disk path is the canonical source so PR-2/PR-3 can
// pick it up unchanged.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DepManifest, type DepManifestEntry } from "./schemas.ts";

export const DEP_MANIFEST_RELATIVE_PATH = ".prx/dep-research/manifest.json";

export class DepManifestError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "INVALID_JSON" | "SCHEMA",
  ) {
    super(message);
    this.name = "DepManifestError";
  }
}

export function loadDepManifest(repoRoot: string): DepManifestEntry[] {
  const path = join(repoRoot, DEP_MANIFEST_RELATIVE_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DepManifestError(
        `dep-research manifest not found at ${DEP_MANIFEST_RELATIVE_PATH}`,
        "NOT_FOUND",
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DepManifestError(
      `dep-research manifest is not valid JSON: ${(err as Error).message}`,
      "INVALID_JSON",
    );
  }

  const result = DepManifest.safeParse(parsed);
  if (!result.success) {
    throw new DepManifestError(
      `dep-research manifest schema error: ${result.error.message}`,
      "SCHEMA",
    );
  }
  return result.data.entries;
}

export function formatDepManifestPlain(entries: DepManifestEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${entry.name}  ${entry.source.kind}  ${entry.source.url}`);
    for (const path of entry.source.paths) {
      lines.push(`  path: ${path}`);
    }
    if (entry.notes) {
      lines.push(`  note: ${entry.notes}`);
    }
  }
  return lines.join("\n");
}

export function formatDepManifestJson(entries: DepManifestEntry[]): string {
  return JSON.stringify({ version: 1, entries }, null, 2);
}
