#!/usr/bin/env bun
/**
 * front-desk-coverage — audit which org repos carry the instant-add template
 * (`.github/workflows/front-desk-add.yml`), so the Front Desk *instant* path
 * can't silently drift to sweep-only as new repos appear.
 *
 * Context: Front Desk (org Project #2) is fed by a hybrid — a per-repo
 * event-driven add (the template above, the "instant half") plus a central
 * sweep in gh-project-room (the backstop). The sweep covers every repo
 * regardless; the template is a latency optimization (sub-second vs. up to a
 * minute). A public repo *without* the template is correct but slow; this
 * script flags those so the rollout stays complete.
 *
 * Private repos can't use org-level Actions variables on the current plan, so
 * `vars.FRONT_DESK_APP_ID` never resolves there — the instant path is N/A for
 * them by design (they're sweep-only). They are reported but never fail.
 *
 *   GITHUB_TOKEN=… bun run front-desk:coverage         # human-readable report
 *   GITHUB_TOKEN=… bun run front-desk:coverage --json  # machine-readable
 *   GITHUB_TOKEN=… bun run front-desk:coverage --check  # exit 1 if a public,
 *                                                        # non-archived repo
 *                                                        # lacks the template
 *
 * Token: any token with repo read on the org (the Front Desk App token in CI,
 * or a PAT locally). Read from GITHUB_TOKEN or GH_TOKEN.
 */

const ORG = process.env.FRONT_DESK_ORG ?? "bounded-systems";
const TEMPLATE_PATH = ".github/workflows/front-desk-add.yml";
const API = "https://api.github.com";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!TOKEN) {
  console.error(
    "front-desk-coverage: no token. Set GITHUB_TOKEN (or GH_TOKEN) to a token with repo read on the org.",
  );
  process.exit(2);
}

const JSON_OUT = process.argv.includes("--json");
const CHECK = process.argv.includes("--check");

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "prx-front-desk-coverage",
} as const;

interface Repo {
  readonly name: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly disabled: boolean;
}

/** Page through every repo in the org (public + private the token can see). */
async function listRepos(): Promise<readonly Repo[]> {
  const repos: Repo[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${API}/orgs/${ORG}/repos?per_page=100&type=all&page=${page}`,
      { headers: HEADERS },
    );
    if (!res.ok) {
      throw new Error(
        `listing repos for ${ORG}: ${res.status} ${res.statusText}`,
      );
    }
    const batch = (await res.json()) as Repo[];
    if (batch.length === 0) break;
    repos.push(
      ...batch.map((r) => ({
        name: r.name,
        private: r.private,
        archived: r.archived,
        disabled: r.disabled,
      })),
    );
    if (batch.length < 100) break;
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

/** Does this repo carry the instant-add template on its default branch? */
async function hasTemplate(repo: string): Promise<boolean> {
  const res = await fetch(
    `${API}/repos/${ORG}/${repo}/contents/${encodeURIComponent(TEMPLATE_PATH).replace(/%2F/g, "/")}`,
    { headers: HEADERS },
  );
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(
    `checking ${repo}/${TEMPLATE_PATH}: ${res.status} ${res.statusText}`,
  );
}

type Status = "present" | "missing" | "n/a-private" | "skipped-archived";

interface Row {
  readonly repo: string;
  readonly status: Status;
}

/** Bounded-concurrency map to stay friendly to the API. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

async function main(): Promise<void> {
  const repos = await listRepos();
  const rows = await mapLimit<Repo, Row>(repos, 8, async (r) => {
    if (r.archived || r.disabled)
      return { repo: r.name, status: "skipped-archived" };
    if (r.private) return { repo: r.name, status: "n/a-private" };
    return {
      repo: r.name,
      status: (await hasTemplate(r.name)) ? "present" : "missing",
    };
  });

  const by = (s: Status) => rows.filter((row) => row.status === s);
  const missing = by("missing");

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          org: ORG,
          template: TEMPLATE_PATH,
          total: rows.length,
          present: by("present").map((r) => r.repo),
          missing: missing.map((r) => r.repo),
          private: by("n/a-private").map((r) => r.repo),
          archived: by("skipped-archived").map((r) => r.repo),
        },
        null,
        2,
      ),
    );
  } else {
    const tag: Record<Status, string> = {
      present: "✓ instant",
      missing: "✗ MISSING (sweep-only)",
      "n/a-private": "· private (sweep-only by design)",
      "skipped-archived": "· archived",
    };
    console.log(`Front Desk instant-add coverage — ${ORG}\n`);
    for (const row of rows) {
      console.log(`  ${tag[row.status].padEnd(34)} ${row.repo}`);
    }
    console.log(
      `\n  ${by("present").length} instant · ${missing.length} missing · ` +
        `${by("n/a-private").length} private · ${by("skipped-archived").length} archived`,
    );
    if (missing.length > 0) {
      console.log(
        `\n  Public repos missing ${TEMPLATE_PATH} (instant-add won't fire; ` +
          `the central sweep still covers them):`,
      );
      for (const r of missing) console.log(`    - ${r.repo}`);
      console.log(
        `\n  Fix: copy ${TEMPLATE_PATH} into each, and ensure the org variable ` +
          `FRONT_DESK_APP_ID is visible to All repositories.`,
      );
    }
  }

  if (CHECK && missing.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(
    `front-desk-coverage: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
});
