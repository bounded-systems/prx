// GH-935: enumerate the children of a GH-backed beads epic for the
// `prx session open` epic-refusal hint. Beads parent-child edges are the
// authoritative source per the GH-891 epic content layer.
//
// Contract:
//   findEpicChildren(repoPath, ghIssueNumber, runner) → EpicChild[]
//
// Returns an empty array when the epic isn't projected into beads (the
// refusal still fires from the label check; the message just notes
// "no children registered"). Errors from bd are surfaced as thrown
// Errors so the caller can decide how to format.

import { defaultRunner, type CommandRunner } from "../pr-state/github.ts";
import { bdDoorGate } from "@bounded-systems/bd";

export type EpicChild = {
  ghNumber: number;
  title: string;
  state: "open" | "closed";
};

type BdReadResult = { stdout: string; stderr: string; status: number };

/**
 * A door-gated `bd` read (GH-296 / prx-zbsi). In the box profile
 * (PRX_BEADS_DOOR) the read dials the beadsd door — never a local `bd`;
 * off-profile the gate returns null and we spawn via the injected runner
 * exactly as before (byte-identical). The `bd dep list … --type parent-child`
 * read maps to the door's `children` verb in the dialer, so its argv and
 * result shape are unchanged. Gating here also keeps these bd reads off
 * `defaultRunner`'s GitHub rate-limit bucket in-box.
 */
function bdRead(cmd: string[], cwd: string, runner: CommandRunner): BdReadResult {
  const gated = bdDoorGate(cmd);
  if (gated) return { stdout: gated.stdout, stderr: gated.stderr, status: gated.exitCode };
  return runner(cmd, { cwd, check: false });
}

type BdIssueRow = {
  id: string;
  title: string;
  status: string;
  issue_type?: string;
  external_ref?: string | null;
  dependency_count?: number;
  dependent_count?: number;
};

type BdDepRow = {
  // The bd JSON for `bd dep list` exposes the edge endpoints; field naming
  // has varied across releases, so accept any of the common shapes. bd v1.x
  // emits each row as the child issue object with `dependency_type` appended,
  // so the child id arrives in `id` rather than an explicit edge endpoint.
  id?: string;
  dependency_type?: string;
  from?: string;
  to?: string;
  source_id?: string;
  target_id?: string;
  dependent_id?: string;
  depends_on_id?: string;
  issue_id?: string;
  type?: string;
  dep_type?: string;
};

function ghNumberFromExternalRef(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const match = ref.match(/\/issues\/(\d+)(?:\/)?$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function loadBeadsSnapshot(repoPath: string, runner: CommandRunner): BdIssueRow[] {
  const result = bdRead(["bd", "list", "--all", "--json"], repoPath, runner);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || "bd list --json failed");
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("bd list --json did not return an array");
  }
  return parsed.filter(
    (row): row is BdIssueRow =>
      Boolean(row) &&
      typeof row === "object" &&
      typeof (row as BdIssueRow).id === "string" &&
      typeof (row as BdIssueRow).title === "string" &&
      typeof (row as BdIssueRow).status === "string",
  );
}

function loadParentChildDeps(
  repoPath: string,
  epicBeadId: string,
  runner: CommandRunner,
): BdDepRow[] {
  const result = bdRead(
    ["bd", "dep", "list", epicBeadId, "--direction", "up", "--type", "parent-child", "--json"],
    repoPath,
    runner,
  );
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout).trim() || `bd dep list ${epicBeadId} failed`,
    );
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) return [];
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    // Some bd versions return a map keyed by issue id; flatten to a single
    // array of edges.
    if (parsed && typeof parsed === "object") {
      const flat: BdDepRow[] = [];
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            if (v && typeof v === "object") flat.push(v as BdDepRow);
          }
        }
      }
      return flat;
    }
    return [];
  }
  return parsed.filter((row): row is BdDepRow => Boolean(row) && typeof row === "object");
}

// The `direction=up` query asks "what depends on this epic" — children carry
// the parent-child edge whose target is the epic. Different bd JSON shapes
// place the child id under different keys; `pickChildId` covers the common
// ones, scoped so the epic id never gets mis-classified as a child.
function pickChildId(edge: BdDepRow, epicBeadId: string): string | null {
  // bd v1.x emits each row as the child issue object with `dependency_type`
  // appended; the child's bead id is in `id`. Older shapes use from/source_id/
  // dependent_id/issue_id. The `!== epicBeadId` guard below keeps `id` safe
  // even if a future bd shape ever uses `id` for the edge's own id — that
  // string would not equal the epic id.
  const candidates = [edge.id, edge.from, edge.source_id, edge.dependent_id, edge.issue_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0 && candidate !== epicBeadId) {
      return candidate;
    }
  }
  // Fallback: if only `to` is present and points away from the epic, take it.
  // Some shapes only record the non-self endpoint.
  if (typeof edge.to === "string" && edge.to !== epicBeadId) return edge.to;
  if (typeof edge.depends_on_id === "string" && edge.depends_on_id !== epicBeadId) {
    return edge.depends_on_id;
  }
  if (typeof edge.target_id === "string" && edge.target_id !== epicBeadId) {
    return edge.target_id;
  }
  return null;
}

export function findEpicChildren(
  repoPath: string,
  ghIssueNumber: number,
  runner: CommandRunner = defaultRunner,
): EpicChild[] {
  const snapshot = loadBeadsSnapshot(repoPath, runner);
  const epic = snapshot.find(
    (row) => ghNumberFromExternalRef(row.external_ref) === ghIssueNumber,
  );
  if (!epic) return [];

  const edges = loadParentChildDeps(repoPath, epic.id, runner);
  const byBeadId = new Map(snapshot.map((row) => [row.id, row]));

  const seen = new Set<number>();
  const children: EpicChild[] = [];
  for (const edge of edges) {
    const childId = pickChildId(edge, epic.id);
    if (!childId) continue;
    const child = byBeadId.get(childId);
    if (!child) continue;
    const ghNumber = ghNumberFromExternalRef(child.external_ref);
    if (ghNumber === null) continue;
    if (seen.has(ghNumber)) continue;
    seen.add(ghNumber);
    children.push({
      ghNumber,
      title: child.title,
      state: child.status.toLowerCase() === "closed" ? "closed" : "open",
    });
  }
  // Stable ordering for deterministic output: ascending GH number.
  children.sort((a, b) => a.ghNumber - b.ghNumber);
  return children;
}
