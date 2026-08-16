// Stage-writer for `prx transcripts digest --stage` (GH-1495).
//
// Default output target: `<memoryDir>/.candidates/<originSessionId>__<slug>.md`.
// Idempotent: if the candidate file already exists, the write is a no-op (the
// triage front-end planned in GH-1485 promotes from this directory, so re-runs
// must not stomp triage state).
//
// Atomic: writes to a sibling `.tmp.<pid>.<rand>` and renames into place
// (mirrors the I-DR3 pattern from `src/dep-research/snapshot.ts:65–91`). On
// rename failure the tmp file is best-effort cleaned up.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MemoryCandidate } from "./schemas.ts";

export type StageWriteResult = {
  /** Absolute path of the staged candidate file. */
  path: string;
  /** True when the file already existed (idempotent skip). */
  skipped: boolean;
};

export type StageWriterDeps = {
  /** Randomness source for the tmp suffix. Default: `Math.random`. */
  rand?: () => string;
};

function frontmatter(candidate: MemoryCandidate): string {
  const refs = candidate.inputRefs.map((r) => `    - ${JSON.stringify(r)}`).join("\n");
  return [
    "---",
    `name: ${candidate.name}`,
    `description: ${JSON.stringify(candidate.description)}`,
    "metadata:",
    "  node_type: memory",
    `  type: ${candidate.type}`,
    `  originSessionId: ${candidate.originSessionId}`,
    `  uowId: ${candidate.uowId}`,
    "  inputRefs:",
    refs,
    "---",
    "",
  ].join("\n");
}

export function renderCandidateMarkdown(candidate: MemoryCandidate): string {
  return `${frontmatter(candidate)}${candidate.body}\n`;
}

function candidateFilename(candidate: MemoryCandidate): string {
  return `${candidate.originSessionId}__${candidate.name}.md`;
}

/**
 * Write one candidate to the staging area atomically. Returns `{skipped:
 * true}` when the file already exists (idempotency for I-TD5).
 */
export function writeStagedCandidate(
  candidate: MemoryCandidate,
  memoryDir: string,
  deps: StageWriterDeps = {},
): StageWriteResult {
  const stageDir = join(memoryDir, ".candidates");
  mkdirSync(stageDir, { recursive: true });

  const finalPath = join(stageDir, candidateFilename(candidate));
  if (existsSync(finalPath)) {
    return { path: finalPath, skipped: true };
  }

  const rand = (deps.rand ?? (() => Math.random().toString(36).slice(2)))();
  const tmpPath = join(stageDir, `.tmp.${process.pid}.${rand}.md`);
  const body = renderCandidateMarkdown(candidate);

  try {
    writeFileSync(tmpPath, body, "utf8");
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  return { path: finalPath, skipped: false };
}
