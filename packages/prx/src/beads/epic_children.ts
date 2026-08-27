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
import { frontDeskBeadsRaw } from "./frontdesk-list.ts";

export type EpicChild = {
  ghNumber: number;
  title: string;
  state: "open" | "closed";
};

// GH-1011: one raw Front Desk row (as `frontDeskBeadsRaw` emits — GH-canonical).
type FdRow = {
  id: string;
  title: string;
  status: string;
  dependencies?: { issue_id: string; depends_on_id: string; type: string }[];
};

function ghNumFromId(id: string): number | null {
  const m = id.match(/^GH-(\d+)$/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * GH-1011 / closes GH-1010's children half: enumerate epic children from Front
 * Desk (GH-canonical) instead of beads. The epic is `GH-<ghIssueNumber>`; its
 * parent-child children are the `depends_on_id`s of its parent-child dep edges.
 * No bd bead id anywhere — Front Desk speaks GH numbers natively.
 */
function findEpicChildrenViaFrontDesk(ghIssueNumber: number, rows: FdRow[]): EpicChild[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const epic = byId.get(`GH-${ghIssueNumber}`);
  if (!epic) return [];
  const seen = new Set<number>();
  const children: EpicChild[] = [];
  for (const dep of epic.dependencies ?? []) {
    if (dep.type !== "parent-child") continue;
    const child = byId.get(dep.depends_on_id);
    if (!child) continue;
    const n = ghNumFromId(child.id);
    if (n === null || seen.has(n)) continue;
    seen.add(n);
    children.push({
      ghNumber: n,
      title: child.title,
      state: child.status.toLowerCase() === "closed" ? "closed" : "open",
    });
  }
  children.sort((a, b) => a.ghNumber - b.ghNumber);
  return children;
}

export function findEpicChildren(
  repoPath: string,
  ghIssueNumber: number,
  runner: CommandRunner = defaultRunner,
  frontDeskRows: (cwd: string) => unknown[] = frontDeskBeadsRaw,
): EpicChild[] {
  return findEpicChildrenViaFrontDesk(ghIssueNumber, frontDeskRows(repoPath) as FdRow[]);
}
