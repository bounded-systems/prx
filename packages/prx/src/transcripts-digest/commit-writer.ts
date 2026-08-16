// Commit-writer for `prx transcripts digest --commit` (GH-1495).
//
// Writes one candidate file under `<memoryDir>/<type>_<slug>.md` and appends
// a pointer line to `<memoryDir>/MEMORY-<type>.md`. The pointer convention
// matches the existing shard format (see
// `claude/hooks/inject-memory-shard.sh:46-52`) so the SessionStart hook
// picks the new entry up on next session start with no extra wiring.
//
// I-TD2: writes are atomic (tmp + rename for the candidate file; append+sync
//        for the pointer line, which is single-line append-only).
// I-TD5: idempotency on originSessionId — if any shard already references
//        this session id, the commit is a no-op.
// I-TD7: refuses to commit if the resulting inlined-shard total would push
//        the auto-loaded context past `MEMORY_INDEX_CAP_BYTES`. Stage path
//        is always allowed (callers should fall back to --stage).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { MemoryCandidate } from "./schemas.ts";
import { renderCandidateMarkdown } from "./stage-writer.ts";

/**
 * 24.4KB harness cap on MEMORY.md (GH-1460/1461). The SessionStart hook
 * inlines all `MEMORY-<type>.md` shards alongside `MEMORY.md`, so the
 * effective auto-loaded total is the sum.
 */
export const MEMORY_INDEX_CAP_BYTES = 24_400;

export type CommitWriteResult =
  | {
      status: "committed";
      candidatePath: string;
      shardPath: string;
    }
  | {
      status: "skipped-duplicate";
      candidatePath: null;
      shardPath: string;
    }
  | {
      status: "refused-cap";
      candidatePath: null;
      shardPath: string;
      currentBytes: number;
      projectedBytes: number;
      capBytes: number;
    };

export type CommitWriterDeps = {
  rand?: () => string;
};

function shardPath(memoryDir: string, type: MemoryCandidate["type"]): string {
  return join(memoryDir, `MEMORY-${type}.md`);
}

function candidatePath(memoryDir: string, candidate: MemoryCandidate): string {
  return join(memoryDir, `${candidate.type}_${candidate.name.replace(/-/g, "_")}.md`);
}

function loadedBytes(memoryDir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry !== "MEMORY.md" && !entry.startsWith("MEMORY-")) continue;
    if (!entry.endsWith(".md")) continue;
    const path = join(memoryDir, entry);
    try {
      total += statSync(path).size;
    } catch {
      // ignore unreadable entries — counted as zero is conservative-enough
    }
  }
  return total;
}

function sessionAlreadyCommitted(memoryDir: string, originSessionId: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.startsWith("MEMORY-")) continue;
    if (!entry.endsWith(".md")) continue;
    let body: string;
    try {
      body = readFileSync(join(memoryDir, entry), "utf8");
    } catch {
      continue;
    }
    if (body.includes(originSessionId)) return true;
  }
  return false;
}

function pointerLine(candidate: MemoryCandidate): string {
  const filename = `${candidate.type}_${candidate.name.replace(/-/g, "_")}.md`;
  // `originSessionId=<id>` is the I-TD5 idempotency marker — the dedup scan
  // matches on the bare session id, so the literal substring is enough.
  return `- [${candidate.description.replace(/\n/g, " ")}](${filename}) — originSessionId=${candidate.originSessionId}\n`;
}

function atomicWriteCandidate(
  candidate: MemoryCandidate,
  path: string,
  deps: CommitWriterDeps,
): void {
  const rand = (deps.rand ?? (() => Math.random().toString(36).slice(2)))();
  const tmpPath = `${path}.tmp.${process.pid}.${rand}`;
  const body = renderCandidateMarkdown(candidate);
  try {
    writeFileSync(tmpPath, body, "utf8");
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Commit one candidate to the durable shard set. Returns a discriminated
 * result the caller renders/audits.
 */
export function commitCandidate(
  candidate: MemoryCandidate,
  memoryDir: string,
  deps: CommitWriterDeps = {},
): CommitWriteResult {
  mkdirSync(memoryDir, { recursive: true });
  const shard = shardPath(memoryDir, candidate.type);
  const candidateFile = candidatePath(memoryDir, candidate);

  if (sessionAlreadyCommitted(memoryDir, candidate.originSessionId)) {
    return {
      status: "skipped-duplicate",
      candidatePath: null,
      shardPath: shard,
    };
  }

  const pointer = pointerLine(candidate);
  // I-TD7: refuse if the index inflation would breach the harness cap. We
  // count current shard bytes + the appended pointer line (the candidate
  // file body is NOT inlined by the SessionStart hook — only the shard
  // pointer line counts toward the auto-load budget).
  const current = loadedBytes(memoryDir);
  const projected = current + Buffer.byteLength(pointer, "utf8");
  if (projected > MEMORY_INDEX_CAP_BYTES) {
    return {
      status: "refused-cap",
      candidatePath: null,
      shardPath: shard,
      currentBytes: current,
      projectedBytes: projected,
      capBytes: MEMORY_INDEX_CAP_BYTES,
    };
  }

  if (existsSync(candidateFile)) {
    // Body exists from a prior partial commit (shard append failed
    // mid-way). Re-attach the pointer; do not overwrite the body.
  } else {
    atomicWriteCandidate(candidate, candidateFile, deps);
  }

  appendFileSync(shard, pointer, "utf8");

  return { status: "committed", candidatePath: candidateFile, shardPath: shard };
}
