/**
 * `prx delegate repair-assignees` — one-time repair pass for bd records whose
 * `assignee` column was written by the legacy `git config user.name` resolver
 * (pre-GH-2012). Rewrites the matched assignee strings to the operator-supplied
 * GH login so the bd→GH mirror (GH-2011) can project them onto real users.
 *
 * Modes:
 *   --dry-run (default) → list matched ids with the suggested `bd assign` line
 *   --apply             → invoke `bd assign <id> <to>` per match, aggregate
 *
 * Both `--from` and `--to` are required and must be non-empty. The handler
 * routes through `execBd` so the existing policy table covers it (`assign`
 * and `list` are both in `ALLOWED_SUBCOMMANDS`, planner role).
 */

import {
  execBd as defaultExecBd,
  type BdExecResult,
} from "@bounded-systems/bd";

export type RepairAssigneesInput = {
  from: string;
  to: string;
  apply: boolean;
  repoPath: string;
};

export type RepairAssigneesDeps = {
  execBd?: typeof defaultExecBd;
};

export type RepairAssigneesResult = {
  exitCode: number;
  message: string;
};

type BdListRow = {
  id: string;
  title?: string;
  assignee?: string | null;
};

function parseBdList(stdout: string): BdListRow[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.length > 0 ? stdout : "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const rows: BdListRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    if (id === null) continue;
    const title = typeof obj.title === "string" ? obj.title : "";
    const assignee =
      typeof obj.assignee === "string" ? obj.assignee : null;
    rows.push({ id, title, assignee });
  }
  return rows;
}

export function runRepairAssignees(
  input: RepairAssigneesInput,
  deps: RepairAssigneesDeps = {},
): RepairAssigneesResult {
  const from = input.from.trim();
  const to = input.to.trim();
  if (from.length === 0) {
    return {
      exitCode: 2,
      message: "prx delegate repair-assignees: --from must be non-empty",
    };
  }
  if (to.length === 0) {
    return {
      exitCode: 2,
      message: "prx delegate repair-assignees: --to must be non-empty",
    };
  }

  const exec = deps.execBd ?? defaultExecBd;
  const listResult: BdExecResult = exec({
    subcommand: "list",
    args: ["--assignee", from, "--all", "--json", "--limit", "0"],
    cwd: input.repoPath,
    state: "planning",
    role: "planner",
  });
  if (listResult.exitCode !== 0) {
    const detail =
      listResult.stderr.trim() ||
      listResult.stdout.trim() ||
      "bd list failed";
    return {
      exitCode: listResult.exitCode || 1,
      message: `prx delegate repair-assignees: ${detail}`,
    };
  }

  const rows = parseBdList(listResult.stdout);
  if (rows === null) {
    return {
      exitCode: 1,
      message:
        "prx delegate repair-assignees: bd list returned invalid JSON",
    };
  }
  // `bd list --assignee` is the canonical filter, but be defensive: a future
  // bd build that broadens the match (substring / fuzzy) would silently
  // rewrite the wrong records. In-handler equality check keeps the contract
  // crisp.
  const matched = rows.filter((r) => r.assignee === from);

  if (matched.length === 0) {
    return {
      exitCode: 0,
      message: `prx delegate repair-assignees: 0 record(s) matched assignee=${from}`,
    };
  }

  if (!input.apply) {
    const lines: string[] = [];
    lines.push(
      `prx delegate repair-assignees: ${matched.length} record(s) would be rewritten (assignee=${from} → ${to})`,
    );
    for (const row of matched) {
      const title = row.title ?? "";
      lines.push(`  ${row.id}  ${title}  → bd assign ${row.id} ${to}`);
    }
    lines.push("Run with --apply to write.");
    return { exitCode: 0, message: lines.join("\n") };
  }

  const failures: string[] = [];
  const succeeded: string[] = [];
  for (const row of matched) {
    const result = exec({
      subcommand: "assign",
      args: [row.id, to],
      cwd: input.repoPath,
      state: "planning",
      role: "planner",
    });
    if (result.exitCode !== 0) {
      failures.push(row.id);
    } else {
      succeeded.push(row.id);
    }
  }

  if (failures.length > 0) {
    const lines: string[] = [];
    lines.push(
      `prx delegate repair-assignees: rewrote ${succeeded.length}/${matched.length}; ${failures.length} failed: ${failures.join(", ")}`,
    );
    return { exitCode: 1, message: lines.join("\n") };
  }
  return {
    exitCode: 0,
    message: `prx delegate repair-assignees: rewrote ${succeeded.length} record(s) (assignee=${from} → ${to})`,
  };
}
