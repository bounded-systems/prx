/**
 * Shared GH/bd issue payload + plain-text renderers for read verbs
 * (`prx intake view`, `prx plan view`, future `prx triage view`).
 *
 * `viewGhIssue` invokes `gh issue view --json …` through the policy-enforcing
 * `execGh` actor and returns a normalized payload; `formatGhPayloadPlain` and
 * `formatBdRecordPlain` produce the title/state/labels/body/comments human
 * readout. Originally lived in `src/intake/intake-view.ts`.
 */

import { processEnv } from "@bounded-systems/env";
import type { ScoutNotionResult } from "../scout/notion.ts";
import type { execGh, GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../triage/triage.ts";
import { IssueResolveError } from "./resolver.ts";

export type GhIssueViewPayload = {
  title: string;
  state: string;
  labels: Array<{ name: string }>;
  body: string;
  comments: Array<{
    author?: { login?: string | undefined } | undefined;
    createdAt?: string | undefined;
    body?: string | undefined;
  }>;
  url: string;
};

export type IssueViewRender =
  | { source: "gh"; payload: GhIssueViewPayload }
  | { source: "bd"; payload: BeadsRecord }
  | { source: "notion"; payload: ScoutNotionResult };

export function viewGhIssue(
  resolved: { number: number; repo?: string },
  exec: typeof execGh,
  verbLabel = "prx issue view",
): GhIssueViewPayload {
  const args: string[] = [
    String(resolved.number),
    "--json",
    "title,state,labels,body,comments,url",
  ];
  if (resolved.repo) {
    args.push("--repo", resolved.repo);
  }
  const result: GhExecResult = exec(
    {
      group: "issue",
      subcommand: "view",
      args,
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "gh issue view failed";
    throw new IssueResolveError(`${verbLabel}: ${detail}`, result.exitCode || 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new IssueResolveError(
      `${verbLabel}: gh issue view --json returned invalid JSON`,
    );
  }
  return normalizeGhPayload(parsed, verbLabel);
}

function normalizeGhPayload(raw: unknown, verbLabel: string): GhIssueViewPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new IssueResolveError(
      `${verbLabel}: gh issue view --json returned non-object`,
    );
  }
  const r = raw as Record<string, unknown>;
  const labels: Array<{ name: string }> = Array.isArray(r.labels)
    ? r.labels
        .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === "object")
        .map((l) => ({ name: typeof l.name === "string" ? l.name : "" }))
    : [];
  const comments: GhIssueViewPayload["comments"] = Array.isArray(r.comments)
    ? r.comments
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c) => ({
          author:
            c.author && typeof c.author === "object"
              ? {
                  login:
                    typeof (c.author as Record<string, unknown>).login === "string"
                      ? ((c.author as Record<string, unknown>).login as string)
                      : undefined,
                }
              : undefined,
          createdAt: typeof c.createdAt === "string" ? c.createdAt : undefined,
          body: typeof c.body === "string" ? c.body : undefined,
        }))
    : [];
  return {
    title: typeof r.title === "string" ? r.title : "",
    state: typeof r.state === "string" ? r.state : "",
    labels,
    body: typeof r.body === "string" ? r.body : "",
    comments,
    url: typeof r.url === "string" ? r.url : "",
  };
}

export function formatIssueViewRender(
  render: IssueViewRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  if (render.source === "gh") {
    return formatGhPayloadPlain(render.payload);
  }
  if (render.source === "notion") {
    return formatNotionResultPlain(render.payload);
  }
  return formatBdRecordPlain(render.payload);
}

export function formatGhPayloadPlain(payload: GhIssueViewPayload): string {
  const labels = payload.labels.map((l) => l.name).filter((n) => n.length > 0).join(", ");
  const lines = [
    `title:  ${payload.title}`,
    `state:  ${payload.state}`,
    `labels: ${labels || "(none)"}`,
    `url:    ${payload.url}`,
    "",
    payload.body.length > 0 ? payload.body : "(no body)",
    "",
    `--- comments (${payload.comments.length}) ---`,
  ];
  for (const c of payload.comments) {
    const author = c.author?.login ?? "unknown";
    const created = c.createdAt ?? "";
    const header = created ? `@${author} (${created}):` : `@${author}:`;
    lines.push("");
    lines.push(header);
    const body = (c.body ?? "").split(/\r?\n/).map((l) => `  ${l}`);
    lines.push(...body);
  }
  return lines.join("\n");
}

export function formatNotionResultPlain(result: ScoutNotionResult): string {
  const lines = [
    `title:    ${result.title}`,
    `uuid:     ${result.uuid}`,
    `task_id:  ${result.task_id ?? "(none)"}`,
    `state:    ${result.state}`,
    `url:      ${result.url ?? "(none)"}`,
    `gh_issue: ${result.gh_issue !== null ? `GH-${result.gh_issue}` : "(none)"}`,
    `bd_id:    ${result.bd_id ?? "(none)"}`,
    "",
    result.body && result.body.length > 0 ? result.body : "(no body)",
  ];
  return lines.join("\n");
}

export function formatBdRecordPlain(record: BeadsRecord): string {
  const priority =
    record.priority === null ? "(unscored)" : `P${record.priority}`;
  const lines = [
    `title:    ${record.title}`,
    `bd-id:    ${record.id}`,
    `status:   ${record.status}`,
    `priority: ${priority}`,
    `type:     ${record.issueType || "(none)"}`,
    `external: ${record.externalRef ?? "(none)"}`,
    "",
    record.description.length > 0 ? record.description : "(no description)",
  ];
  return lines.join("\n");
}
