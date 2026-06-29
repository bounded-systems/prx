// beads door-gate boundary — the read/host split for bd spawns (prx-zbsi).
//
// GH-296 AC #3: in the box profile every `bd` spawn must be either
//   (A) routed through the beadsd door (a READ — list/ready/show/children), or
//   (B) host-only (the dolt-lifecycle / workspace-management ops: init,
//       bootstrap, doctor, migrate, schema-repair, dolt start/stop, config),
//       which ENOENT-fail in the box by design — there is no local `bd`.
//
// The hazard the AC names is a host op being SILENTLY served by the read door
// instead of failing closed (managing the dolt daemon through the read door is
// incoherent). The structural guarantee that prevents it: the door-gate
// primitives are referenced ONLY by the sanctioned read sites, never by a
// host-management file. This guard pins that boundary — a host file that starts
// door-gating, or a new read site that gates without being declared here, fails
// the test. (Mirrors the SPAWN_BASELINE / seam-guard pattern in
// architecture/ambient-authority-guard.test.ts.)
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

// The door-gate primitives (defined in beadsd/bd-command-runner.ts + bd's
// bdDoorGate). A file referencing any of these door-routes a bd read.
const GATE_RE =
  /\bbdDoorGate\b|\bbdCommandRunner\b|\bbdSpawnCapture\b|\bdoorGatedCommandRunner\b|\bdoorGatedSpawnCapture\b/;

// A literal `bd` command array — `["bd", …]` or `["bd"` — i.e. a direct spawn.
const BD_SPAWN_RE = /\[\s*"bd"/;

// The ONLY src files allowed to door-gate a bd read. Adding a new door-backed
// read means adding it here deliberately; a host-management / dolt-lifecycle
// file appearing here is the bug this guard catches.
const GATE_USERS = [
  "beadsd/bd-command-runner.ts", // defines the door-gate wrappers
  "pr-state/github.ts", // hydrateBeads (bd show)
  "pr-state/cli.ts", // readBdLabels + resolveEpicChildBdIds
  "pipeline/agent-result.ts", // bd list read
  "pipeline/edges/intake-triage.ts", // bd show read
  "beads/epic_children.ts", // bd list + bd dep list (parent-child)
  "beads/workspace_mode.ts", // bd list probe
].sort();

// Host-management / dolt-lifecycle files that spawn `bd` directly. These are
// intentionally NOT door-routed (host-invoked; ENOENT-fail in the box). They
// must never reference the door gate.
const HOST_ONLY_BD = [
  "beads/doctor.ts",
  "beads/schema_repair.ts",
  "beads/migrate.ts",
  "beads/hydrate.ts",
  "dolt/start.ts",
  "pr-state/repo_add_dolthub.ts",
  "pr-state/repo_bootstrap.ts",
  "pr-state/repos.ts",
  // prx-82b 2e.2: fetch/watermark.ts + fetch/slack-watermark.ts no longer spawn
  // bd — the fetch cursor is a host-local FILE now (neither door-gated nor
  // host-bd), so they belong in neither list.
];

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

describe("beads door-gate boundary (prx-zbsi)", () => {
  test("only the sanctioned read sites door-gate a bd read", () => {
    expect([...matching(GATE_RE)].sort()).toEqual(GATE_USERS);
  });

  test("host-management bd spawns stay host-only (spawn bd, never reference the door gate)", () => {
    for (const rel of HOST_ONLY_BD) {
      const src = readFileSync(join(SRC_ROOT, rel), "utf8");
      // It really does spawn bd directly…
      expect(BD_SPAWN_RE.test(src)).toBe(true);
      // …but never through the read-door gate.
      expect(GATE_RE.test(src)).toBe(false);
    }
  });
});
