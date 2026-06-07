/**
 * Provision beads inside a Lima VM (GH-296).
 *
 * Encodes the proven recipe that makes `prx beads <op> --vm` return real data:
 * install bd+dolt (linux-arm64), stand up a beads workspace whose dolt database
 * carries the canonical data under the resolver's name, and write the
 * server-mode metadata bd needs to read it. After this, `prx lima up --cwd <ws>
 * --daemon beads` serves it.
 *
 * Host-orchestrated through the {@link ../keeperd/lima-exec} `Run` seam (every
 * effect is a `limactl shell … bash -lc <script>`), so the orchestration is
 * unit-tested offline; the live path runs against a real VM.
 *
 * Why each piece (learned the hard way, see GH-296):
 *   - bd is fetched from the `gastownhall/beads` release (`bd close` etc. behave
 *     like the host's); dolt from `dolthub/dolt`. Both to `/usr/local/bin` so
 *     they're on beadsd's `sh -c` launch PATH.
 *   - the db is `dolt clone`d into a dir NAMED by {@link resolveDoltDatabaseName}
 *     (reverse-DNS) — a bare `bd bootstrap` would default to `beads` (empty).
 *   - bd reads the clone ONLY with a FULL server-mode `metadata.json`
 *     (`dolt_mode:"server"` + the clone's `project_id`); we read project_id back
 *     from the freshly-cloned db's `metadata` table.
 */

import { spawnRun, type Run, type RunResult } from "../keeperd/lima-exec.ts";
import { resolveDoltDatabaseName } from "../dolt/namespace.ts";

/** Default beads (bd) version to fetch into the VM (matches the host nix pin). */
const DEFAULT_BD_VERSION = "1.0.3";
/** Default dolt version to fetch into the VM. */
const DEFAULT_DOLT_VERSION = "1.86.2";
/** Default in-VM beads workspace (shell-expanded; bd serves from here). */
const DEFAULT_WORKSPACE = "$HOME/prx-vm-beads";

export interface ProvisionVmBeadsDeps {
  run?: Run | undefined;
}

export interface ProvisionVmBeadsOptions {
  /** Lima instance name. */
  vm: string;
  /** Repo origin slug `owner/repo` — drives the reverse-DNS db name + DoltHub URL. */
  originSlug: string;
  /** In-VM workspace dir (shell-expanded). Default `$HOME/prx-vm-beads`. */
  workspace?: string | undefined;
  /** beads release version (linux-arm64) to install. Default 1.0.3. */
  bdVersion?: string | undefined;
  /** dolt release version (linux-arm64) to install. Default 1.86.2. */
  doltVersion?: string | undefined;
}

export interface ProvisionVmBeadsResult {
  /** The resolved dolt database name (reverse-DNS). */
  database: string;
  /** The DoltHub remote the data was cloned from. */
  remote: string;
  /** The in-VM workspace beadsd should serve (`prx lima up --cwd <workspace>`). */
  workspace: string;
}

/** The DoltHub remote URL for a `owner/repo` origin slug. */
export function doltHubUrl(originSlug: string): string {
  return `https://doltremoteapi.dolthub.com/${originSlug}`;
}

/** `limactl shell <vm> -- bash -lc <script>` argv (login shell: $HOME/PATH set). */
function limaBash(vm: string, script: string): string[] {
  return ["shell", "--workdir", "/", vm, "--", "bash", "-lc", script];
}

function requireOk(res: RunResult, what: string): void {
  if (res.status !== 0) {
    throw new Error(`${what} failed (${res.status}): ${res.stderr.trim()}`);
  }
}

/**
 * Provision beads in the VM. Idempotent-ish: re-clones the workspace fresh, and
 * skips bd/dolt install when already present. Returns the db/remote/workspace so
 * the caller can `prx lima up --cwd <workspace> --daemon beads`.
 */
export function provisionVmBeads(
  opts: ProvisionVmBeadsOptions,
  deps: ProvisionVmBeadsDeps = {},
): ProvisionVmBeadsResult {
  const run = deps.run ?? spawnRun;
  const database = resolveDoltDatabaseName(opts.originSlug);
  const remote = doltHubUrl(opts.originSlug);
  const ws = opts.workspace ?? DEFAULT_WORKSPACE;
  const bdVer = opts.bdVersion ?? DEFAULT_BD_VERSION;
  const doltVer = opts.doltVersion ?? DEFAULT_DOLT_VERSION;
  const bdUrl = `https://github.com/gastownhall/beads/releases/download/v${bdVer}/beads_${bdVer}_linux_arm64.tar.gz`;
  const doltUrl = `https://github.com/dolthub/dolt/releases/download/v${doltVer}/dolt-linux-arm64.tar.gz`;

  // 1. Install bd + dolt to /usr/local/bin (skip if already present).
  requireOk(
    run(
      "limactl",
      limaBash(
        opts.vm,
        `set -e; cd /tmp; ` +
          `command -v bd >/dev/null || { curl -fsSL -o bd.tgz ${bdUrl} && tar xzf bd.tgz && sudo install -m0755 bd /usr/local/bin/bd; }; ` +
          `command -v dolt >/dev/null || { curl -fsSL -o dolt.tgz ${doltUrl} && tar xzf dolt.tgz && sudo install -m0755 dolt-linux-arm64/bin/dolt /usr/local/bin/dolt; }`,
      ),
    ),
    `install bd+dolt in ${opts.vm}`,
  );

  // 2. Fresh workspace + git origin (hydrate/bd derive identity from it) + the
  //    reverse-DNS dolt clone of canonical, carrying issue_prefix + data.
  requireOk(
    run(
      "limactl",
      limaBash(
        opts.vm,
        `set -e; rm -rf ${ws}; mkdir -p ${ws}/.beads/dolt; chmod 700 ${ws}/.beads; cd ${ws}; ` +
          `git init -q; git remote add origin https://github.com/${opts.originSlug}.git; ` +
          `printf 'sync.remote: "${remote}"\\n' > .beads/config.yaml; ` +
          `dolt clone ${remote} ${ws}/.beads/dolt/${database}`,
      ),
    ),
    `clone canonical beads into ${opts.vm}`,
  );

  // 3. Read the clone's project_id (bd's server-mode metadata must match it).
  const pid = run(
    "limactl",
    limaBash(
      opts.vm,
      `cd ${ws}/.beads/dolt/${database} && dolt sql -q "select value from metadata where name='_project_id'" -r csv | tail -1`,
    ),
  );
  requireOk(pid, `read project_id from ${database}`);
  const projectId = pid.stdout.trim().split("\n").pop()?.trim() ?? "";

  // 4. Write the FULL server-mode metadata.json so bd reads the cloned db.
  const metadata = JSON.stringify({
    database: "dolt",
    backend: "dolt",
    dolt_mode: "server",
    dolt_database: database,
    project_id: projectId,
  });
  requireOk(
    run(
      "limactl",
      limaBash(opts.vm, `cat > ${ws}/.beads/metadata.json <<'JSON'\n${metadata}\nJSON`),
    ),
    `write metadata.json in ${opts.vm}`,
  );

  // 5. Bring the cloned schema current (the canonical clone predates newer bd
  //    tables, e.g. `wisps`; without this bd reads fail "table not found").
  requireOk(
    run("limactl", limaBash(opts.vm, `cd ${ws} && bd migrate`)),
    `bd migrate in ${opts.vm}`,
  );

  return { database, remote, workspace: ws };
}
