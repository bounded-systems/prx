/**
 * Provision the canonical beads clone on the LOCAL host (GH-296).
 *
 * The host twin of {@link ./provision.provisionVmBeads}: it stands up a single
 * canonical beads workspace — by default at `~/.local/state/prx/beads` (see
 * {@link ./client-factory.resolveLocalBeadsCwd}) — whose dolt database carries
 * the canonical data under the reverse-DNS name, with the server-mode
 * `metadata.json` bd needs to read it. After this, the local beadsd
 * (`prx beads serve`, auto-started by `withBeadsClient`) serves ONE healthy
 * beads from every worktree, instead of each clone's own (possibly broken)
 * `.beads`.
 *
 * Unlike the VM recipe there's no bd/dolt install step — the host already has
 * them (nix). Every effect runs through the {@link ../door/lima-exec} `Run`
 * seam as `bash -lc <script>` (login shell ⇒ nix PATH), so the orchestration is
 * unit-tested offline.
 */

import { spawnRun, type Run, type RunResult } from "../door/lima-exec.ts";
import { resolveDoltDatabaseName, doltHubUrl } from "../dolt/namespace.ts";

export interface ProvisionLocalBeadsDeps {
  run?: Run | undefined;
}

export interface ProvisionLocalBeadsOptions {
  /** Repo origin slug `owner/repo` — drives the reverse-DNS db name + DoltHub URL. */
  originSlug: string;
  /** Workspace dir the local beadsd serves (the resolved canonical clone path). */
  cwd: string;
}

export interface ProvisionLocalBeadsResult {
  /** The resolved dolt database name (reverse-DNS). */
  database: string;
  /** The DoltHub remote the data was cloned from. */
  remote: string;
  /** The workspace beadsd should serve (== `opts.cwd`). */
  workspace: string;
}

/** `bash -lc <script>` argv (login shell so nix-installed bd/dolt are on PATH). */
function bashLogin(script: string): string[] {
  return ["-lc", script];
}

function requireOk(res: RunResult, what: string): void {
  if (res.status !== 0) {
    throw new Error(`${what} failed (${res.status}): ${res.stderr.trim()}`);
  }
}

/**
 * Provision the canonical beads clone locally. Re-clones the workspace fresh
 * each run. Returns the db/remote/workspace; afterwards `resolveLocalBeadsCwd`
 * picks up the well-known path automatically and the local daemon serves it.
 */
export function provisionLocalBeads(
  opts: ProvisionLocalBeadsOptions,
  deps: ProvisionLocalBeadsDeps = {},
): ProvisionLocalBeadsResult {
  const run = deps.run ?? spawnRun;
  const database = resolveDoltDatabaseName(opts.originSlug);
  const remote = doltHubUrl(opts.originSlug);
  const ws = opts.cwd;

  // 0. Require bd + dolt on PATH (the host has them via nix — no install step).
  requireOk(
    run("bash", bashLogin(`command -v bd >/dev/null && command -v dolt >/dev/null`)),
    `bd and dolt must be installed on the host PATH`,
  );

  // 1. Fresh workspace + git origin (bd/hydrate derive identity from it) + the
  //    reverse-DNS dolt clone of canonical, carrying issue_prefix + data.
  requireOk(
    run(
      "bash",
      bashLogin(
        `set -e; rm -rf ${ws}; mkdir -p ${ws}/.beads/dolt; chmod 700 ${ws}/.beads; cd ${ws}; ` +
          `git init -q; git remote add origin https://github.com/${opts.originSlug}.git; ` +
          `printf 'sync.remote: "${remote}"\\n' > .beads/config.yaml; ` +
          `dolt clone ${remote} ${ws}/.beads/dolt/${database}`,
      ),
    ),
    `clone canonical beads into ${ws}`,
  );

  // 2. Read the clone's project_id (bd's server-mode metadata must match it).
  const pid = run(
    "bash",
    bashLogin(
      `cd ${ws}/.beads/dolt/${database} && dolt sql -q "select value from metadata where name='_project_id'" -r csv | tail -1`,
    ),
  );
  requireOk(pid, `read project_id from ${database}`);
  const projectId = pid.stdout.trim().split("\n").pop()?.trim() ?? "";

  // 3. Write the FULL server-mode metadata.json so bd reads the cloned db.
  const metadata = JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_mode: "server",
    dolt_database: database,
    project_id: projectId,
  });
  requireOk(
    run("bash", bashLogin(`cat > ${ws}/.beads/metadata.json <<'JSON'\n${metadata}\nJSON`)),
    `write metadata.json in ${ws}`,
  );

  // 4. Bring the cloned schema current (canonical predates newer bd tables).
  requireOk(run("bash", bashLogin(`cd ${ws} && bd migrate`)), `bd migrate in ${ws}`);

  return { database, remote, workspace: ws };
}
