#!/usr/bin/env bun
/**
 * jsr-sync — project package metadata to JSR (jsr.io) via the management API.
 *
 * Ensures each publishable `@bounded-systems/*` package exists in its scope and
 * syncs its registry listing from the repo's own metadata:
 *   - description  ← package.json `description` (truncated to JSR's 250 limit)
 *   - GitHub link  ← the publishing repo (default bounded-systems/prx), the link
 *                    that authorises tokenless OIDC publishing
 *   - runtimeCompat← jsr.json `runtimeCompat` (optional)
 *
 * The package list comes from the generated `jsr-manifest.generated.ts` constant
 * (run `bun run jsr:manifest` to refresh it) — NOT a runtime filesystem read.
 * That boundary is deliberate: a `readFileSync` feeding an outbound request trips
 * CodeQL's `js/file-access-to-http`; the generator owns the file reads (file →
 * file), this script only consumes a static import (constant → network).
 *
 * Metadata only — publishing versions is `jsr publish` (the publish-jsr
 * workflow, tokenless OIDC). Creating a package here reserves the name and fills
 * the listing; it does not publish code. Idempotent: safe to re-run.
 *
 * Auth: a JSR personal access token (permission `all`) in $JSR_TOKEN — create
 * one at jsr.io → account → Tokens. Use --dry-run to preview without a token.
 *
 * Usage:
 *   JSR_TOKEN=jsrp_… bun packages/prx/scripts/jsr-sync.ts [--dry-run] [--repo owner/name]
 */

import { JSR_PACKAGES, type JsrPackageMeta } from "./jsr-manifest.generated.ts";

const API = "https://api.jsr.io";
const UA = "prx-jsr-sync/0.1; https://github.com/bounded-systems/prx";
const DRY = process.argv.includes("--dry-run");

// Optional override of the linked publishing repo (argv, not file data).
const repoIdx = process.argv.indexOf("--repo");
const repoArg = repoIdx !== -1 ? process.argv[repoIdx + 1] : undefined;
const REPO_OVERRIDE =
  repoArg && repoArg.includes("/")
    ? { owner: repoArg.split("/")[0]!, name: repoArg.split("/")[1]! }
    : undefined;

const token = process.env.JSR_TOKEN;
if (!token && !DRY) {
  console.error(
    "JSR_TOKEN not set (a jsr.io personal access token, permission `all`). Use --dry-run to preview.",
  );
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": UA,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function patch(base: string, what: string, body: unknown): Promise<void> {
  if (DRY) {
    console.log(`  would set ${what}`);
    return;
  }
  const res = await call("PATCH", base, body);
  if (res.status === 200) console.log(`  set ${what}`);
  else console.error(`  ! ${what} -> ${res.status} ${await res.text()}`);
}

async function syncOne(p: JsrPackageMeta): Promise<void> {
  // scope/pkg are validated at generation time against [a-z0-9-]; encode anyway
  // so the path segments are bounded before they reach the request URL.
  const scope = encodeURIComponent(p.scope);
  const pkg = encodeURIComponent(p.pkg);
  const base = `/scopes/${scope}/packages/${pkg}`;
  const repo = REPO_OVERRIDE ?? p.repo;

  if (DRY) {
    console.log(`  would ensure ${p.name} exists`);
  } else {
    const get = await call("GET", base);
    if (get.status === 404) {
      const res = await call("POST", `/scopes/${scope}/packages`, { package: p.pkg });
      if (res.status !== 200) {
        console.error(`  ! create ${p.name} -> ${res.status} ${await res.text()}`);
        return;
      }
      console.log(`  created ${p.name}`);
    } else if (get.status === 200) {
      console.log(`  exists  ${p.name}`);
    } else {
      console.error(`  ! GET ${base} -> ${get.status} ${await get.text()}`);
      return;
    }
  }

  if (p.description) {
    const desc = p.description.length > 250 ? `${p.description.slice(0, 247)}…` : p.description;
    await patch(base, `description (${desc.length} chars)`, { description: desc });
  }
  await patch(base, `githubRepository ${repo.owner}/${repo.name}`, {
    githubRepository: { owner: repo.owner, name: repo.name },
  });
  if (p.runtimeCompat) await patch(base, "runtimeCompat", { runtimeCompat: p.runtimeCompat });
}

if (JSR_PACKAGES.length === 0) {
  console.log("No packages in the manifest — run `bun run jsr:manifest`.");
  process.exit(0);
}
console.log(`${DRY ? "[dry-run] " : ""}Syncing ${JSR_PACKAGES.length} package(s) to JSR:`);
for (const p of JSR_PACKAGES) {
  console.log(`- ${p.name}`);
  await syncOne(p);
}
console.log("Done.");
