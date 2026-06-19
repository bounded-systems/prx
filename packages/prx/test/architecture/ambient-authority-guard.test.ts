// Repo-wide "no ambient authority" guard.
//
// The capability packages own the sanctioned access to ambient authority:
// @bounded-systems/env reads/writes the environment, @bounded-systems/host reads
// host/OS state (home/temp dir, hostname), @bounded-systems/proc spawns subprocesses,
// @bounded-systems/auth resolves credentials, @bounded-systems/build-info exposes baked build values.
// This guard extends the rule to the whole src/ tree so the import graph stays
// the complete dependency graph — a hidden process.env read or raw spawn is a
// dependency that escapes import analysis.
//
//   • Ambient env is FULLY migrated: src/ contains zero raw process.env /
//     Bun.env — that half is a hard guarantee (any reintroduction fails here;
//     route through @bounded-systems/env).
//   • Raw subprocess spawning is still mid-migration: SPAWN_BASELINE pins the
//     files that spawn directly today. The guard fails if a NEW file spawns raw
//     (route through @bounded-systems/proc) or if a baselined file is cleaned without being
//     removed here — so the list only shrinks, toward an empty hard guarantee.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

const ENV_RE = /\bprocess\.env\b|\bBun\.env\b/;
const OS_RE = /\bfrom\s+["']node:os["']/;
const SPAWN_RE =
  /\bchild_process\b|\bspawnSync\b|\bBun\.spawn\b|\bexecSync\b|\bexecFileSync\b|\bDeno\.Command\b/;

// Files in src/ that still spawn subprocesses directly. The @bounded-systems/proc
// migration is complete, so this is empty: every src/ spawn now routes through
// @bounded-systems/proc and any new raw spawn fails the guard outright (a hard guarantee,
// no longer a shrinking allowlist).
const SPAWN_BASELINE = new Set<string>([]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function matching(re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const file of listTsFiles(SRC_ROOT)) {
    if (re.test(readFileSync(file, "utf8"))) out.add(relative(SRC_ROOT, file));
  }
  return out;
}

describe("no ambient authority — repo-wide guard", () => {
  test("src/ reads/writes the environment only through @bounded-systems/env (zero raw process.env)", () => {
    expect([...matching(ENV_RE)].sort()).toEqual([]);
  });

  test("src/ reads host/OS ambient state only through @bounded-systems/host (zero raw node:os)", () => {
    // homedir/tmpdir/hostname are ambient host authority; route them through
    // @bounded-systems/host so the read is a visible import edge (and so $HOME can
    // redirect homeDir in tests). osConstants (a static signal table) lives in
    // @bounded-systems/proc, not here, so prx/src needs node:os for nothing.
    expect([...matching(OS_RE)].sort()).toEqual([]);
  });

  test("no NEW src/ file spawns subprocesses raw (route through @bounded-systems/proc)", () => {
    const newSpawners = [...matching(SPAWN_RE)].filter((f) => !SPAWN_BASELINE.has(f)).sort();
    expect(newSpawners).toEqual([]);
  });

  test("SPAWN_BASELINE has no stale entries — remove a file once it routes through @bounded-systems/proc", () => {
    const current = matching(SPAWN_RE);
    const stale = [...SPAWN_BASELINE].filter((f) => !current.has(f)).sort();
    expect(stale).toEqual([]);
  });
});
