import { existsSync, readFileSync } from "node:fs";

import {
  canonicalWorkUnitIdFromBranchName,
  requireCanonicalWorkUnitId,
} from "../machine/work_unit.ts";
import {
  boardStatus,
  type BoardStatusResult,
  type BoardUnit,
  type CommandRunner,
  type RemoteFreshness,
} from "./github.ts";

export type TicketSystem = "notion" | "github_issue" | "beads" | "other";

export type TicketOverlay = {
  id: string;
  source: TicketSystem;
  title: string | null;
  status: string | null;
  epic: string | null;
  assignee: string | null;
  last_updated: string | null;
  url: string | null;
};

export type UnitOfWorkSurfaceRow = {
  id: string;
  branch: string;
  board: BoardUnit["column"];
  prNumber: number | null;
  worktree: boolean;
  agent: {
    id: string;
    state: "idle" | "running" | "done" | "error";
  };
  ticket: TicketOverlay | null;
};

export type UnitOfWorkSurface = {
  repo: string;
  remoteFreshness: RemoteFreshness;
  rows: UnitOfWorkSurfaceRow[];
  orphans: {
    ticketOnly: string[];
    executionOnly: string[];
  };
};

type TicketPayload = {
  tickets: TicketOverlay[];
};

type LegacyNotionOverlay = {
  id: string;
  title?: string | null;
  status?: string | null;
  epic?: string | null;
  assignee?: string | null;
  last_updated?: string | null;
  url?: string | null;
};

function normalizeId(input: string): string {
  return input.trim().toUpperCase();
}

function resolveUnitOfWorkId(unit: BoardUnit): string {
  const ticketId = unit.ticket ? requireCanonicalWorkUnitId(unit.ticket, "ticket id") : null;
  const branchId = canonicalWorkUnitIdFromBranchName(unit.branch);

  if (ticketId && branchId !== ticketId) {
    throw new Error(
      `branch must match canonical issue-backed work unit id ${ticketId}: ${unit.branch}`,
    );
  }

  if (ticketId) {
    return ticketId;
  }

  if (branchId) {
    return branchId;
  }

  return normalizeId(unit.branch);
}

function normalizeTicketOverlay(
  row: Partial<TicketOverlay>,
  fallbackSource: TicketSystem,
): TicketOverlay | null {
  if (typeof row.id !== "string" || row.id.trim().length === 0) {
    return null;
  }

  const source = row.source ?? fallbackSource;
  return {
    id: normalizeId(row.id),
    source,
    title: row.title ?? null,
    status: row.status ?? null,
    epic: row.epic ?? null,
    assignee: row.assignee ?? null,
    last_updated: row.last_updated ?? null,
    url: row.url ?? null,
  };
}

function parseTicketPayload(content: string): TicketPayload {
  const parsed = JSON.parse(content) as unknown;

  if (Array.isArray(parsed)) {
    const tickets = parsed
      .map((row) => normalizeTicketOverlay(row as LegacyNotionOverlay, "notion"))
      .filter((row): row is TicketOverlay => row !== null);
    return { tickets };
  }

  if (parsed && typeof parsed === "object" && "tickets" in parsed) {
    const obj = parsed as { tickets?: Array<Partial<TicketOverlay>> };
    const tickets = (obj.tickets ?? [])
      .map((row) => normalizeTicketOverlay(row, "other"))
      .filter((row): row is TicketOverlay => row !== null);
    return { tickets };
  }

  return { tickets: [] };
}

export function loadTicketOverlay(path: string): TicketOverlay[] {
  if (!path || !existsSync(path)) {
    return [];
  }
  try {
    const raw = readFileSync(path, "utf8");
    return parseTicketPayload(raw).tickets;
  } catch {
    return [];
  }
}

export function hydrateUnitOfWorkSurface(
  repoPath: string,
  options: {
    activeWorkUnitId: string;
    activeAgentId: string;
    activeState: "idle" | "running" | "done" | "error";
    ticketPath?: string;
    notionPath?: string;
  },
  runner?: CommandRunner,
): UnitOfWorkSurface {
  const board = boardStatus(repoPath, runner);
  return hydrateUnitOfWorkSurfaceFromBoard(board, options);
}

export function hydrateUnitOfWorkSurfaceFromBoard(
  board: BoardStatusResult,
  options: {
    activeWorkUnitId: string;
    activeAgentId: string;
    activeState: "idle" | "running" | "done" | "error";
    ticketPath?: string;
    notionPath?: string;
    tickets?: TicketOverlay[];
  },
): UnitOfWorkSurface {
  const ticketPath = options.ticketPath ?? options.notionPath ?? "";
  const tickets = options.tickets ?? loadTicketOverlay(ticketPath);
  const ticketById = new Map(tickets.map((ticket) => [normalizeId(ticket.id), ticket]));
  const executionIds = new Set<string>();

  const rows = board.units.map((unit: BoardUnit) => {
    const id = resolveUnitOfWorkId(unit);
    executionIds.add(id);
    const isActive = id === normalizeId(options.activeWorkUnitId);
    const agentId = isActive ? normalizeId(options.activeAgentId) : id;
    const ticket = ticketById.get(id) ?? null;

    return {
      id,
      branch: unit.branch,
      board: unit.column,
      prNumber: unit.pr.number,
      worktree: unit.artifacts.worktree,
      agent: {
        id: agentId,
        state: isActive ? options.activeState : "idle",
      },
      ticket,
    } as UnitOfWorkSurfaceRow;
  });

  const ticketOnly = tickets
    .map((ticket) => normalizeId(ticket.id))
    .filter((id) => !executionIds.has(id))
    .sort((a, b) => a.localeCompare(b));

  const executionOnly = rows
    .filter((row) => row.ticket === null)
    .map((row) => row.id)
    .sort((a, b) => a.localeCompare(b));

  rows.sort((a, b) => a.id.localeCompare(b.id));

  return {
    repo: board.repo,
    remoteFreshness: board.remote_freshness,
    rows,
    orphans: {
      ticketOnly,
      executionOnly,
    },
  };
}
