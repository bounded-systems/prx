#!/usr/bin/env bun
/**
 * jsr-sync — project package metadata to JSR (jsr.io) via the management API.
 *
 * For every `packages/<x>/jsr.json` (the packages marked publishable to JSR),
 * ensure the package exists in its scope and sync its registry listing from the
 * repo's own single source of truth:
 *   - description  ← package.json `description` (truncated to JSR's 250 limit)
 *   - GitHub link  ← the publishing repo (default bounded-systems/prx), the link
 *                    that authorises tokenless OIDC publishing
 *   - runtimeCompat← jsr.json `runtimeCompat` (optional)
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.jsr.io";
const UA = "prx-jsr-sync/0.1; https://github.com/bounded-systems/prx";
const DRY = process.argv.includes("--dry-run");

const repoIdx = process.argv.indexOf("--repo");
const DEFAULT_REPO = repoIdx !== -1 ? process.argv[repoIdx + 1]! : "bounded-systems/prx";

const token = process.env.JSR_TOKEN;
if (!token && !DRY) {
  console.error(
    "JSR_TOKEN not set (a jsr.io personal access token, permission `all`). Use --dry-run to preview.",
  );
  process.exit(1);
}

// packages/prx/scripts → packages/
const packagesDir = join(import.meta.dir, "..", "..");

interface PkgMeta {
  name: string;
  scope: string;
  pkg: string;
  description?: string | undefined;
  repo: { owner: string; name: string };
  runtimeCompat?: Record<string, boolean | null> | undefined;
}

function discover(): PkgMeta[] {
  const [defOwner, defName] = DEFAULT_REPO.split("/");
  const out: PkgMeta[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    if (!existsSync(join(dir, "jsr.json"))) continue;
    const jsr = JSON.parse(readFileSync(join(dir, "jsr.json"), "utf8")) as {
      name?: string;
      githubRepository?: { owner: string; name: string };
      runtimeCompat?: Record<string, boolean | null>;
    };
    // Strict scope/pkg validation: these segments are interpolated into the
    // request URL, so restrict to JSR's actual naming rule (lowercase
    // alphanumerics + hyphens). This is also the sanitizer that bounds the
    // file-derived value before it reaches the network path.
    const m = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(jsr.name ?? "");
    if (!m) {
      console.warn(`skip ${dir}: jsr.json name is not a valid @scope/pkg (${jsr.name})`);
      continue;
    }
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      description?: string;
    };
    out.push({
      name: jsr.name!,
      scope: m[1]!,
      pkg: m[2]!,
      description: pj.description,
      repo: jsr.githubRepository ?? { owner: defOwner!, name: defName! },
      runtimeCompat: jsr.runtimeCompat,
    });
  }
  return out;
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

async function syncOne(p: PkgMeta): Promise<void> {
  // scope/pkg are validated in discover() against [a-z0-9-]; encode anyway so
  // the file-derived segments are bounded before they reach the request URL.
  const scope = encodeURIComponent(p.scope);
  const pkg = encodeURIComponent(p.pkg);
  const base = `/scopes/${scope}/packages/${pkg}`;

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
    const desc =
      p.description.length > 250 ? `${p.description.slice(0, 247)}…` : p.description;
    await patch(base, `description (${desc.length} chars)`, { description: desc });
  }
  await patch(base, `githubRepository ${p.repo.owner}/${p.repo.name}`, {
    githubRepository: { owner: p.repo.owner, name: p.repo.name },
  });
  if (p.runtimeCompat) await patch(base, "runtimeCompat", { runtimeCompat: p.runtimeCompat });
}

const pkgs = discover();
if (pkgs.length === 0) {
  console.log("No packages with a jsr.json found — nothing to sync.");
  process.exit(0);
}
console.log(`${DRY ? "[dry-run] " : ""}Syncing ${pkgs.length} package(s) to JSR:`);
for (const p of pkgs) {
  console.log(`- ${p.name}`);
  await syncOne(p);
}
console.log("Done.");
