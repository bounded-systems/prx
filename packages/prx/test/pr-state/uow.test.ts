import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hydrateUnitOfWorkSurfaceFromBoard,
  loadTicketOverlay,
  type TicketOverlay,
} from "../../src/pr-state/uow.ts";
import type { BoardStatusResult } from "../../src/pr-state/github.ts";

describe("uow hydration", () => {
  test("joins generic tickets by canonical id and surfaces orphan sets", () => {
    const board: BoardStatusResult = {
      source: "derived-board",
      repo: "owner/repo",
      remote_freshness: "fresh",
      units: [
        {
          ticket: "GH-1001",
          branch: "GH-1001",
          worktree_path: "/repo/wt1",
          pr: {
            exists: true,
            number: 10,
            title: "Feature",
            url: "https://example.com/10",
            draft: false,
            checks: "green",
            review: "approved",
            approvals: 2,
            mergeable: "mergeable",
          },
          artifacts: { worktree: true, branch: true, pr: true, ticket: true },
          local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
          column: "merge_ready",
          reasons: ["approved + checks green + mergeable + remote fresh"],
        },
        {
          ticket: "GH-1002",
          branch: "GH-1002",
          worktree_path: "/repo/wt2",
          pr: {
            exists: false,
            number: null,
            title: null,
            url: null,
            draft: null,
            checks: null,
            review: null,
            approvals: null,
            mergeable: null,
          },
          artifacts: { worktree: true, branch: true, pr: false, ticket: true },
          local: { clean: false, staged: 0, unstaged: 1, untracked: 0, conflicts: 0 },
          column: "committing",
          reasons: ["local changes before push"],
        },
      ],
    };

    const tickets: TicketOverlay[] = [
      {
        id: "gh-1001",
        source: "github_issue",
        title: "the vendor system async lag",
        status: "In Progress",
        epic: "Async Pipeline Stabilization",
        assignee: "Dana",
        last_updated: "2026-03-19T10:00:00Z",
        url: "https://github.com/owner/repo/issues/1001",
      },
      {
        id: "GH-9999",
        source: "beads",
        title: "Planning only",
        status: "Todo",
        epic: "Weekly Planning",
        assignee: null,
        last_updated: null,
        url: null,
      },
    ];

    const surface = hydrateUnitOfWorkSurfaceFromBoard(board, {
      activeWorkUnitId: "GH-1002",
      activeAgentId: "GH-1002",
      activeState: "running",
      tickets,
    });

    expect(surface.rows).toHaveLength(2);
    expect(surface.rows[0]?.id).toBe("GH-1001");
    expect(surface.rows[0]?.ticket?.title).toBe("the vendor system async lag");
    expect(surface.rows[0]?.ticket?.source).toBe("github_issue");
    expect(surface.rows[0]?.ticket?.epic).toBe("Async Pipeline Stabilization");
    expect(surface.rows[1]?.id).toBe("GH-1002");
    expect(surface.rows[1]?.agent.state).toBe("running");
    expect(surface.rows[1]?.ticket).toBeNull();

    expect(surface.orphans.ticketOnly).toEqual(["GH-9999"]);
    expect(surface.orphans.executionOnly).toEqual(["GH-1002"]);
  });

  test("loadTicketOverlay preserves legacy notion array payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-uow-"));
    const path = join(dir, "notion_tickets.json");
    writeFileSync(
      path,
      JSON.stringify([
        {
          id: "gh-2001",
          title: "Legacy Notion ticket",
          status: "In Progress",
        },
      ]),
    );

    expect(loadTicketOverlay(path)).toEqual([
      {
        id: "GH-2001",
        source: "notion",
        title: "Legacy Notion ticket",
        status: "In Progress",
        epic: null,
        assignee: null,
        last_updated: null,
        url: null,
      },
    ]);
  });

  test("loadTicketOverlay accepts explicit generic ticket payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-uow-"));
    const path = join(dir, "tickets.json");
    writeFileSync(
      path,
      JSON.stringify({
        tickets: [
          {
            id: "gh-3001",
            source: "beads",
            title: "Beads-backed unit",
            status: "Doing",
            epic: "Revenue Integrity",
            assignee: "Dana",
          },
        ],
      }),
    );

    expect(loadTicketOverlay(path)).toEqual([
      {
        id: "GH-3001",
        source: "beads",
        title: "Beads-backed unit",
        status: "Doing",
        epic: "Revenue Integrity",
        assignee: "Dana",
        last_updated: null,
        url: null,
      },
    ]);
  });

  test("fails loudly when branch diverges from the issue-backed work unit id", () => {
    const board: BoardStatusResult = {
      source: "derived-board",
      repo: "owner/repo",
      remote_freshness: "fresh",
      units: [
        {
          ticket: "GH-1001",
          branch: "pr-state-refactor",
          worktree_path: "/repo/wt1",
          pr: {
            exists: true,
            number: 10,
            title: "Feature",
            url: "https://example.com/10",
            draft: false,
            checks: "green",
            review: "approved",
            approvals: 2,
            mergeable: "mergeable",
          },
          artifacts: { worktree: true, branch: true, pr: true, ticket: true },
          local: { clean: true, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
          column: "merge_ready",
          reasons: ["approved + checks green + mergeable + remote fresh"],
        },
      ],
    };

    expect(() =>
      hydrateUnitOfWorkSurfaceFromBoard(board, {
        activeWorkUnitId: "GH-1001",
        activeAgentId: "GH-1001",
        activeState: "running",
        tickets: [],
      }),
    ).toThrow(/branch must match canonical issue-backed work unit id GH-1001/);
  });
});
