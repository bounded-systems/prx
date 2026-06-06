# Running CI locally

prx has two layers of CI, and you can run both before pushing.

| Layer | What it is | How to run locally |
| --- | --- | --- |
| **Validation** | `install → typecheck → docs → build → test` — the checks that actually gate a PR. | `dist/prx ci` (or per phase: `dist/prx ci --phase=test`) |
| **Workflow** | The `.github/workflows/*.yml` job graph that wraps the validation layer — runner image, permissions, pinned-SHA actions, caching. | `bun run ci:act` (this page) |

`.github/workflows/ci.yml` is a thin shell over `dist/prx ci`, so the
validation layer rarely surprises you. The **workflow** layer is what `act`
reproduces: it catches a broken `uses:` pin, a permissions typo, a step that
only fails inside the runner image — before the PR does.

## TL;DR

```bash
# from the repo root, with a Docker daemon running:
bun run ci:act
```

That runs the `ci` job of `.github/workflows/ci.yml` in a runner container via
[`act`](https://github.com/nektos/act). Everything after `--` is passed
straight through to `act`:

```bash
bun run ci:act -- -l                                   # list jobs
bun run ci:act -- -n                                   # dry-run, no containers
bun run ci:act -- -W .github/workflows/coverage.yml    # a different workflow
bun run ci:act -- --container-architecture linux/amd64 # Apple Silicon escape hatch
```

The wrapper (`packages/prx/scripts/local-ci-act`) preflights `act` and the
Docker daemon and prints install/start hints if either is missing.

## Prerequisites

### 1. `act`

```bash
brew install act
# or: curl -fsSL https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash -s -- -b /usr/local/bin
# or: nix shell nixpkgs#act
```

`act` reads the repo's [`.actrc`](../.actrc), which pins the `ubuntu-latest`
runner to `catthehacker/ubuntu:act-22.04` — an image that bundles the tooling
GitHub's hosted runners ship with. (Our workflows install bun themselves via
`setup-bun`, so the runner image only needs the basics.)

### 2. A Docker daemon

`act` runs jobs in containers, so it needs a reachable Docker daemon. On Linux
you likely already have one. On macOS pick one of:

- **Colima** (Lima + Docker, the lightest path):
  ```bash
  brew install colima docker
  colima start
  ```
- **Docker Desktop** — just have it running.
- **The bundled Lima VM** — see below. Useful if you want a disposable,
  reproducible Linux box rather than a daemon on your host.

If a daemon is running somewhere non-standard, point `DOCKER_HOST` at its socket.

## Option: the bundled Lima VM

[`lima/prx.yaml`](../lima/prx.yaml) is a [Lima](https://lima-vm.io) template that
boots an Ubuntu 24.04 VM with **docker, bun, gh, and act** preinstalled, and
mounts your home directory so the prx checkout is visible inside the VM.

```bash
limactl start --name=prx ./lima/prx.yaml   # boot + provision (first run pulls the image)
limactl shell prx                          # drop into the VM
cd <path-to-your-prx-checkout>             # your $HOME is mounted read/write
bun run ci:act                             # docker is already running in here

# when you're done:
limactl stop prx
limactl delete prx     # discard the VM entirely
```

This is the most reproducible path: the runner-host environment is a fresh
Linux VM, not your laptop. `vmType` is left to Lima's default (`vz` on Apple
Silicon macOS 13+, which is fast; `qemu` elsewhere).

## Known rough edges

`act` reproduces most, not all, of GitHub-hosted CI:

- **`actions/cache` is a no-op** under act — you'll see a warning, not a
  failure. Jobs just run cold.
- **Pinned-SHA actions are fetched from the network** on first run (`setup-bun`,
  `checkout`, …). The first `ci:act` is slower; later runs reuse the images.
- **Apple Silicon**: if an action assumes `amd64` and dies, re-run with
  `bun run ci:act -- --container-architecture linux/amd64` (emulated, slower).
  Running inside the arm64 Lima VM avoids this for arm64-native images.
- **Secrets / `GITHUB_TOKEN`**: the `ci` job needs none. For workflows that do,
  pass `-s NAME=value` or `--secret-file`.

For day-to-day "did I break the checks", `dist/prx ci` is faster and sufficient.
Reach for `bun run ci:act` when you've **changed a workflow file** and want to
prove the YAML itself still runs.
