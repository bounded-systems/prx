// Front Desk instant-add coverage — which org repos carry the per-repo
// instant-add template (`.github/workflows/front-desk-add.yml`).
//
// Front Desk (org Project #2) is fed by a hybrid: a per-repo event-driven add
// (the template above — the "instant half") plus a central sweep in
// gh-project-room (the backstop). The sweep covers every repo regardless; the
// template is a latency optimization (sub-second vs. up to a minute). A public
// repo *without* the template is correct but slow. This module enumerates the
// org and reports which repos have it, so the instant half can't silently
// regress to sweep-only as repos are added.
//
// Private repos can't use org-level Actions variables on the current plan, so
// `vars.FRONT_DESK_APP_ID` never resolves there — the instant path is N/A for
// them by design (sweep-only). They are reported but never counted as missing.
//
// Ambient authority (the token) is read through @bounded-systems/env per the
// repo-wide no-ambient-authority guard; network I/O uses fetch (injectable for
// tests), the same pattern as the other src/ GitHub surfaces.

import { getEnv } from "@bounded-systems/env";

const DEFAULT_ORG = "bounded-systems";
const DEFAULT_TEMPLATE = ".github/workflows/front-desk-add.yml";
const API = "https://api.github.com";

export type CoverageStatus = "present" | "missing" | "n/a-private" | "skipped-archived";

export interface CoverageRow {
  readonly repo: string;
  readonly status: CoverageStatus;
}

export interface CoverageReport {
  readonly org: string;
  readonly template: string;
  readonly rows: readonly CoverageRow[];
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly privateRepos: readonly string[];
  readonly archived: readonly string[];
}

export interface AuditOptions {
  /** Org login to scan. Defaults to $FRONT_DESK_ORG or "bounded-systems". */
  readonly org?: string;
  /** Token with repo read on the org. Defaults to $GITHUB_TOKEN / $GH_TOKEN. */
  readonly token?: string;
  /** Template path to look for. Defaults to the front-desk-add workflow. */
  readonly templatePath?: string;
  /** Injectable fetch (production default = global fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Max in-flight contents checks. */
  readonly concurrency?: number;
}

/** Thrown when no token is resolvable from options or the environment. */
export class MissingTokenError extends Error {
  constructor() {
    super(
      "front-desk coverage: no token. Set GITHUB_TOKEN (or GH_TOKEN) to a token with repo read on the org.",
    );
    this.name = "MissingTokenError";
  }
}

interface RepoApiShape {
  readonly name: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly disabled: boolean;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "prx-front-desk-coverage",
  };
}

/** Page through every repo in the org the token can see. */
async function listRepos(
  org: string,
  token: string,
  doFetch: typeof fetch,
): Promise<readonly RepoApiShape[]> {
  const repos: RepoApiShape[] = [];
  for (let page = 1; ; page++) {
    const res = await doFetch(`${API}/orgs/${org}/repos?per_page=100&type=all&page=${page}`, {
      headers: headers(token),
    });
    if (!res.ok) {
      throw new Error(`listing repos for ${org}: ${res.status} ${res.statusText}`);
    }
    const batch = (await res.json()) as RepoApiShape[];
    if (batch.length === 0) break;
    for (const r of batch) {
      repos.push({
        name: r.name,
        private: r.private,
        archived: r.archived,
        disabled: r.disabled,
      });
    }
    if (batch.length < 100) break;
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/** Does this repo carry the template on its default branch? */
async function hasTemplate(
  org: string,
  repo: string,
  templatePath: string,
  token: string,
  doFetch: typeof fetch,
): Promise<boolean> {
  const encoded = templatePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const res = await doFetch(`${API}/repos/${org}/${repo}/contents/${encoded}`, {
    headers: headers(token),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`checking ${repo}/${templatePath}: ${res.status} ${res.statusText}`);
}

/** Bounded-concurrency map, to stay friendly to the API. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * Audit which repos in the org carry the instant-add template. Pure aside from
 * the injected fetch + the env-sourced token, so it is exercisable in tests by
 * passing `fetchImpl` and `token`.
 */
export async function auditFrontDeskCoverage(opts: AuditOptions = {}): Promise<CoverageReport> {
  const org = opts.org ?? getEnv("FRONT_DESK_ORG") ?? DEFAULT_ORG;
  const templatePath = opts.templatePath ?? DEFAULT_TEMPLATE;
  const token = opts.token ?? getEnv("GITHUB_TOKEN") ?? getEnv("GH_TOKEN");
  if (!token) throw new MissingTokenError();
  const doFetch = opts.fetchImpl ?? fetch;
  const concurrency = opts.concurrency ?? 8;

  const repos = await listRepos(org, token, doFetch);
  const rows = await mapLimit<RepoApiShape, CoverageRow>(repos, concurrency, async (r) => {
    if (r.archived || r.disabled) return { repo: r.name, status: "skipped-archived" };
    if (r.private) return { repo: r.name, status: "n/a-private" };
    const present = await hasTemplate(org, r.name, templatePath, token, doFetch);
    return { repo: r.name, status: present ? "present" : "missing" };
  });

  const pick = (s: CoverageStatus): string[] =>
    rows.filter((row) => row.status === s).map((row) => row.repo);

  return {
    org,
    template: templatePath,
    rows,
    present: pick("present"),
    missing: pick("missing"),
    privateRepos: pick("n/a-private"),
    archived: pick("skipped-archived"),
  };
}

const STATUS_TAG: Record<CoverageStatus, string> = {
  present: "✓ instant",
  missing: "✗ MISSING (sweep-only)",
  "n/a-private": "· private (sweep-only by design)",
  "skipped-archived": "· archived",
};

/** Human-readable report. */
export function renderReport(report: CoverageReport): string {
  const lines: string[] = [`Front Desk instant-add coverage — ${report.org}`, ""];
  for (const row of report.rows) {
    lines.push(`  ${STATUS_TAG[row.status].padEnd(34)} ${row.repo}`);
  }
  lines.push(
    "",
    `  ${report.present.length} instant · ${report.missing.length} missing · ` +
      `${report.privateRepos.length} private · ${report.archived.length} archived`,
  );
  if (report.missing.length > 0) {
    lines.push(
      "",
      `  Public repos missing ${report.template} (instant-add won't fire; ` +
        "the central sweep still covers them):",
    );
    for (const r of report.missing) lines.push(`    - ${r}`);
    lines.push(
      "",
      `  Fix: copy ${report.template} into each, and ensure the org variable ` +
        "FRONT_DESK_APP_ID is visible to All repositories.",
    );
  }
  return lines.join("\n");
}
