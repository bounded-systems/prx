# @bounded-systems/prx

## 0.21.0

### Minor Changes

- 72f706e: Door-grant issuer (prx-8uf2) — the minting half of the signed-grant gate. keeperd's TCP gate (#833) verifies a presented grant; this adds the issuer that mints one. `prx door grant --door keeper --audience <room> --ttl 60` mints a short-lived, audience-bound `SignedGrant`, signed by a prx keymaker/provenance per-actor key (the decided issuer model — reuse the per-actor ed25519 identities, no new key system). `prx door issuer-keys` emits the matching published `IssuerKeys` to configure on the door (e.g. `KEEPERD_ISSUER_KEYS`). Same provenance master ⇒ a minted grant verifies against the published issuer key, closing the mint→present→verify loop end-to-end (tested directly against the keeper gate's authorizer). New: `src/door/grant-issuer.ts` + `src/door/grant-verb.ts`. The live distribution path (a concierge handing grants to clients + refresh-before-TTL) stays deployment-coupled (prx-9s14) and consumes this minting core.

### Patch Changes

- 68be910: Auto-repin room images to the freshly-built box digests (publish-oci-boxes repin job).

## 0.20.0

### Minor Changes

- 0f86ac3: Door-bridge phase 2 (door-side gate) — keeperd enforces a signed grant on its TCP edge (prx-8uf2). keeperd holds the git push credential; on a unix socket the kernel authenticates the peer (held-ref = authority), but on a TCP edge a reachable socket is not authority. keeperd now installs guest-room's `signedGrantAuthorizer` on the TCP path only: a TCP request must carry a grant minted for the `keeper` door, audience-bound, unexpired, and signed by a published issuer key — verified before dispatch. Unix listeners are unchanged. Config-gated by `KEEPERD_GRANT_AUDIENCE` + `KEEPERD_ISSUER_KEYS` (inline JSON or `@<path>`); an unconfigured TCP keeper stays unauthenticated-but-loopback (the #827 safety fix) and logs a loud WARN. New `src/keeperd/grant-gate.ts` (reuses the guest-room primitive — no bespoke crypto beyond ed25519 verify); required bumping `@bounded-systems/guest-room` 0.2.0 → 0.4.0 (0.2.0 predates the grant primitives). Corrects `docs/prx/door-bridge.md`: the gate is door-side (a `RequestAuthorizer` over the request envelope's grant), not inside the forwarding bridge.
- c8ee023: Add the `nix-builder-box` OCI image (prx-zj8 capstone) — the nix remote BUILDER
  as a pinned container (sshd + single-user nix on a /nix volume), to replace the
  Lima builder VM. Adds the image (nix/oci/nix-builder-box.nix), its publish job,
  and the `NIX_BUILDER_IMAGE` pin (packages/prx/src/room/nix-builder-service.ts).
  Verified: `nix store info --store ssh-ng://…` against the running container
  returns Trusted:1 (a functional remote builder). Wiring it as the registered
  builder + retiring Lima follows.

### Patch Changes

- befa26b: Fix `nextWork` triggering a `bd`/`gh` subprocess from a non-repo path. `loadTriageSnapshot` short-circuited only when **both** `.git` and `prx.toml` were absent — so a directory holding only a `prx.toml` (no git working tree) fell through and spawned `runStatusActor` → `bd`/`gh`, which hangs when no daemon/auth is present. Triage genuinely needs a git working tree, so the guard now gates on `.git` alone (a dir in the main repo, a file in a worktree). Pure-config callers (e.g. the `[next_work]` config-reader path) short-circuit cleanly instead of hanging.

## 0.19.0

### Minor Changes

- 8696041: Auto-repin room images (prx-hfgg, the prx-zee7 release-chain wart): publish-oci-boxes gains a `repin` job that, after the boxes rebuild+push (e.g. on a release tag), bumps each room's pinned `<box>@sha256:…` to the freshly-built digest and opens a PR (via the prx-forge App token). Removes the manual repin hop that caused the ghappd door's mis-ordered deploys. New: src/room/repin.ts (pure `repinImage` + `BOX_PINS`, tested) + scripts/repin-boxes.ts (skopeo inspect → repin → changeset).
- e5d5ec3: Door-bridge phase 1 — `prx door bridge` (prx-8uf2): a `127.0.0.1`-only TCP→unix forwarder that gives a host-side caller a way to reach a door (ghappd/keeperd/beadsd) that otherwise only listens on a unix socket. Frame-transparent (forwards bytes, never parses door frames), loopback-hardcoded (`BRIDGE_BIND_ADDRESS`, never `0.0.0.0`), and explicitly opt-in (you run the verb), with a loud dev-only caveat at startup — the edge is UNAUTHENTICATED and widens the door from the socket's owner to all local users. Phase 2 adds the signed-grant gate (reusing keymaker/provenance, per-lease grants) in front of this forward. New: `src/door/bridge.ts` (`runLoopbackBridge`) + `src/door/bridge-verb.ts`, both tested.
- 7dda2e4: Retire `prx keeper up | down` (the in-VM keeperd lifecycle — superseded by the
  pod's keeperd-room, prx-zj8) and delete the now-dead Lima daemon modules
  (`keeperd/lima-keeperd.ts`, `keeperd/lima-transport.ts`, `ghappd/lima-ghappd.ts`).
  Keeps `prx keeper push | branch | commit | serve`. Second of the
  Lima-daemon-retirement PRs.
- 5f998cb: Retire the `prx lima` in-VM daemon verbs (prx-zj8 — the podman pod superseded
  them). Removes `prx lima up|down|daemons|status|provision-beads` (and their
  `lima/registry.ts` + `beadsd/provision.ts` modules); keeps `prx lima
provision-builder` (the nix remote builder, prx-62h). `doltHubUrl` moved to
  `dolt/namespace.ts` (the kept local-beads path still uses it). First of the
  Lima-daemon-retirement PRs; the host-native daemon + builder are untouched.
- 14ad6be: Retire the in-VM beads read path and the last Lima daemon modules (prx-zj8 — the
  podman pod is the substrate). Drops `--vm`/`--vm-socket`/`--host-socket` +
  `PRX_BEADS_VM` from `prx beads read|write|prime`; `withBeadsClient` resolves a
  local endpoint only (the host-native daemon or the pod's door socket via
  `PRX_BEADS_SOCKET`), and the cross-repo affinity guards are now unconditional.
  Deletes `beadsd/lima.ts`, `lima/channel.ts`, `lima/lifecycle.ts`. Final
  Lima-daemon-retirement PR: only `prx lima provision-builder` (the nix builder)
  remains on Lima.

### Patch Changes

- 7f7e6fc: Add the door-bridge ADR (docs/prx/door-bridge.md, prx-8uf2): authenticated TCP/vsock access to the unix-only doors. Doors are in-pod-only today (verified: host TCP connect-then-closes, unix-over-virtiofs ENOENTs); the design is a per-box bridge that gates on a signed grant before forwarding to the unix socket (a naive socat would expose a credential door). Includes an immediate safety note (publish loopback, not 0.0.0.0) + phased plan (loopback dev convenience → signed-grant → vsock). Design only.
- ccb5af2: Bind published door ports to loopback (door-bridge ADR safety fix, prx-8uf2). `renderPodmanRun` published a secret room's `tcpPort` as `--publish <port>:<port>`, which binds `0.0.0.0` — an off-host credential leak, since these are credential doors (keeperd holds the git push token) and the TCP edge carries no authentication yet. The publish is now `127.0.0.1:<port>:<port>`: the host's own client keeps working (it dials localhost) while off-host callers are refused until the signed-grant bridge (phase 2) gates the edge.
- 159a2c9: Docs: mark the Lima daemon-VM retirement done (prx-zj8) in oci-substrate.md +
  beadsd-door-wiring.md (the endpoint is local-only; the Lima VM stays as the nix
  builder), and tidy stale `keeper up|down` / `prx lima` daemon comments.
- 8f21a1d: Drop the prx-signing bucket: `git_ssh_signing_keys` is a user/account permission (user-to-server OAuth), not an installation `default_permissions` scope — confirmed empirically (the live bounded-systems-prx app never held it despite declaring it; the App-manifest flow rejects it). Remove the incoherent `.github/apps/prx-signing.manifest.json` and correct the architecture doc + README: keeper SSH signing is a user-auth concern (prx-dqf), not an installation-token bucket. The bucket model is two apps (prx-forge, prx-projects).

## 0.18.0

### Minor Changes

- 24ae9bb: Add `prx pod down` + `prx pod up --recreate` so the deploy lifecycle is fully prx-owned (no raw `podman pod rm`). `pod down` tears the pod down (kube down + rm secret-room containers — the counterpart `playPod`'s no-op message already pointed at); `pod up --recreate` tears down then launches, to apply a changed spec (e.g. a new image digest). Both routed in cli.ts + covered by the box-verbs-routed guard.

### Patch Changes

- 892576f: Repin ghappd-room to ghappd-box sha256:c6b0d636… — the rebuild carrying the `ghapp serve` CLI route (#814). The prior image (0b7d7be2) crashed the door daemon at deploy with "Unknown subcommand: ghapp". With this digest, `prx pod up` brings the forge door up.
- 95c356f: Repin ghappd-room to ghappd-box sha256:d14a68c8… — the rebuild baking the released prx v0.17.1, which carries the `ghapp serve` CLI route (#814). Verified: `ghapp serve --help` dispatches in this image. The prior pins baked v0.17.0 (pre-route) and crashed the door at deploy ("Unknown subcommand: ghapp"). With this digest, `prx pod up --recreate` brings the forge door up on :9998.

## 0.17.1

### Patch Changes

- 6bc6708: beadsd-box: chmod 700 the box-local `.beads` (the copy from `/work` inherited
  0755, which bd warns about). Re-pinned `BEADSD_ROOM_IMAGE`. Cosmetic — drops the
  startup permissions warning.
- f8a7fd5: Route `prx ghapp serve` in the CLI (cli.ts) — the ghappd-box entrypoint runs `/bin/prx ghapp serve`, but the verb was registered without a dispatch case, so the door daemon crashed at deploy with "Unknown subcommand: ghapp". Adds the route + a regression guard (box-verbs-routed.test.ts) asserting box/daemon entrypoint verbs (ghapp serve, pod up, pod secrets) are CLI-reachable, not just registered — the bug bit three times.
- f9c7803: Mint the prx-forge App token in release-binary.yml's update-hashes job (prx-zee7 Phase 5 leftover) so the release-hashes/brew-formula PR opens automatically. It used GITHUB_TOKEN, which "is not permitted to create or approve pull requests" — so every release's hashes PR failed and had to be opened by hand (e.g. #811 for v0.17.0). Mirrors version.yml; falls back to GITHUB_TOKEN when the app var is unset.

## 0.17.0

### Minor Changes

- ade07e5: Runtime door serves the prx-forge bucket (prx-zee7 Phase 4). broker-config now REQUIRES PRX_GH_INSTALLATION_ID when an app is configured (no default — each bucket app has its own installation; the union app was split). ghappd-box reads the installation from /run/secrets/ghapp-installation too, so one image serves any bucket (the mounts pick the app). ghappd-room retargets to prx-forge (host secrets prx-forge-key/id/installation), making the runtime ambient GH_TOKEN least-privilege forge scopes instead of the broad union app.
- 32dbb61: Pod model: non-door backing services (prx-asr data layer, Phase 3). `PodSpec`
  gains a `services` array (`PodServiceSchema`: name/image/dataVolume/env/args, no
  doors) for co-resident infrastructure like dolt-box. `renderPodmanKube` renders
  each service as a plain container with a `persistentVolumeClaim` named volume
  (podman maps it to a named volume, auto-created and preserved across `kube
down`) — no door fabric mount, no `--socket`. The per-repo pod now ships the
  `dolt` backing service (the dolt SQL server beadsd connects to). Wiring beadsd
  to it lands next.
- dd7ca59: Add `prx pod secrets` (prx-0g8h): prx now owns provisioning the host podman secrets its pod rooms DECLARE (RoomSpec.secrets), instead of manual `podman secret create`. With no `--from` it's a doctor view (declared vs present vs missing-source); `--from name=<@file|literal>` provisions idempotently (`--replace` rotates). ocap-faithful: a file source hands podman the PATH (the secret never enters prx's memory/argv); a non-secret literal (app/installation id) is piped via stdin. Closes the deploy last-mile for ghappd-room/keeperd/etc.

### Patch Changes

- d05337b: Fix bucket app manifests after Phase 3 registration (prx-zee7): prx-forge gains `contents:write` (needed to push the changeset release branch + merge PRs — it absorbs the Changesets app); prx-signing gains the required `hook_attributes` (the manifest flow rejects a blank hook). Record the registered app_ids/installation_ids + the live-forge `contents` bump in .github/apps/README.md. (prx-signing remains unregistered — the flow rejects `git_ssh_signing_keys`; deferred to prx-dqf.)
- d364495: beadsd-box connects to the external dolt-box (prx-asr data layer, Phase 4). The
  beadsd-box entrypoint now builds a box-local `.beads` (copied from the shared
  `/work/.beads`, with the local `dolt/` clone dropped and `dolt-server.port` set
  to dolt-box's 3307) and serves `--cwd /beadsd` — so bd connects to the standalone
  dolt-box over the pod netns instead of spawning its own dolt on the repo's
  `/work/.beads` (which is shared with host bd). Rebuilt off current prx + bd 1.0.3
  (fixes the stale `wisps` schema) and re-pinned `BEADSD_ROOM_IMAGE`. Verified live:
  new beadsd-box + dolt-box on the FOD-seeded data → `bd ready` returns real beads
  rows, `/work/.beads` untouched.
- d695116: Add app-as-code manifests for the permission-bucketed GitHub Apps (Phase 2 of prx-zee7): `.github/apps/{prx-forge,prx-projects,prx-signing}.manifest.json`, splitting the union `bounded-systems-prx` manifest into coarse least-privilege buckets (forge = contents/issues/PRs/checks; projects = organization_projects; signing = git_ssh_signing_keys, isolated). These are the def-of-record to register the apps from; the union app stays until cutover. Per docs/prx/github-apps-architecture.md.
- 4b0c60f: CI cutover to the bucketed apps (prx-zee7 Phase 5): version.yml mints from prx-forge (PRX*FORGE_APP_ID/PRX_FORGE_APP_PRIVATE_KEY) to push the release branch + open the PR; front-desk-add mints from prx-projects (PRX_PROJECTS_APP_ID/PRX_PROJECTS_APP_PRIVATE_KEY) for the add-to-project. Retires the CHANGESETS*_/FRONT*DESK*_ credential names. Both steps stay fail-open (gated on the \*\_APP_ID var).
- 5b49dc3: Publish the dolt-box backing-service image to GHCR (prx-asr data layer). Adds a
  dolt-box job to publish-oci-boxes.yml (mirrors beadsd-box) and pins the digest
  as `DOLT_BOX_IMAGE` (packages/prx/src/room/dolt-service.ts). dolt-box is the
  standalone dolt SQL server (port 3307, named volume) the per-repo pod's beadsd
  connects to ("connect-to-external-dolt"). Image-only; wired into the pod in a
  follow-up.
- c94dcb1: Add the deterministic beads dolt-data build artifact (prx-asr data layer, Phase
  2). `nix/oci/dolt-data.nix` is a fixed-output derivation that clones the DoltHub
  remote, pins the default branch to a specific commit (`dolt reset --hard` + `dolt
gc`), and emits a content-addressed dolt data dir — the network-fetch stage,
  separated from the no-network copy stage (`tar | podman volume import` +
  `chmod a+rwX`). Records `DOLT_BOX_ENV` (incl. `TMPDIR`, required so dolt's noms
  temp writes succeed in the minimal image) + the copy recipe in dolt-service.ts.
  Verified end-to-end: build → import → serve (3307) → query the issues table.
- e43d3e8: Repin ghappd-room to the rebuilt ghappd-box (sha256:0b7d7be2…) carrying the Phase 4 forge-bucket changes (generic entrypoint reads the installation mount; prx binary with the de-hardcoded installation). Per prx-zee7.
- 4c4df0d: Add the GitHub Apps architecture spec (docs/prx/github-apps-architecture.md): permission-bucketed apps (prx-forge / prx-projects / prx-signing) + per-use token attenuation, consumed by both CI (create-github-app-token) and runtime (ghappd-style bucket doors). Records that Front Desk == bounded-systems-prx (legacy secret name), and the migration off the union app + FRONT*DESK*\_/CHANGESETS\_\_ names. Design doc only.
- 77b6a6c: Add `org.opencontainers.image.source` to the beadsd-box and ghappd-box OCI images so each ghcr package is deterministically linked to `bounded-systems/prx` (and carries provenance). This is the documented, explicit way to tie a package to a repo for Actions push access — rather than relying on GitHub's implicit auto-link-on-create, which left `beadsd-box` an unowned orphan (`repository: null`, private → 403 on publish).
- 45edeae: Wire `prx pod secrets` into the CLI dispatch (cli.ts) — the verb was registered (MCP/OpenAPI saw it) but had no `pod secrets` route next to `pod up`, so `prx pod secrets` errored "Unknown subcommand: pod". Follow-up to #806.
- ec7f86d: Repin beadsd-room + ghappd-room to the freshly published, repo-linked box images. After labeling the images with `org.opencontainers.image.source` (#796) and recreating the orphaned beadsd-box package, both `prx/beadsd-box` and `prx/ghappd-box` are now `repository: bounded-systems/prx` + public and publish cleanly. Updated digests: beadsd-box → `sha256:f2d6ffd7…`, ghappd-box → `sha256:49eb0e3b…`.

## 0.16.1

### Patch Changes

- a00d083: Fix the beadsd door not landing on the shared pod fabric (prx-asr). The rootless
  doorDir migration mounts the host fabric at `doorDir` inside each container, but
  non-secret rooms ran their daemon's image-default `--socket` (e.g. beadsd-box's
  `/run/prx/doors/beadsd.sock`) — off-fabric, so consumers (claude-room) couldn't
  reach beadsd. `renderPodmanKube` now overrides `--socket ${doorDir}/<sock>` for
  each open exposed door, mirroring the secret-room path; sealed doors (claude-room
  `control`) and non-daemon occupants get nothing.

## 0.16.0

### Minor Changes

- 4d73b44: ghappd deployment wiring (prx-cdln, finishing Phase 1): the `--ghapp` door catalog entry + the Lima lifecycle.

  - **door/guest-room-catalog.ts** — adds the `ghapp` door to `prxDoorCatalog`
    (`env: PRX_GH_APP_DOOR`, the broker's door-backend reader) + `ghappDoorGrant`,
    so a claude-box room can declare/mount the door (and the rulebook honestly
    denies it when absent). New `ghappd/endpoint.ts` (`DEFAULT_LOCAL_GHAPP_SOCKET`).
  - **ghappd/lima-ghappd.ts** — `startGhappd`/`stopGhappd`/`provisionGhappd`/
    `deployGhappdBinary`, a thin wrapper over the shared Lima `lifecycle` (like
    keeperd/beadsd). The App credential is injected as env — id/installation
    plain, the **PEM from its file via `$(cat …)`** so it stays out of argv.
  - **ghappd/serve-verb.ts** — accepts an (ignored) `--cwd` so the generic daemon
    launcher's `--cwd` doesn't break `ghapp serve` (the door is not repo-bound).

  With this, ghappd is mountable as a room door and deployable as a Lima daemon —
  prx-cdln's door work is complete; what remains is operational cutover (stop
  setting `PRX_GH_APP_PRIVATE_KEY` on agents once ghappd is deployed).

- eb1d771: ghappd Phase 2: the broker's door backend. When `PRX_GH_APP_DOOR` is set, the agent leases a short-lived installation token from ghappd over the door transport instead of minting from a local PEM — so the agent holds no App key, only a reference to the door.

  - **broker.ts** — extracted `cachingBroker(fetchToken, opts)` (the cache / expiry-refresh / concurrency-dedupe), now shared by both token sources; `createBroker` delegates to it (behavior unchanged).
  - **door-source.ts** — `createDoorBroker({ endpoint, repositories?, permissions?, ... })`: leases via `IsolatedGhappdClient` over `resolveFramedTransport(endpoint)`, fail-closed on an error reply, cached like the local broker.
  - **apply.ts** — precedence is now `GH_TOKEN`/`GITHUB_TOKEN` (CI) > **ghappd door** (`PRX_GH_APP_DOOR`) > local App key (`PRX_GH_APP_*`) > personal `gh`. New result `source: "door"`.

  This is the security posture from GHAPPD.md: the long-lived App key lives behind
  the door, the agent receives only a ≤1h lease. Running the door (`ghapp serve`)
  is the remaining Phase 1 wiring (via VerbSpec).

- d5ff4b5: Wire ghappd into the guest-room pod (prx-36xr complete): ghappd now runs as a room in the per-repo pod, and the App key is a host-backed podman secret — the strongest "better cloud secrets" posture (PEM never in env/argv/a layer).

  - **room/ghappd-room.ts** — RoomSpec exposing the `github-app:token` door, pinned
    to the published `ghappd-box` digest, with the App key + id mounted as podman
    secrets (`/run/secrets/ghapp-{key,id}`).
  - **room/pod.ts** — `doorEnv` projects the ghappd door as `PRX_GH_APP_DOOR` (the
    endpoint the broker's door backend dials).
  - **room/claude-room.ts** — consumes the `github-app:token` door, so the agent
    gets `PRX_GH_APP_DOOR` and leases instead of holding the PEM.
  - **room/per-repo-pod.ts** — adds `ghappdRoom` to the pod. (Note: ghappd is not
    repo-specific; a shared/singleton ghappd is a later optimization.)

  Completes the chain: `ghappd-room` holds the key → claude-room leases ≤1h scoped
  tokens over the door → no App PEM in the agent. Movable by construction (the door
  transport resolves unix pod-local or TCP remote). Deploying it requires the
  `prx-ghapp-key` + `prx-ghapp-id` podman secrets on the host (see prx-z6ru).

- b6a2c69: Add `prx ghapp serve` — run the ghappd GitHub App credential-broker door — as a spec-driven VerbSpec (prx-cdln Phase 1 wiring).

  Authoring the verb once with `defineVerb` projects it to the CLI, MCP, and
  OpenAPI surfaces (and the help/registry projections regenerate), so it needs no
  hand-wired `registry.data.ts` entry or new actor — it registers in
  `cli/verb-registry.ts` like the other infra verbs (`pod up`). `run` resolves the
  App key host-side via `resolveBrokerConfig` (held in the daemon, never leaving
  the door), starts `runGhappdServe`, logs the listen socket, and blocks until the
  process is terminated. Unconfigured ⇒ the door still serves but leases reply
  error (loud at lease time). Regenerates `openapi.json` + help snapshots.

  With this, the door is runnable end-to-end: `prx ghapp serve --socket <path>`,
  and agents lease from it via the broker's door backend (`PRX_GH_APP_DOOR`).

- b5bb881: Signed-derivation verification is now **on by default** (fail-closed) — trust
  ledger row 6.1. Previously `PRX_REQUIRE_SIGNED_DERIVATIONS` was opt-in and the
  merge-guard / publisher tier skipped verification entirely when it was unset
  (fail-open). Now an unset/empty value enforces verification, and the gate fails
  closed when a signed derivation is missing, invalid, or unverifiable.

  Migration: this can block merge/publish in environments without a verifier
  configured (`PRX_PROVENANCE_PUBKEY`) or that don't emit signed push
  attestations. To opt out where enforcement can't yet be satisfied, set
  `PRX_REQUIRE_SIGNED_DERIVATIONS=0` (also accepts `false`/`off`/`no`). The
  fail-closed error messages now name both the fix and the opt-out.

### Patch Changes

- 7731f4e: Add the `ghappd-box` OCI image — the container that runs `prx ghapp serve` inside a guest-room (prx-36xr, the linchpin for running ghappd in the per-repo pod).

  - **nix/oci/ghappd-box.nix** — `streamLayeredImage` mirroring keeperd-box, but the
    App PEM is a RUNTIME SECRET: the entrypoint points `PRX_GH_APP_KEY_FILE` at the
    mounted secret (`/run/secrets/ghapp-key`) so the daemon reads it in-process —
    the PEM never enters env/argv/a layer (stronger than keeperd-box, which cats
    its key into env). Non-secret App id read from `/run/secrets/ghapp-id` when
    present; installation defaults in the daemon. Unmounted ⇒ serves but leases
    error (by design). Contents: prx + cacert (HTTPS to api.github.com only — no
    git/ssh).
  - **flake.nix** — `packages.<linux>.ghappd-box` (Linux-only, like the other boxes).
  - **.github/workflows/publish-oci-boxes.yml** — a `ghappd-box` publish job
    (build → skopeo push to ghcr → digest in the step summary to pin), mirroring
    beadsd-box.

  Follow-up (after the first publish): pin the digest into `room/ghappd-room.ts`
  and wire the room into the per-repo pod (prx-36xr steps 2–5).

- 9343ed2: `prx pod up` is now idempotent (prx-asr). Re-running it against an
  already-running pod previously failed with `podman kube play … "<pod>" is in
use: pod already exists` (exit 125). `playPod` now probes `podman pod exists
<name>` first and returns a no-op result when the pod is up — non-destructive
  (healthy daemons aren't restarted); run `prx pod down` first to recreate.

## 0.15.0

### Minor Changes

- fba9198: Add the ghappd door core (prx-cdln Phase 1, spec claude-box/GHAPPD.md): the GitHub App credential-broker door holds the App private key and serves a `lease` op returning a short-lived installation token — callers never hold the PEM.

  - **src/ghappd/contract.ts** — Zod wire contract (`lease` request with optional `repositories`/`permissions` attenuation; `ok`/`error` response).
  - **src/ghappd/daemon.ts** — `handleGhappdRequest` (pure over deps: held App config + injected mint; never throws to the socket; PEM never in a reply) + `serveGhappdConnection`/`runGhappdServe` over the shared `door/framing`, mirroring beadsd.
  - **src/ghappd/client.ts** — `IsolatedGhappdClient.lease` over an injected transport, validating both directions (`GhappdProtocolError` on contract violation), mirroring `IsolatedBeadsClient`.

  Reuses `mintInstallationToken` server-side. Pure-over-deps, fully offline-tested
  (handler logic, framed serve round-trip via a mock socket, client validation).
  Remaining Phase 1 wiring — the `ghapp serve` CLI verb, the `prxDoorCatalog`
  entry, and the Lima lifecycle — is a focused follow-up; the agent-side broker's
  `door` backend (lease instead of local mint) is Phase 2.

### Patch Changes

- 02c9568: Harden the beads write-side workspace-affinity guard against an unregistered cwd
  (prx-7odk). prx-9e86 decided by bd prefix, but a cwd not in the repo inventory
  resolves to a null prefix → the guard allowed the write, so a cross-repo write
  from an unregistered checkout slipped through. `resolveWorkspaceAffinity` now
  falls back to git-remote repo identity when the prefix is unresolvable: it
  refuses only on a POSITIVE cross-repo mismatch (both identities resolved and
  differing), and still allows a same-repo or undeterminable cwd — no
  over-blocking. The refusal message names the repo identities in that case.
- 508206a: Harden the GitHub App token broker: scrub the inline PEM from the env after read, and support least-privilege token attenuation.

  - **Env-scrub** (`apply.ts`): when the App key is injected as the inline
    `PRX_GH_APP_PRIVATE_KEY` env var (the cloud-agent path), the broker now reads
    it into memory and then `deleteEnv`s it — so the long-lived root key is not
    inherited by every child process prx spawns, nor readable via
    `/proc/<pid>/environ`. The file-path source keeps only a (non-secret) path in
    env, so nothing is scrubbed there.
  - **Token attenuation** (`installation-token.ts` + broker/config): the mint call
    can now scope the installation token to specific `repositories` and a subset of
    `permissions` (GitHub `access_tokens` body), configured via
    `PRX_GH_APP_REPOSITORIES` (comma-sep) and `PRX_GH_APP_PERMISSIONS` (JSON).
    Opt-in — unset means the installation's full scopes (back-compatible); an
    unattenuated call sends no request body.

  Both reduce the blast radius of the broker's long-lived root credential. The
  larger move (holding the key behind a keeperd/authd-style credential-broker door
  so cloud agents never receive it) remains the architectural target.

## 0.14.0

### Minor Changes

- 57c185b: Foreign-workspace signal for daemon-routed beads (prx-qmg). One daemon serves
  one repo (GH-296), so a ref whose prefix is well-formed but not this daemon's
  served prefix (e.g. `3qn-123`, `COMMERCE-456` against a `prx-*` daemon) can't
  resolve here. `handleBeadsRequest` now short-circuits such refs with a clear
  `foreign-workspace` error ("`3qn-123` isn't in this workspace — this daemon
  serves `prx-*`") before spawning bd, for reads and writes alike — instead of a
  generic not-found (read) or the bd-safe "resolve to canonical long id" refusal
  (write). Uses the served prefix the daemon already knows (`deps.localPrefix`);
  inert when no served prefix is wired. Cross-workspace routing remains out of
  scope (signal only).
- 895e8db: Add the GitHub App token broker: mint a short-lived installation token at startup and publish it as `GH_TOKEN`, so prx's GitHub ops run headless on the app's own (higher) rate-limit pool with a bot identity — no interactive `gh auth login`.

  - **src/github-app/broker-config.ts** — `resolveBrokerConfig()`: fail-open (null when unconfigured); PEM precedence inline `PRX_GH_APP_PRIVATE_KEY` (cloud-agent shape) > `PRX_GH_APP_KEY_FILE` (path, read via injected `readFile`); throws on misconfig.
  - **src/github-app/broker.ts** — `createBroker()`: per-process cache + expiry-aware re-mint + concurrent-dedupe around `mintInstallationToken`.
  - **src/github-app/apply.ts** — `applyBrokeredGhToken()`: precedence `GH_TOKEN`/`GITHUB_TOKEN` already set (CI) > broker-minted > personal `gh` (fail-open). Writes via `@bounded-systems/env` (ambient-authority guard). Fail-closed only when configured-but-mint-fails. `getProcessBroker()` lets daemons refresh.
  - **scripts/pr_state.ts** — startup hook (owns the `node:fs` PEM read so `src/` stays fs-free).
  - **nix/hm-module.nix** — `programs.prx.githubApp.{enable, clientId, privateKeyFile, installationId}`; emits path/ids only, never the PEM (the inline env var is the cloud-agent-only path).

  Works headless in Claude Code cloud agents (inject the App key as the `PRX_GH_APP_PRIVATE_KEY` env secret); self-hosted OCI uses the file path via a podman secret. Builds on the `mintInstallationToken` primitive.

## 0.13.0

### Minor Changes

- 8aa5855: Add `attestAuthorship` — project keeperd's L3 authorship reconciliation into the prx provenance ledger (prx-sfco, first slice).

  keeperd's signed L3 records AI-vs-human authorship under `predicate.authorship`
  (GitAI Phase 2, prx-ydib). `attestAuthorship` records a `prx.dev/authorship/v1`
  derivation for it via `persistAttestation` — mirroring `scout-attest` /
  `ci-attest`:

  - **subject** = the commit (`gitCommit`).
  - **resolvedDependencies** = `l3` (sha256 of keeperd's signed L3 envelope) — so
    keeperd's commit-key signature is preserved as a content-addressed input
    rather than re-signed; this derivation is the index/lineage entry.
  - **params** = the reconciled verdict `{ model?, aiAuthored, divergent, stale }`;
    `divergent` (staged-but-unclaimed = bypass) is the high-signal set.

  Content-addressed + idempotent + signed; verifiable via `verifySlsaEnvelope`.
  Follow-ups (prx-sfco): a `refs/notes/<ref>` reader that parses the L3 note,
  sync-agent wiring (prx-697) to publish, and the trust-ledger `CLAIMS.md` row
  (also closes the "off-the-shelf verifiability" Partial, prx-5lcd).

- 4f1e6b6: Write-side workspace-affinity guard for daemon-routed beads (prx-9e86). The
  host-global beadsd serves ONE clone, so a `prx beads create/update/close/dep`
  issued from a worktree whose bd prefix differs from the served clone's prefix
  would land in the WRONG repo's beads (the root cause of 54 supply-chain tasks
  created with `prx-` ids from the supply-plan-design worktree). `prx beads`
  writes now **fail closed** on that mismatch (nonzero exit, actionable message),
  and reads **warn** (non-fatal). The served prefix is reported by the daemon on
  every reply (`servedPrefix` on the wire contract), so the read-side check costs
  only a cheap cwd index read — no `bd config` subprocess. Both prefixes must be
  known for a mismatch, so an unregistered cwd is never blocked. Local path only;
  a `--vm` daemon serves its own workspace.

### Patch Changes

- fb01abf: Add `scripts/gh-app-token-spike.ts` — de-risk minting a `bounded-systems-prx` GitHub App installation token locally.

  Zero-dep Bun script (node:crypto + fetch): App ID/Client ID + private-key PEM →
  signed RS256 JWT → `POST /app/installations/<id>/access_tokens` → installation
  token → `GET /rate_limit` to prove the separate (higher) pool. The token is never
  printed; it reports identity, scopes, and the rate-limit pools.

  The spike before wiring a keymaker-style token broker so prx's GitHub ops run on
  the app's quota (not the personal 5,000/hr that's easy to exhaust) with a bot
  identity and least-privilege scopes (`.github/prx-app.manifest.json` is the
  def-of-record). Credentials already exist for CI (FRONT_DESK_CLIENT_ID +
  FRONT_DESK_APP_PRIVATE_KEY via actions/create-github-app-token); local use points
  `PRX_GH_APP_KEY_FILE` at the key (ideally agenix/sops, path-only in env).

## 0.12.0

### Minor Changes

- cff799e: Add `prx pod up` verb: launches the per-repo pod (claude-room + beadsd-room + keeperd-room) via `launchPod`, attests the launch (best-effort L2), and returns `{ pod, containers, l2LaunchDigest }`. Rootless `doorDir` (`$XDG_RUNTIME_DIR/prx/doors` or `~/.local/run/prx/doors`) so no sudo is required on macOS/Linux. Injected into the verb registry and routed via `cli.ts`.

### Patch Changes

- 513c2bd: Pin beadsd-box OCI image digest in `beadsd-room` (prx-634). Image is built via
  `nix dockerTools.streamLayeredImage` (prx, bd, dolt, git, cacert) and pushed to
  `ghcr.io/bounded-systems/prx/beadsd-box`; the digest reference replaces the
  placeholder `"beadsd-box"` string. Adds `publish-oci-boxes.yml` CI workflow that
  rebuilds and pushes on every `v*` tag.
- df1713b: Correct the `gitAiAgent` comment in the home-manager module (prx-q9yj follow-up).

  The merged comment claimed `GIT_AI_CUSTOM_ATTRIBUTES` is "persist[ed] into the
  authorship note `custom_attributes`" with a local jq metric recipe. Verified
  false (git-ai 1.6.3): the local note schema (`authorship/3.0.0`) has no
  `custom_attributes` field — that data only flows to git-ai's cloud upload path
  (`GIT_AI_API_KEY`). The local jq recipe always returns nothing.

  Comment now states the real scope: the export is the cloud on-ramp (inert
  without git-ai cloud), and a _local_ prx-vs-bypass metric needs a different
  instrument. No behavior change — the `export` is unchanged.

- b2b86da: Pass `--socket` and `--key` CMD args to keeperd container so it binds to the shared fabric.

  The keeperd image entrypoint hardcodes `--socket /run/doors/keeperd.sock --key /keys/keeper.key`
  before `"$@"`. door-kit's `parseArgs` uses last-wins semantics, so CMD args (after the OCI image
  ref in `podman run`) override the baked-in defaults.

  - **spec.ts** — `RoomSpec` gains `extraArgs: string[]` (default `[]`): room-specific CMD args
    appended after the image ref for entrypoint override
  - **podman.ts** — `renderPodmanRun` appends `--socket ${doorDir}/<basename>` CMD args for each
    exposed door (overrides hardcoded entrypoint socket path), then `room.extraArgs`
  - **keeperd-room.ts** — sets `extraArgs: ["--key", "/run/secrets/keeper-key"]` to override the
    entrypoint's baked-in key path with our secret mount target
  - all existing room definitions gain `extraArgs: []` to satisfy the TS output type

- aacba94: Wire keeper socket readiness poll so `prx pod up` returns a non-null `l2LaunchDigest`.

  Three-part fix closing the gap from prx-9yv3/#749:

  1. **podman.ts** — `renderPodmanRun` injects `KEEPERD_SOCK=${doorDir}/<basename>` for
     each exposed door, so the keeper daemon writes its socket onto the shared fabric
     (not the in-box default `/run/keeperd.sock`).

  2. **pod.ts** — `doorEnv` rebases consumer socket paths to `${doorDir}/<basename>`,
     ensuring the client-side `KEEPERD_SOCK` and `PRX_BEADS_SOCKET` point to the
     shared fabric regardless of the door spec's nominal path.

  3. **podman-runtime.ts** — `launchPod` polls for the keeper socket via `waitForSocket`
     (injectable, 500ms interval / 30s timeout), then sets `KEEPERD_SOCK` in the host
     environment before calling `attestLaunchForPod`, and restores or deletes it after.
     Best-effort: a poll timeout or attest failure surfaces as `l2LaunchDigest: null`
     without tearing down the pod.

## 0.11.3

### Patch Changes

- e7c8c8a: Drop the stranded drizzle tooling left behind by the `anchored-chain-sqlite` extraction: `drizzle.config.ts` (pointed at the removed `packages/anchored-chain-sqlite/`), the `db:generate`/`db:check` scripts, and the `drizzle-kit` devDependency. The schema → SQL → embed chain now lives entirely in `bounded-systems/anchored-chain-sqlite`. Internal tooling only — no CLI behavior change.
- 5a17281: Fix `prx beads publish` relink split-brain (prx-022t): switch the default bead reader in `publishOne` from direct `execBd` (reads the worktree's `.beads`) to `loadAllBeadsViaCli` (daemon-backed, reads the canonical `~/.local/state/prx/beads`). When the two databases diverge the daemon's `bd update --external-ref` step was failing with "record not found", leaving the GH issue created but the bead unlinked. Using the daemon for both read and write ensures consistency and pre-warms the daemon before the write-back step.
- f2e7501: Hoist the OpenAPI projection's per-verb schemas into `components/schemas`: each
  operation is now a thin `$ref` to `<VerbToken>Input` / `<VerbToken>Output` rather
  than an inlined schema. The result is the conventional, consumer-referenceable
  OpenAPI shape and ~57% smaller (37 KB vs 89 KB — it also drops 60 redundant
  `$schema` dialect markers). Built by hand so ids and refs stay consistent: Zod's
  registry-based dedup emits dangling `$ref`s for the space-namespaced verb ids, and
  the verbs' schemas are self-contained today (no shared sub-schemas to dedupe), so
  components are 1:1 with operations — the hoist is the structure dedup would use if
  shared schemas ever appear.
- 02a4e91: Emit the OpenAPI projection of the VerbSpec registry to `packages/prx/openapi.json`
  — verbspec's fourth surface (CLI / MCP / Anthropic / OpenAPI) made real. The
  document is generated from the verbs (`bun run openapi:render`) and drift-gated by
  `test/cli/openapi.test.ts`, so it can't fall out of sync with the registry.
- 17f15c6: Consume the extracted `@bounded-systems/*` libraries from JSR instead of carrying duplicate workspace copies. The 21 leaf + non-leaf packages now live in their own repos (JSR-linked); `packages/*` no longer vendors them. Internal restructure only — the prx CLI's behavior is unchanged. `anchored-chain-sqlite`'s migration generator moved into its own repo; the orphaned `gen-acs-migrations.ts` + `acs:migrations` scripts are removed from prx.

## 0.11.2

### Patch Changes

- 47a6320: `playPod` now provisions the shared door fabric BEFORE any room runs (prx-3urm) — `mkdir -p` plus a best-effort `chcon -R -t container_file_t` (the shared `:z` label) on the host `doorDir`, via the new pure `renderDoorFabricProvision` argv and its injectable `ProvisionDoorFabric` seam. This closes the two live findings the `:z` relabel (#649) didn't cover: (1) an all-secret-rooms pod has no `kube play` step, so `podman run --volume <doorDir>:<doorDir>:z` died with `statfs … no such file` since a bind mount can't create a missing host dir; (2) `kube play`'s `DirectoryOrCreate` makes the dir `var_run_t`, so the kube containers hit `EACCES` before the secret room's own `:z` ran — relabeling first fixes the ordering. The `chcon` is guarded (skipped when absent, `|| true` if unprivileged), so it's a no-op off SELinux; a failed `mkdir` aborts the bring-up (`set -e`, fail-fast). The production quadlet's systemd `RuntimeDirectory=`/tmpfiles equivalent is tracked separately.

## 0.11.1

### Patch Changes

- 636e427: `renderPodmanQuadlet` projects a secret-holding room (prx-b44y) to a systemd podman **quadlet** (`.container`) unit — the durable production counterpart of `renderPodmanRun`'s ad-hoc argv. Same wiring (host-backed `Secret=…,target=…`, the shared `/run/prx/doors` fabric with a `:z` SELinux relabel, the repo `/work` mount, the wired-door env) plus claude-box's capability hardening floor (`NoNewPrivileges`, `DropCapability=all`, pid/memory caps). Egress stays at the podman default — unlike claude-box's socket-only keeper, prx's keeperd holds the push credential and must reach the git remote. Rendered from the `PodSpec`, so it can't drift from the door wiring.
- bed601b: `renderPodmanRun` now emits a `:z` (shared) SELinux relabel on the door-fabric and repo bind mounts (prx-3urm). On an SELinux-enforcing host (e.g. a Fedora podman machine) the bare `--volume src:dst` left the door dir labeled `var_run_t`, so the keeper hit `EACCES` creating its socket; `:z` relabels it to `container_file_t`. It's `:z` (shared — the door fabric and repo are shared with the kube pod's containers), not `:Z` (private), and a no-op on non-SELinux hosts. Live-validated on the host: with a rootless-owned `/run/prx/doors`, the rendered argv brings the keeper up listening on the shared fabric with no manual `chcon`. (Note: rootless `:z` can only relabel a dir the runtime user owns — provisioning `/run/prx/doors` with the right ownership is the remaining prx-3urm scope, tracked separately.)

## 0.11.0

### Minor Changes

- 2d158d5: Extend the beadsd-door gate to the direct bd-read spawn sites. A new shared `bdDoorGate(cmd, env, dialer?)` primitive in `@bounded-systems/bd` (which `defaultBdGithubRunner` now reuses) door-gates any raw `bd` command array. prx adds `doorGatedCommandRunner` / `doorGatedSpawnCapture` wrappers (and the `bdCommandRunner` / `bdSpawnCapture` defaults), and the in-box bd reads — `pipeline/agent-result` (`bd list`), `pipeline/edges/intake-triage` (`bd show`), and `beads/workspace_mode` probe (`bd list`) — now route through them, so they reach the beadsd door in the box profile instead of execing a local `bd`. Off-profile behavior is unchanged. Host-only dolt/bootstrap/doctor management spawns are intentionally not door-routed (the door cannot express daemon-management ops).
- 0a8f458: Add the `beadsd-box` OCI image (prx-634) — the pinned `dockerTools.streamLayeredImage` that fills `room/beadsd-room.ts` in the per-repo pod (prx-zj8). Built on the prx-62h linux builder via `nix build .#packages.aarch64-linux.beadsd-box`. Contents: prx (our release), `bd` **built from source** (`nix/oci/bd.nix`, buildGoModule over the MIT-licensed beads source + ICU for its dolt cgo dep — not a downloaded prebuilt), `dolt` from nixpkgs (the client for connect-to-external-dolt), and gitMinimal + cacert. Entrypoint `prx beads serve` on the `beadsd-room` door socket. The image is the artifact; the pod (prx-asr) supplies the dolt clone dir + external-dolt endpoint at runtime.
- 4348878: Add a `children` read to the beadsd door (prx-zbsi). `prx beads children <id>` returns an epic's parent-child children through the daemon, served over the already-allowed `bd dep` subcommand as `bd dep list <id> --direction up --type parent-child --json` — `bd children` is **not** on the bd policy allowlist, so the read adds no capability surface. Wired end-to-end: the `children` request kind in the beadsd wire contract (a read), the daemon dispatch, the `prx beads children` CLI verb, and the door dialer mapping (`bd children <id>` → `prx beads children <id>` in the box profile).

  Also fixes a latent door-read bug: the dialer forwards a bd read's `--json` flag verbatim (`bd show <id> --json` → `prx beads show <id> --json`), but the read parser rejected `--json` under strict parsing — so **no** door read (show/list/children) would have parsed once the box profile went live. The read parser now accepts-and-ignores `--json` (reads always emit JSON).

  This is the door-read infra for the remaining prx-zbsi epic-children reads; gating the consumers (`resolveEpicChildBdIds`, `findEpicChildren`) onto it is a follow-up.

- 85a9179: Route bd-backed verbs through the beadsd door in the box profile. `execBd` and `defaultBdGithubRunner` now gate on a `PRX_BEADS_DOOR` signal: in the box profile they never spawn a local `bd`, instead dialing the door via a registered, daemon-agnostic `BdDoorDialer` (new `registerBdDoorDialer` / `isBdDoorMode` exports) or failing closed with the door + provisioning path. prx registers the production dialer at `runCli` startup, mapping reads (list/ready/show) onto `prx beads <verb>`. Off-profile behavior is unchanged. Door wiring + the box-profile signal are owned by prx-asr / prx-634.
- 022f62c: Add the bd memory surface (`recall` / `memories` / `remember`) to the beadsd wire contract and daemon dispatch (prx-44y, GH-296 / GH-1003). `recall` (read one row by key) and `memories` (read rows by key prefix) join the read kinds; `remember` (upsert a row) joins the policy-gated single-writer set and dispatches under the planner role like every other write. `forget` (destructive) is intentionally absent — it is not on the bd allowlist.

  This is the daemon-side infra for routing the structured-handoff queue (GH-1397) and memory/compact store through the one canonical clone. It's the fix for the prx-44y root cause — handoff rows are bd-memory writes that, going through raw `bd` from a worktree, never reach the canonical store (so `prx handoff enqueue` reports `created` while `prx handoff status` reads nothing). Wiring `handoff/store.ts` onto this daemon surface is the follow-up.

- a5f58e0: Add the `dolt-box` OCI image (prx-zj8) — the per-repo dolt SQL server as a pinned `dockerTools.streamLayeredImage`, the third OCI fleet image after beadsd-box and keeperd-box. Runs a standalone `dolt sql-server` on `3307/tcp` (the MySQL wire protocol beadsd-box's dolt client reaches over the pod network — connect-to-external-dolt). The dolt database is a **named volume** at `$DOLT_DATA_DIR` (default `/var/lib/dolt`), never baked into a layer; the pod (prx-asr) supplies it. Build on the prx-62h linux builder: `nix build .#packages.aarch64-linux.dolt-box`. Note for prx-asr: today `prx dolt start` delegates to `bd dolt start` (bd owns the co-located lifecycle); the pod model inverts this so dolt-box owns the server and beadsd's bd connects to it externally — wiring that decoupling is prx-asr's job.
- da34142: Door transport gains a transport-agnostic dial (prx-o92 foundation). Add `tcpSocketTransport`, `parseDoorEndpoint`, and `resolveFramedTransport` to the shared transport module: a door endpoint string is dialed as a unix socket (`/run/keeperd.sock`, `unix://…`) or TCP (`host.containers.internal:3002`, `127.0.0.1:3128`, `tcp://…`) by one resolver, so a door client reaches a mounted socket OR a host-gateway / pod-local TCP port with no per-door code — closing the "dialed a `host:port` endpoint as a unix path" gap. Foundation only: adds the primitive; door clients adopt the resolver next.
- 1023eba: Add `withKeeperClient` (`keeperd/client-factory.ts`) — the door-dialing seam that `keeperd/endpoint.ts` deferred (prx-asr). It assembles `resolveKeeperEndpoint` → `resolveFramedTransport` → `IsolatedKeeperClient`, so a caller gets a live keeper-door client from the env the per-repo pod projects (`PRX_KEEPER_SOCKET`), unix-socket or `host:port`. Mirrors beadsd's `withBeadsClient`; foundation only — it builds the client but does not yet route the pipeline's git-writes through it (the caller still injects the client into `runKeeperRemote`).
- d0b9fda: Route `prx submit publish`'s git-write through the keeperd door in the box profile (prx-asr). When `isKeeperDoorMode()` (the projected `PRX_KEEPER_DOOR`), the publish push no longer runs locally — the host bundles the materialized commit range and `runKeeperDoorPush` (new, `keeperd/host.ts`) asks keeperd to import + signed-push it over the door via `withKeeperClient`, so the box holds no push credential or signing key. The GH-2249 `requireSigned` gate is preserved across both paths: it verifies the host-captured derivation (local) or the daemon's returned `signedDerivation` (door), with the same subject-equality + verifier checks, and fails closed (no PR opened) on a door error, a commit mismatch, or a missing/unverifiable signature. Off-box behaviour is byte-identical (the local attesting push is unchanged). Foundation: the wiring is unit-tested with injected seams; the live in-daemon import+push (real keys/push credential) is the keeper-provisioning follow-on.
- 970ec71: Run secret-holding rooms via `podman run --secret`, splitting the pod runtime (prx-b44y). `podman kube play` cannot mount a host-created podman secret (it only accepts in-YAML k8s Secrets, which would base64 the key into the manifest — the very thing the door ADR forbids), so the keeperd room (which holds the provenance signing key) can't be a kube-play member. `RoomSpec` gains an optional `secrets` list (`{ name, target }` = the host podman-secret name + its in-room mount path); a room with any secret is a **secret-holding room** (`roomNeedsSecretRuntime`). `renderPodmanRun(pod, room)` renders its `podman run --detach --replace --secret <name>,target=<path>` argv, and `playPod`/`downPod` now split: `podman kube play|down` the non-secret rooms, `podman run`/`podman rm --force` each secret room (both return the result of every podman invocation). The door fabric moves from a pod-private `emptyDir{ medium: Memory }` to a shared `hostPath` of `doorDir` (`DirectoryOrCreate`), so **both runtimes mount the same door dir** and the keeper's exposed door stays reachable from the kube rooms; on a linux host `/run` is tmpfs, so the sockets stay memory-backed. Secret rooms are dropped from the kube manifest as containers but **kept in door resolution**, so `claude-room` still gets its `PRX_KEEPER_DOOR`/`PRX_KEEPER_SOCKET` env and reaches the keeper on the fabric. `keeperd-room` declares the `prx-keeper-key` secret at `/run/secrets/keeper-key` (where the keeperd-box entrypoint reads it into `PRX_PROVENANCE_KEY`); the operator creates it with `podman secret create prx-keeper-key <from-1password>`. Offline unit-tested via the injected runner; the live keeperd sign+push e2e remains the prx-b44y follow-up (needs the podman host).
- 8a92afc: Add the `keeperd-box` OCI image (prx-anj) — the pinned `dockerTools.streamLayeredImage` that fills `room/keeperd-room.ts` (`image: "keeperd-box"`) in the per-repo pod (prx-zj8). Runs `prx keeper serve` (the `git:write` door) from prx + gitMinimal + openssh + cacert. The care-about: the keeper provenance **signing key is a runtime secret** — the pod mounts it via a podman secret onto tmpfs (`/run/secrets/keeper-key`, overridable with `PRX_PROVENANCE_KEY_FILE`) and the entrypoint reads it into `PRX_PROVENANCE_KEY` at start; the key is never baked into a layer (verified: no key material in the image closure). Build on the prx-62h linux builder: `nix build .#packages.aarch64-linux.keeperd-box`.
- 47c5a31: Wire the keeperd (git:write) door in the per-repo pod (prx-asr). The pod's `doorEnv` now projects `PRX_KEEPER_DOOR` + `PRX_KEEPER_SOCKET` into a keeperd consumer (claude-room), symmetric to the beadsd door — so the podman driver renders the keeper endpoint for the box for free. Adds `keeperd/endpoint.ts` (`resolveKeeperEndpoint` / `isKeeperDoorMode`) as the client-side reader of that env, mirroring beads' `resolveBeadsEndpoint`/`isBdDoorMode`. Completes the door-fabric wiring for git-writes; adopting the resolver at the keeper call sites (so a boxed prx dials the door) is the follow-on.
- b780fab: Provision the prx Lima VM as a nix remote builder (prx-62h, flavor B of `docs/prx/claude-runtime.md`). Add `provisionVmNixBuilder` — install nix (Determinate, skip-if-present), make the VM login user a `trusted-user`, enable flakes, restart the daemon — and the pure `/etc/nix/machines` descriptor `nixBuilderMachineLine` / `NixBuilderMachine`. The in-VM effects run through the injected `Run` seam (unit-tested offline; live path runs against a real VM); prx renders the host registration line but does not edit host nix config. This is the build substrate the OCI fleet images (prx-634, prx-anj) offload to so they can be built from a kernel-less macOS host. Foundation only: the CLI verb and the host-side registration write are follow-ons.
- 01567e8: Add the `prx lima provision-builder <vm>` verb (prx-62h) — wires `provisionVmNixBuilder` into the CLI so an operator can install nix in a Lima VM and register it as a nix remote builder in one command. Flags: `--max-jobs`, `--systems`, `--installer-url`; prints the `/etc/nix/machines` line to register (prx renders it, it does not edit host nix config). Completes the usable surface of the OCI build substrate begun in the prior slice.
- 466910a: Add the podman pod driver — `renderPodmanKube(pod)` renders a `PodSpec` to a `podman kube play` Pod manifest (mirroring the executor's Lima driver: hand-rolled YAML, validated at the seam, behind a `PodDriver` interface). Each room becomes a container sharing one tmpfs `emptyDir` door-fabric volume mounted at `doorDir`; each container's env is the wired-door projection from `podRoomEnv` — so the rendered `claude-room` container carries `PRX_BEADS_DOOR`/`PRX_BEADS_SOCKET`, the manifest that actually fires the bd-door gate. The per-room container image is a placeholder pending the `-box` image refs (prx-zj8).
- ccdff31: Mount the repo at `/work` in the rendered pod (prx-u5lx) — the daemon images (`beadsd-box`, `keeperd-box`) set `WorkingDir=/work`, but `renderPodmanKube` only mounted the door tmpfs, so podman/crun couldn't start those containers (`workdir "/work" does not exist`). `PodSpec` gains an optional `repo` (the host repo path, one pod = one repo, resolved at deploy); when set, `renderPodmanKube` emits a `hostPath` volume bind-mounted at `/work` in every room. Without `repo` the manifest is unchanged (back-compat). Live-validated: the real `perRepoPod` (claude-box + beadsd-box + keeperd-box) now plays to **all three rooms Up** on podman — previously keeperd-room failed to start.
- 295eaa8: Add the **podman runtime** (`room/podman-runtime.ts`) — `playPod`/`downPod`, the prx-asr capstone that actually runs a pod. They pipe `renderPodmanKube(pod)` into `podman kube play -` / `podman kube down -` through the `@bounded-systems/proc` `defaultRunner` seam (injected runner ⇒ fully offline unit-tested; a non-zero exit becomes a typed `PodmanRuntimeError`). The rendered manifest already declares the shared `emptyDir{ medium: Memory }` door volume, so `podman kube play` provisions the door fabric — no separate volume step. Live-validated on podman: a single-room `beadsd-box` pod plays to a Running pod with the door volume and `downPod` removes it. Foundation toward the full per-repo pod — playing `perRepoPod` end-to-end still waits on the `claude-box` image (prx-d4o).
- 9825b97: Add `prx capabilities` (aliases `caps` / `can`): an OCAP self-report surface. An agent launched in a sealed box (claude-box) otherwise assumes it can run any verb and discovers the capability boundary one opaque failure at a time. This command is zero-dependency by design — it works in a bare box where git / bd / gh / repos are all absent — and reports what the box CAN do, what it CANNOT, and, for each missing capability, how to enable it. The room tells the man how to translate.
- 4e7ef2e: Add the predicate binding-semantics precursor to `TransitionContract`: a per-member binding tag (`property` | `event`), a `RequiredPredicate` bundle member, and an optional `requiredPredicates` array on `transitionContractSchema`. Backward-compatible — when the field is absent, `requiredPredicatesOf()` projects the singular `requiredArtifact`/`requiredStatus` pair to a one-member property-bound bundle, so the shipped contracts and their guards are unchanged. This is the type-level seam both the intake-to-plan lifecycle contracts and the merge-verdict bundle read through; the bundle-weighing verdict and the capability-footprint → required-predicate mapping are follow-ups.
- 6a7aff3: Retire worktrunk (wt/wtctl): prx now owns the worktree lifecycle end-to-end (prx-arl). Removes the `prx tools wt` verb (the worktrunk shim) and the dead `prx tools labels sync`, and wires post-create bootstrap (beads `.redirect` + `.pr/local/pr.json` + exclude sync) into the `worktree-create` hook so a fresh `claude --worktree` worktree is self-sufficient without worktrunk. `prx tools git` / `prx tools bd` are unchanged.
- 0cf2251: Add a first-class `RoomSpec` — the typed isolation unit in the house→room→person model (prx-62h). A room composes an `ExecutorSpec` (the house), the unix-socket `doors` it consumes/exposes (the daemon capability seams the bd-door gate already keys on), and its capability `grants`. A door has a `state` (absent/`open` vs strictly `closed`): a closed door is declared but sealed — the seam exists in the topology and can be opened later (a state flip) without a structural change. `roomGrants` derives the occupant's boundary (explicit grants ∪ _open_ consumed-door capabilities; exposed doors are services, not occupant grants). Rooms follow a `<purpose>-room` naming convention (the room is the isolation unit; the OCI image that fills it keeps its own `-box` name). Two first instances: `builderRoom` (a VM-tier room — the "house in a room" case on darwin — exposing a `builder` door granting `nix:build`/`oci:image`) and `claudeRoom` (consumes the beadsd/keeperd daemon doors, and exposes a `session:control` door held strictly `closed` until the remote-control profile, prx-9s14, opens it). Adds `PodSpec` — the per-repo composition that holds co-resident rooms, owns the shared house (`ExecutorSpec`; member rooms make their own `executor` optional and inherit it via `effectiveExecutor`) and the door fabric. `resolvePodDoors` wires each room's `consume` door to the room that `expose`s the capability open (skipping `closed`, flagging `unresolved`); `podRoomEnv` projects the connection env into each consumer — for the beadsd door that's `PRX_BEADS_DOOR` + `PRX_BEADS_SOCKET`, which fires the merged bd-door gate. `perRepoPod` composes claude-room + beadsd-room + keeperd-room as the concrete instance. Driver rendering (pod → podman pod) is a later slice.
- 6f9dbd9: Give `RoomSpec` an optional `image` — the `-box` OCI image that fills the room (the room is the isolation unit, the box is the artifact). The pod-member rooms declare theirs (`claude-box`, `beadsd-box`, `keeperd-box`), and the podman driver renders `room.image` as the container image, falling back to a placeholder ref only when a room declares none. The full registry ref stays a deploy concern (prx-zj8).

### Patch Changes

- aa2614e: `prx beads doctor` now diagnoses the canonical daemon clone (`defaultCanonicalBeadsCwd()`, `~/.local/state/prx/beads`) instead of the process cwd. A daemon-served repo (the GH-296 one-true-source model) has no local `.beads/`, so the old cwd probe misread "no beads database found" as a false UNHEALTHY "issue_prefix not set", and `--fix` no-op'd with "did not restore a prefix". The doctor now matches every other `prx beads` verb (mirrors `beads-provision`); an explicit `--cwd` still overrides for the GH-228 worktree-clone case.
- 8533a5b: Fix the keeperd-box + beadsd-box images so prx actually runs (prx-hqqw). They put the fetched `bun --compile` release binary into a from-scratch image, where it couldn't execute (no `/lib` loader) and degraded to bare Bun, or — once the loader was found — crashed at startup with `ENOENT … uv_os_homedir`. Two fixes, mirroring the proven `claude-box` flake: (1) `nix/oci/prx-fhs.nix` wraps the **byte-intact** binary to invoke the nix glibc loader directly (`ld-linux-<arch>.so --library-path … /libexec/prx`) — patchelf corrupts the appended Bun blob, so the bytes must be left alone; (2) `dockerTools.fakeNss` + `HOME` give prx's `os.homedir()` (and dolt's user lookup) a `/etc/passwd` + writable home. Validated on podman: both daemons now start and bind their sockets (`keeperd: listening …`, `beadsd: listening …`).
- e3f35c2: Door-gate the `findEpicChildren` epic-children reads (epic_children.ts) — the last prx-zbsi read consumer. Both reads now route through the beadsd door in the box profile: `bd list --all` (the snapshot) and `bd dep list <id> --direction up --type parent-child` (the parent-child edges). Off-profile behavior is **byte-identical** — the gate falls back to the injected runner with the same argv, so the well-tested edge-shape parsing is untouched.

  To keep that argv (and its result shape) unchanged, the door dialer now recognizes the `bd dep list <id> … --type parent-child` read form and routes it to the `children` verb (added in #613) — rather than requiring the call site to switch to `bd children`. `dep add`/`remove` (writes) and a non-parent-child `dep list` still fail closed. The result shape is therefore consistent in-box and off-profile (both `bd dep list` rows).

  Gating also keeps these bd reads off `defaultRunner`'s GitHub rate-limit bucket in-box. This completes the door-backed **read** consumers for prx-zbsi; the remaining work is the bucket-B host-only `bd config`/dolt spawns (assert-ENOENT-in-box tests).

- dd3bf77: Gate the `resolveEpicChildBdIds` epic-children reads through the beadsd door (prx-zbsi, consumer of the `children` verb added in #613). The `--epic` delegate filter resolved an epic's children with two ungated `bd` spawns — `bd query "external_ref contains <epic>"` then `bd children <id>`. Now:

  - The epic lookup uses the door-backed `bd list --all` with an in-process `external_ref` substring match (`bd query` is not on the beadsd read surface; the substring match preserves the old behavior for both the issue URL and the legacy `GH-N` token).
  - The children read routes through the door-backed `bd children <id>` verb.

  Both reads go through a shared `bdReadOrNull` door-gate helper (also adopted by `readBdLabels`, de-duplicating the inline gate): in the box profile they reach the beadsd door; off-profile they fall back to `tryCommand` (null-on-failure preserved). The child-id extraction tolerates both the real `bd children` row shape and the door verb's `bd dep list --type parent-child` rows (both carry the child id in `id`).

  `findEpicChildren` (epic_children.ts, `bd dep list`) is the remaining epic-children consumer and is a separate follow-up.

- c98caf6: Extract the spec-driven CLI core into a standalone `@bounded-systems/verbspec` package.

  `VerbSpec`, `defineVerb`, `parseArgs`, `dispatch`, and the MCP / OpenAPI / Anthropic / CLI projections move out of `packages/prx/src/cli/verbspec.ts` (now `@bounded-systems/verbspec`, a `zod`-peer-dependency library) so the `@bounded-systems` libraries can author a verb once and share every surface projection. prx's change is internal-only: all verb authoring now imports the new package; no CLI/MCP/OpenAPI behavior changes.

- 4cfb86b: Fix prx-44y: `prx handoff enqueue` reported `created` but the row never persisted (so `prx handoff status` showed "no rows"). The handoff queue's bd memory ops (`bd remember`/`memories`) went through raw `execBd`, which from a worktree never reaches the one canonical clone the daemon owns — a phantom write.

  The handoff store now routes those ops through the beadsd daemon via a synchronous `execBd`-shaped adapter that spawns `prx beads <subcommand>` (reaching canonical through `withBeadsClient`). Keeping it synchronous preserves `claimHandoff`'s read-then-write best-effort CAS exactly (no async window introduced). Adds the `prx beads recall | memories | remember` CLI verbs (over the memory surface added to the daemon contract earlier) and maps the memory reads in the door dialer; `remember` (a write) fails closed over the read door like every other write.

  Existing handoff store/drain/cli tests pass unchanged (the adapter keeps the `execBd` injection seam), with new coverage for the adapter, the CLI verbs, and the dialer mappings.

- 9f23c22: Route the in-box `bd show` reads through the beadsd door in the box profile (prx-zbsi, GH-296 AC #3 follow-up). Both `hydrateBeads` (the beads hydration actor) and `readBdLabels` (the delegate-enrichment label read) now gate their `bd show` spawn on `bdDoorGate`: in the box profile (`PRX_BEADS_DOOR`) they dial the door (the same path `prx beads show` uses) instead of execing a local `bd`; off-profile the gate returns null and the existing runner/`tryCommand` spawns exactly as before — byte-identical. Gating `hydrateBeads` here also keeps that bd read off `defaultRunner`'s GitHub rate-limit bucket, where it never belonged.

  This is the dialer-backed `show` slice of prx-zbsi. The remaining ungated reads need a daemon read verb that does not yet exist (`bd dep list`/`bd query`/`bd children` for epic-children resolution — the door read surface is `ready`/`list`/`show` only) or are host-only workspace state (`bd config` watermarks, bucket B); both are tracked as prx-zbsi follow-ups.

- 00615d7: keeperd now **returns** the signed `push/v1` derivation in its ok response (prx-a36l). The daemon previously wrote the signed derivation only to the ledger, so `KeeperRemoteResponse.signedDerivation` was always absent — which made #634's door + `requireSigned` publish path a no-op (it could never satisfy the GH-2249 gate, failing closed). `handleKeeperRequest` now captures the derivation the attesting push appends (decorating the ledger's `append`, no `attest` change) and returns it; a bare push (no `ledgerRef`/signer) returns no `signedDerivation`. Tested at the handler and over the real socket (it survives the encode→decode round-trip). Found by the keeper-door spike (prx-b44y).
- b0b1194: Show an actionable hint instead of git's raw `fatal: not a git repository` when `prx next` (and other work-unit verbs) run outside a git working tree — e.g. a freshly provisioned sandbox that came up with no repo cloned. The hint points at `prx repo add <git-url>` / cd-into-a-worktree and `prx repo list`.

## 0.10.0

### Minor Changes

- 00ba898: feat(fetch): `prx fetch slack` drains the history cursor so one run gets the whole channel (prx-13x)

  The pure core now pages `conversations.history` from the watermark to the end
  of the delta (cursor pagination) instead of reading a single page, so
  `prx fetch slack <channel>` fetches **all** messages newer than the watermark
  in one run — no gap when a channel has more than `--limit` new messages. The
  read adapter surfaces the provider's `next_cursor`; the core loops until the
  cursor drains, a `--max-pages N` bound is hit, or the cursor stops advancing
  (defensive against a stuck cursor). Messages are deduped by `ts` across pages;
  the watermark advances once to the global max; the JSON summary reports
  `pages`.

  Defaults to draining the full delta; `--max-pages N` caps the pages per run
  (`--max-pages 1` restores the old single-page behaviour). Rate-limit/budget
  gating remains a follow-on (blocked on slackd, prx-tgy) — Slack has no
  github-budget points bucket.

- 731fd15: feat(fetch): content-scoped digest + SlackMessageContent zod/JSON schema for `prx fetch slack` (prx-psj)

  `prx fetch slack` now content-addresses each message by a **content projection**
  instead of the whole message: `sha256(canonical({channel, content}))` where
  `content` = identity (`ts`, `user`, `type`/`subtype`) + content (`text`,
  `blocks`, `files`, `attachments`). Volatile metadata — reactions,
  `reply_count`/`latest_reply`/`reply_users*`, `subscribed`, `is_locked`,
  `last_read`, `client_msg_id`, `team`, the `edited` wrapper — is dropped, so
  reaction/reply churn **dedups to nothing** and only a real content edit busts a
  message's digest. `ts` stays in the projection as identity (so identical text
  like "lgtm" doesn't collide into one blob).

  Adds `fetch/slack-content.ts`: the `SlackMessageContent` **zod** schema (source
  of truth), `projectSlackContent()`, and `slackMessageContentJsonSchema` (derived
  via `z.toJSONSchema`) — the typed contract a read-back/query surface can emit
  against.

  Migration: digests change shape, so the first fetch after this re-stores each
  message once under its content digest (pre-1.0, channels are small — negligible).
  Parent epic: prx-zes.

### Patch Changes

- 972325b: fix(beadsd): resolve the runtime repo root from cwd, not the binary dir (prx-ag7)

  beadsd's `client-factory` used `findRepoRoot()` — the build-time `.git`-marker
  walk whose default start is `import.meta.dir` — as its _runtime_ fallback. In a
  `bun --compile` binary (e.g. prx inside claude-box) that's `/$bunfs/root`, so
  repo-scoped verbs crashed with `findRepoRoot: no .git ancestor of /$bunfs/root`.
  Use `getRepoRoot()` (the `git rev-parse --show-toplevel` cwd resolver) for the
  runtime path; `findRepoRoot` stays for build/codegen.

- 91d21f8: feat(workspace): emit signed worktree-add/v1 in production (prx-hc5 slice 2 / prx-3qc)

  Wires keeper's `attestWorktreeAdd` (slice 1) into the live `claude --worktree`
  path. After a real materialization, the create hook emits a signed
  `worktree-add/v1` for the new worktree — opt-in + fail-safe, mirroring keeper
  push:

  - `resolveProvenanceSigner()` (the `PRX_PROVENANCE_KEY` env seam) → no key ⇒ no
    emission;
  - `resolveCanonicalChainLedger(targetPath)` → the per-workspace anchored-chain
    ledger (I-WS5: never under the mainx replica) ⇒ no ledger, no emission;
  - base commit (`origin/main`, what the branch was cut from) recorded as a
    material when resolvable;
  - only on a real placement (`status: "created"`, not the idempotent `exists`);
  - best-effort — a signing/ledger failure never aborts worktree creation.

  Injectable (`WorktreeHookCliDeps.emitProvenance`) for tests. Completes
  `docs/prx/worktree-provenance.md`'s slice 2.

## 0.9.0

### Minor Changes

- 14d2832: feat(fetch): `prx fetch slack <channel>` — sync a channel's reads to CAS with a per-channel watermark (prx-agd)

  Wraps the pure freshness/CAS core (`runFetchSlack`) with its three production
  seams: the gated `scout slack` read surface (now accepting `oldest`/`latest`),
  the on-disk plan-store CAS on a new `slack` domain (deduping each
  `conversations.history` message by content digest), and a per-channel
  `bd config` watermark (`prx.fetch.slack.<channel>.watermark`) advanced to
  `max(ts)` after each successful fetch. Idempotent end-to-end.

  Scope (v0): one read per run. Multi-page pagination (the `cursor` carry) and
  rate-limit/budget gating are deliberate follow-ons — Slack has no
  github-budget points bucket, so meaningful gating belongs with slackd
  (prx-tgy). Parent epic: prx-zes.

### Patch Changes

- 10136a1: feat(keeper): signed `worktree-add/v1` provenance for worktree materialization (prx-hc5)

  Worktree materialization (`claude --worktree` → keeper's `git worktree add`) was
  the one keeper git-write with no signed record. Keeper can now attest it, like
  `push/v1`:

  - `WORKTREE_ADD_BUILD_TYPE` (`https://prx.dev/git/worktree-add/v1`).
  - `attestWorktreeAdd(attest, {branch, targetPath, baseCommit?})` — emits a signed
    SLSA derivation whose **subject is the new worktree's branch tip** (declared,
    resolved via `HEAD` in the target worktree — `git worktree add` doesn't move the
    cwd's HEAD, so the self-describing `attestingGit` strategy doesn't apply), with
    the base commit as a material. Opt-in (only with a signer+ledger) and fail-safe
    (missing/malformed HEAD → no link), mirroring `runKeeperPush`.

  `runKeeperEnsureWorktree` stays synchronous; the attestation is a separate
  composable async step so `reserve`/`materialize`/the hook adapter don't inherit
  an async cascade.

  This replaces the rejected "route resolution reads through scout" framing
  (scout is for file-content reads, not git-state/infra reads — audited in the
  ADR). Production wiring (threading keeper's signer+ledger from the hook) is the
  deferred second slice. See `docs/prx/worktree-provenance.md`.

- 289550c: feat(workspace): `--repo <dir|slug>` makes `claude --worktree` dir-agnostic (prx-hot)

  The worktree hooks should resolve the repo explicitly rather than depend on
  whatever cwd Claude runs them from. `prx workspace worktree-create|worktree-remove`
  now accept `--repo <value>`:

  - an existing **directory** → used as the resolution anchor;
  - otherwise a **repo-registry slug** → resolved to its `mainWorktree ?? commonDir`
    via the same `loadRepoInventoryConfig → loadRepoInventoryIndex → findRepoBySlug`
    path `prx plan session --repo <slug>` uses.

  `prx workspace worktree-hooks [--repo <value>]` bakes `--repo <value>` (shell-quoted)
  into the registered `settings.local.json` hook command, so the hook runs from any
  cwd. Omitted → plain commands (resolution falls back to the invocation cwd + the
  prx-ph7 bare-repo fallback). Verified end-to-end from `/tmp` with both a bare-repo
  dir and the `prx` slug.

- fe6d721: fix(workspace): resolve the repo from a bare repo so `claude --worktree` works (prx-ph7)

  `claude --worktree <name>` failed with `workspace.reserve: cwd is not a
recognized GitHub repo`. Claude Code runs `WorktreeCreate`/`WorktreeRemove`
  hooks from the **bare repo** (the git common dir), which has no working tree, so
  `resolveRepoToplevel` (`git rev-parse --show-toplevel`) returned null and both
  `reserve` and `materialize` failed closed.

  prx now resolves the layout itself instead of depending on being launched inside
  a worktree: when `--show-toplevel` fails, `resolveRepoToplevel` falls back to the
  first non-bare worktree from `git worktree list --porcelain` (origin + the
  worktree list both resolve fine from a bare repo). keeper's `git worktree add`
  already worked from the bare repo — this just feeds reserve/materialize a real
  worktree path to compute the sibling placement against. Extracted
  `firstNonBareWorktree` as a pure, unit-tested parser.

  Fixes the live `claude --worktree` smoke-test failure from the prx-6jb/prx-5q3
  rollout.

## 0.8.3

### Patch Changes

- f90dbdc: feat(adapters): route the gh mirror write-back through the daemon (GH-296)

  `GhDomainAdapter.push()`'s unlinked-create path wrote the new issue URL back to
  bd with host `bd update <id> --external-ref <url>` against the per-clone `.beads`.
  That write-back now goes through `updateBeadViaDaemon` (the single writer), using
  the `update --external-ref` field added to the daemon contract. `push()` is async,
  so it awaits the helper directly; the writer is injectable (`deps.updateBead`) for
  tests and defaults to the daemon helper in production. The cache `invalidate()` on
  success is unchanged. Another bulk write reconciler off host bd, toward prx-82b.

- 6ba5079: feat(tools): route the bd close primitive through the daemon (GH-296)

  `execBdIssueClose` — the single `bd close` wrapper behind `submit postmerge`, the
  gh adapter's `bulkClose`, and `intake merge`'s dup close — spawned host `bd close
<id>` against the per-clone `.beads`. It now spawns `prx beads close <id>
[--reason]`, which the daemon maps to `bd update --status closed --notes`. One
  spawn-target change migrates all three callers' close path off host bd at once.
  Toward removing host bd (prx-82b).

- 3f51a14: feat(triage): route close-stale's WRITE through the daemon (GH-296)

  `triage close-stale` closed stale beads with host `bd update -s closed --notes …`
  against the per-clone `.beads`. Its write now runs `prx beads close <id> --reason …`
  through the daemon (the trusted single writer; maps daemon-side to
  `bd update --status closed --notes`). A sync subprocess keeps `runTriageCloseStale`
  synchronous (no async ripple to its 14 call sites / the CLI), matching the prx-fda
  read pattern; the runner is injectable for tests. Another bulk write reconciler
  off host bd, toward prx-82b.

- 207cd7f: ci(coverage): add an 85% line-coverage gate + cover the last sub-80% files

  `coverage-summary.ts` gains a `--min <pct>` flag that exits non-zero when parsed
  line coverage is below the threshold; the coverage workflow now runs it with
  `--min 85`, so the `coverage` job fails below the 85% floor (the project sits at
  ~87%). Also raises the remaining sub-80% files: `beads/workspace_mode` 77→96%
  (probeSharedServerHasIssues + readBeadsMetadata arms), `tools/agent_doctor`
  76→83% (classifyError categories + truncate), and `beads/migrate` 79→82%
  (the non-embedded refusal modes).

- 7e490e1: test(prx): make pr-state/status-report testable + cover it → 100%

  `refreshTaskSignals` read the worktree branch + live PR signals through direct
  git/gh imports, so its signal-reconciliation logic was untestable (the file sat
  at ~19%). Add a `StatusSignalsDeps` seam (loadReviewConfig / currentBranchName /
  fetchPrSignalInfo, defaulting to the real impls), threaded through `renderStatus`,
  so every reconciliation branch is drivable against an on-disk task-contract
  fixture with no git branch or GitHub round-trip. 19% → 100%.

- f93d4ec: feat(beadsd): add a `dep` write kind to the daemon (GH-296)

  The daemon write contract gains a structured `dep` kind —
  `bd dep add --type <t> <from> <to>` / `bd dep remove <from> <to>` — threaded
  through the wire contract, the daemon dispatch (with a special-case: `bd dep` is
  not a `--json` surface, so a zero exit replies ok/null), a `depViaDaemon` helper,
  and a `prx beads dep add|remove` CLI. This is the last missing daemon write
  capability; it unblocks the dependency-edge reconcilers still on host bd
  (promote-children parent-child wiring, dedupe edge rewire) — toward prx-82b.

- af67dca: feat(beadsd): extend the daemon `update` write with `--external-ref` / `--notes` (GH-296)

  The daemon write contract's `update` kind gained `externalRef` and `notes`
  (both valid `bd update` flags) — threaded through the wire contract, the daemon's
  `bd` dispatch, the `updateBeadViaDaemon` helper, and the `prx beads update` CLI
  (which also now exposes the already-contracted `--type`). This is the Group-B
  infra that unblocks the remaining bulk write reconcilers still on host bd: the
  adapter mirror write-back and `prx beads publish` (`--external-ref`), and
  intake-comment (`--notes`). No behavior change to existing callers — purely
  additive optional fields. A step toward removing host bd (prx-82b).

- 4718b8c: feat(doctor): route dedupe-bd's edge + close WRITES through the daemon (GH-296)

  `prx doctor dedupe-bd`'s apply phase rewrote dependency edges and closed
  duplicates with host `bd dep remove`/`bd dep add`/`bd update -s closed` against
  the per-clone `.beads`. All three now run through the daemon — `prx beads dep
remove|add` (the `dep` kind from #537) and `prx beads update <id> --status closed
--notes` (the close). The close argv switched `-s` → `--status` so it passes to
  the typed CLI. A sync runner keeps `runDedupeBd` synchronous; injectable for
  tests. Toward removing host bd (prx-82b).

- 5a6a586: feat(delegate): route `delegate assign`'s WRITE through the daemon (GH-296)

  `prx delegate assign` wrote the owner with host `bd assign <id> <name>` against
  the per-clone `.beads`. The write now runs `prx beads update <id> --assignee
<name>` through the daemon (single writer; `bd assign` is shorthand for
  `bd update --assignee`, empty string clears). A sync subprocess keeps
  `runDelegateAssign` synchronous; the runner is injectable for tests. The
  eligibility read (`runBdShow`) is a separate no-cache path for a later pass.
  Toward removing host bd (prx-82b).

- 6887963: feat(triage): route drift-fix WRITES through the daemon (GH-296 prx-ebo)

  `triage drift-fix`'s apply phase mutated beads with host `bd update`/`bd reopen`
  against the per-clone `.beads` — the broken store GH-296 is retiring. Its two
  write seams now go through the daemon (the trusted single writer):

  - type/priority fix → `updateBeadViaDaemon(id, { issueType, priority })`
  - status fix → `reopenBeadViaDaemon(id)`

  Both default to the beadsd helpers and are injectable (`deps.updateBead` /
  `deps.reopenBead`) for tests. The helpers throw on a non-ok daemon verdict
  (vs `execBd`'s exit code), so a failed write records `exitCode: 1` + the daemon's
  message in the audit row (partial-write accounting unchanged). The aggregate read
  already routes through the daemon via the BeadsCache loader (prx-fda).

  A step toward removing host bd (prx-82b): the remaining bulk write reconcilers
  (promote, intake-mirror/merge/comment, close-stale, dedupe deps, adapters
  write-back) are the next sites.

- 374beb1: feat(beads): route the aggregate bead read through the daemon by default (GH-296)

  The per-invocation `BeadsCache` — threaded by runCli into every read verb (sync,
  intake, triage, scout, adapters) — now reads through the daemon (the GH-296 one
  true source) instead of spawning host `bd list` against the broken per-clone
  `.beads`. This flips the production aggregate-read path off host bd in a single
  move (prx-fda).

  - New `triage/beads-daemon-loader.ts` `loadAllBeadsViaCli`: a SYNC
    `prx beads list --all --limit 0` spawn (same daemon query as
    `loadAllBeadsViaDaemon`: `{kind:"list", all:true, limit:0}`), parsed with the
    existing `parseBeadsRecords`. Sync on purpose — `loadAllBeads`/`BeadsCache.load`
    are called deep inside sync verb code, so a subprocess avoids an async ripple
    across ~24 call sites. Recursion-safe (`prx beads list` reads via the socket
    door, not this cache). Fail-loud on an unreachable daemon — never silently
    reports zero beads. Honors a `prxBinary` override for non-PATH invocation.
  - `createBeadsCache` defaults to this daemon loader; an injected `loadAllBeads`
    (tests, or an explicit local-bd loader) still wins and receives `exec`.

  A step toward removing host bd (prx-82b): the bulk WRITE reconcilers and any
  no-cache `?? defaultLoadAllBeads` fallbacks remain on bd and are the next steps.

- 4398eab: feat(fetch): route the GH→bd sync writer's update through the daemon (GH-296)

  The fetch writer mirrored GH issue state into bd with host `bd update <id>
--external-ref … --status … --title …` against the per-clone `.beads`. It now
  runs `prx beads update …` through the daemon. This also extends the daemon `update`
  write contract with `--title` and `--description` (threaded through contract,
  daemon dispatch, the `updateBeadViaDaemon` helper, and the `prx beads update`
  CLI) — the last update fields the bulk reconcilers needed. A sync runner keeps
  `writePage` synchronous; injectable for tests. Toward removing host bd (prx-82b).

- 1357b7d: feat: add @bounded-systems/host capability; route all prx/src node:os ambient reads through it

  `os.homedir()` / `os.tmpdir()` / `os.hostname()` are ambient host authority that
  was being read raw from `node:os` across ~20 prx/src files — a hidden dependency
  that escaped import analysis and (because `os.homedir()` ignores `$HOME` on
  macOS) could not be redirected in tests.

  New `@bounded-systems/host` package is the one sanctioned reader of that state,
  mirroring `@bounded-systems/env` for `process.env`:

  - `homeDir()` honors an explicit `$HOME` override (via @bounded-systems/env)
    before falling back to `os.homedir()`, so tests/sandboxes can redirect it;
  - `tmpDir()` / `hostName()` wrap `os.tmpdir()` / `os.hostname()`.

  Every `prx/src` caller now imports from `@bounded-systems/host`, and the
  ambient-authority guard gains a rule forbidding raw `node:os` in `prx/src`
  (a hard guarantee, mirroring the existing `process.env` ban).

- e9add44: feat(intake): route intake-comment's bd note WRITE through the daemon (GH-296)

  `prx intake comment` on a bd-shaped id appended its note with host `bd update <id>
--notes …` against the per-clone `.beads`. It now runs `prx beads update <id>
--notes …` through the daemon (using the `update --notes` field added in #528). A
  sync subprocess keeps `runIntakeComment` synchronous; runner injectable for tests.
  Toward removing host bd (prx-82b).

- 23c9cf9: feat(intake): route `prx intake`'s bd create through the daemon (GH-296)

  `prx intake` created its bd record with host `bd create --silent --type … --title
…` against the per-clone `.beads`. It now runs `prx beads create --type … --title
… [--description]` through the daemon and parses the created id from the JSON echo
  (no `--silent`). The `--to gh` publish leg is threaded the same sync runner so its
  write-back also routes through the daemon. Toward removing host bd (prx-82b).

- 23fb674: feat(intake): route intake-merge's pointer-note WRITE through the daemon (GH-296)

  `prx intake merge`'s bd↔bd arm appended the merge pointer note with host `bd
update <id> --notes …` against the per-clone `.beads`. It now runs `prx beads
update <id> --notes …` through the daemon. A sync runner keeps `runIntakeMerge`
  synchronous; injectable for tests. The dup close still flows through
  `execBdIssueClose` (migrated separately at the close primitive). Toward removing
  host bd (prx-82b).

- 5181fb9: feat(intake): route intake-mirror's bd create through the daemon (GH-296)

  `prx intake mirror` created the bd record for a GH issue with host `bd create
--silent --external-ref … --title …` against the per-clone `.beads`. It now runs
  `prx beads create --type task --external-ref … --title …` through the daemon and
  parses the created record's id from the JSON echo (no `--silent` id-line needed).
  Also exposes `--external-ref` / `--silent` on the `prx beads create` CLI (the
  contract already carried them). A sync runner keeps `runIntakeMirror`
  synchronous; injectable for tests. Toward removing host bd (prx-82b).

- 106f3f1: feat(adapters): route the notion adapter's writes through the daemon (GH-296)

  `NotionDomainAdapter` wrote bd with host `bd update <id> --metadata
external_refs.notion=<pageId>` (the mirror write-back) and `bd update <id>
--status closed` (bulkClose) against the per-clone `.beads`. Both now run
  `prx beads update …` through the daemon. This also adds `--metadata` to the daemon
  `update` write contract (threaded through contract, dispatch, the
  `updateBeadViaDaemon` helper, and the `prx beads update` CLI). A sync runner
  replaces the `bdExec` getter; injectable for tests. This was the last bd WRITE
  reconciler on host bd — toward removing host bd (prx-82b).

- 91cd966: ci(coverage): add a per-file coverage ratchet (every src/ file ≥ 80%) alongside the global 85% gate

  `coverage-summary.ts` gains `--per-file-min <pct>`: every product source file
  (`packages/**/src/**`, tests excluded) must clear the floor unless it is in
  `PER_FILE_BASELINE`. The baseline only SHRINKS — a baselined file that climbs
  to/above the floor (or is deleted) goes "stale" and fails the gate, so fixing a
  file forces dropping its baseline entry. The coverage workflow runs the gates at
  `--min 85 --per-file-min 80`; the seven currently-exempt files (deprecated tui,
  the in-decomposition cli.ts/cli-spawn, the triage haiku files pending #502, and
  session/open) are baselined with reasons.

- c89a5f2: feat(triage): route promote-children's dep-edge WRITE through the daemon (GH-296)

  `triage promote-children` wired parent-child / blocks edges with host `bd dep add
--type <t> <from> <to>` against the per-clone `.beads`. It now runs `prx beads dep
add …` through the daemon (the `dep` write kind added in #537). A sync subprocess
  keeps `runTriagePromoteChildren` synchronous; runner injectable for tests. Toward
  removing host bd (prx-82b).

- bc16fa4: feat(triage): route `triage promote`'s bd create through the daemon (GH-296)

  `prx triage promote` created bd records for GH issues with host `bd create
--silent --external-ref … --type … -p … --title …` against the per-clone
  `.beads`. It now runs `prx beads create --external-ref … --type … --priority …
--title …` through the daemon and parses the created id from the JSON echo (no
  `--silent`; `-p` → `--priority`). The GH pointer-comment leg stays on gh. A sync
  runner keeps `runTriagePromote` synchronous; injectable for tests. Toward
  removing host bd (prx-82b).

- 09f5ee8: feat(workspace): prx registers its own `claude --worktree` hooks in settings.local.json (prx-5q3)

  Follow-up to prx-6jb (the `prx workspace worktree-create|worktree-remove` verbs):
  prx now owns the _registration_ too, with no ai-home / `home-manager switch`
  dependency. Hooks are written to `.claude/settings.local.json` — the per-user
  surface prx already manages and the per-worktree stamper never clobbers — not
  project `.claude/settings.json`, which stays permissions-only by design.

  - `ensureClaudeWorktreeHooks(cwd)` (machine/claude_local_settings.ts): idempotent
    merge of the `WorktreeCreate`/`WorktreeRemove` hook block (pointing at the prx
    verbs) into `settings.local.json`; preserves other hooks/permissions; refuses
    to stomp malformed JSON.
  - `prx workspace worktree-hooks`: register the hooks in the current worktree —
    the one-shot for a root/existing worktree the workspace actor won't touch
    (`mainx` is I-WS5 guarded).
  - Self-propagation: `prx workspace worktree-create` now arms the newly
    materialized worktree's `settings.local.json` (best-effort — never aborts
    creation), so a `claude --worktree` launched from inside it also routes
    through prx.

  Activation still requires a release that ships the verbs (the installed prx is a
  release binary). Replaces the ai-home-registration framing of prx-5q3.

- 22b106e: feat(workspace): prx owns the `claude --worktree` lifecycle via WorktreeCreate/WorktreeRemove hooks (prx-6jb)

  `claude --worktree` errors in the bare-repo + external-worktree layout ("not in
  a git repository and no WorktreeCreate hooks are configured"). prx now satisfies
  Claude Code's documented hook contract through its own verbs:

  - `prx workspace worktree-create` — reads the `{ name }` envelope from stdin,
    reserves + materializes a worktree (keeper does the `git worktree add`), and
    echoes the absolute path (Claude reads it as the session cwd; a non-zero exit
    aborts creation).
  - `prx workspace worktree-remove` — reads the `{ worktree_path }` envelope,
    removes the git worktree (keeper) and marks the lifecycle ledger torn_down
    (workspace actor).

  Keeper gains `runKeeperRemoveWorktree`, the symmetric counterpart of
  `runKeeperEnsureWorktree`, so keeper is the sole owner of both `git worktree add`
  and `git worktree remove`/prune; the workspace actor owns only the ledger. The
  adapter (`runWorktreeHookCli`) wires Claude's envelope to that split over the
  existing `worktree-hook.ts` boundary. Hook registration (a thin pointer to these
  verbs) and the wt/wtctl retirement follow separately (prx-arl).

- 07e4320: feat(beads): route `prx beads publish`'s external-ref write-back through the daemon (GH-296)

  `publish`'s link/adopt and create-then-link paths wrote the GH issue URL back to
  bd with host `bd update <id> --external-ref <url>` against the per-clone `.beads`.
  Both write-backs now run `prx beads update <id> --external-ref <url>` through the
  daemon (single writer), using the `update --external-ref` field added in #528. A
  sync runner is threaded through `publishOne`/`publishOneInner`/`linkExistingResult`
  (injectable for tests); the dedup read stays on the existing loader. Toward
  removing host bd (prx-82b).

- 024118d: feat(sync): pull-leg conditional-read core — ETag parser + per-issue ETag store (GH-296)

  The reconcile pull leg (GH→bd) re-reads every pinned GitHub issue every tick and
  is not `--limit`-gated — the sync API hog. This lands the pure, isolated core for
  GitHub conditional requests, ahead of wiring it into the adapter:

  - `sync/conditional-read.ts` — `parseConditionalRead` classifies a `gh api … -i`
    result as not-modified / modified / error. It keys on the HTTP status line, not
    the exit code, because `gh api` exits non-zero on BOTH a `304 Not Modified` and
    a real error (404/410/5xx); a 304 must never be mistaken for a failure, nor a
    failure for "unchanged".
  - `sync/pull-etag-store.ts` — per-(repo,domain) persisted `If-None-Match` cache
    (etag + last derived state) under `~/.local/state/prx/sync/<key>/pull-etags.json`,
    loaded once into memory and flushed in a single write per tick.

  A `304` is free against the GitHub rate limit and GitHub is authoritative on
  changed-vs-unchanged, so reusing cached state on a 304 is provably correct. No
  behavior change yet — nothing calls these until the adapter wiring (prx-lzw step b2).

- e6fca38: feat(sync): wire pull-leg conditional reads into the gh adapter + reconcile (GH-296)

  The reconcile pull leg now does GitHub conditional requests, cutting its per-tick
  rate-limit spend on unchanged issues (prx-lzw lever 1, building on the core in #504):

  - `GhDomainAdapter.pull()` gains an optional `conditionalRead` cache. When wired,
    it issues `gh api repos/{owner}/{repo}/issues/{n} -i -H "If-None-Match: <etag>"`:
    a `304 Not Modified` (free against the rate limit) reuses the cached patch; a
    `2xx` re-parses the fresh REST body and updates the cache; anything else throws.
    The decision is made from the HTTP status line, not the exit code (`gh api`
    exits non-zero on both a 304 and a real error). Absent ⇒ unconditional
    `gh issue view` (unchanged behavior). The REST and `gh issue view` bodies share
    one `parseIssuePatch`.
  - `runBeadsSync` constructs a per-(repo,domain) `createPullEtagStore`, wires it into
    the gh adapter, and flushes it once after the pull leg (one file write per tick).

  A 304 is free and GitHub is authoritative on changed-vs-unchanged, so reusing
  cached state is provably correct (not a client-side heuristic).

- 6435da5: perf(sync): short-circuit the bd→GH push leg when the bead store hasn't moved

  runBeadsSync now reads the dolt clone's `hashof('HEAD')` and compares it against a
  per-(repo,domain) "last successfully pushed HEAD" watermark. When the bead store is
  unchanged since the last fully-successful push, the push leg is skipped entirely —
  no per-bead GitHub mirror writes. The watermark only advances on a clean push
  (no deferrals, no errors), so a partial failure safely retries next tick. `--dry-run`
  never skips. (GH-296 / prx-lzw step a)

- 5b7e625: chore: delete the `@bounded-systems/prx-mux` package (slice 4 of removing tmux entirely). After slices 1–3 removed every tmux caller, the package had no remaining consumers in `packages/prx/src` except a re-export of `CommandRunner`/`defaultRunner` from `@bounded-systems/proc`. Those imports (`gh-pr-fetcher` + example + test) are repointed directly at `@bounded-systems/proc`; the package is removed from the workspace deps + tsconfig paths and deleted along with its tests.
- caf24c4: docs: scrub remaining tmux references after the full tmux removal (slice 5). Updates the agent-session command descriptions (`--interactive for PTY`, no longer "tmux/PTY"), drops the deleted `prx-mux` package from the companion-repos extraction table and the roadmap wave list, refreshes the pipeline-orchestrator "No tmux" note to reflect that tmux is gone entirely (surface, actor, interactive attach, and the `prx-mux` package), and regenerates the derived docs (cli.md, README, jsonld, project.md). Historical design records (the GH-1836 substrate ADR) are left intact.
- ce8b266: refactor: remove the interactive tmux/PTY session path (slice 3 of removing tmux entirely). prx sessions are now headless-only — `prx plan session`, `prx session open`, and `prx implement agent` no longer spawn or attach a durable tmux session; the live session runs directly in the foreground terminal (stdio-inherit) and the implement path runs the headless SDK job in-process. The `prx review` / `prx ultrareview` send-keys verbs (which only existed to inject `/review` into the live tmux pane) and the internal `prx tools mux clear-resurrect` verb are removed, along with the `pr-state/surfaces/tmux.ts` surface reader and the `--interactive`/`--headless` flags on `prx implement agent` (headless is the only mode). The `@bounded-systems/prx-mux` package itself is removed in a later slice.
- de3154f: refactor: remove the tmux parity surface, the tmux/session board actions, and the `prx prune session` command (slice 2 of removing tmux entirely). The board projection no longer reads or stamps a tmux session surface; disposition classifies a unit as complete on the four durable surfaces (worktree + local branch + remote branch + PR) without requiring a tmux session; `worktree-remove` no longer tears down a tmux session; and the `tmux` actor + its reconcile events/facts are dropped from the machine catalog. The interactive `prx review` send-keys path and the `prx-mux` package are removed in later slices. (`prx prune` itself is slated for replacement by `gc`.)
- 5aabf05: feat(delegate): route repair-assignees' assign WRITE through the daemon (GH-296)

  `prx delegate repair-assignees --apply` rewrote bd assignees with host `bd assign
<id> <to>` against the per-clone `.beads`. It now runs `prx beads update <id>
--assignee <to>` through the daemon (`bd assign` == `update --assignee`). A sync
  runner keeps `runRepairAssignees` synchronous; injectable for tests. The matched
  `bd list --assignee` read stays for the reads sweep. Toward removing host bd (prx-82b).

- 77dd2ea: Add the sync API-efficiency design (docs/spikes/prx-ebo): grounds the "sync ate more API requests than necessary" concern — the reconcile's pull leg re-reads every pinned GitHub issue every tick (not --limit-gated) — and sequences the two fixes: pull-leg conditional reads (GitHub ETags / GraphQL batching, the hog) and a push-leg bead-etag short-circuit with retry-safety (the cheap, safe win).
- 0299c53: Add the correctness core of the bd→GH push-leg short-circuit (GH-296, prx-lzw): pure, tested decisions (`shouldSkipPush`, `pushFullySucceeded`, `advanceLastPushedHead`) that let the reconcile skip the push leg — and its GitHub write requests — when the bead store (the daemon's dolt HEAD etag) hasn't moved since the last _successful_ push. Retry-safe: a deferred (`--limit`) or errored push never advances the watermark, so transient failures retry rather than being skipped forever. The `runBeadsSync` wiring (read the etag, persist the watermark) is a thin follow-up over these.
- 23ca06a: refactor(triage): break the triage actors↔machine import cycle; make the per-run actors testable

  `triage/actors.ts` could not be loaded in isolation — `actors → prune-merged →
pr-state/cli → prime → machine → actors` formed an import cycle that threw a TDZ
  on `statusActor` (and dragged the 23k-line CLI in at load time, hanging tests).
  Root cause: `pruneMergedActor`'s delegate reached into `pr-state/cli.ts` for two
  surface-sync/git primitives that never belonged there.

  - Extract `pruneStaleRemoteRefs` + `applyParityChainActions` into a focused leaf
    module `pr-state/parity-chain.ts`; `cli.ts` re-exports them so its existing
    callers (gc drivers, tests) are unaffected, and `prune-merged.ts` imports them
    directly — breaking the cycle and the CLI's load-time pull.
  - Forward an optional, test-only `deps` seam through every real triage actor's
    input to its delegate (mirroring `dep-research/actors`'s `fetcher` seam), so a
    wrapper can be driven hermetically. The machine never supplies it (production
    uses the real deps); behavior is unchanged.

## 0.8.2

### Patch Changes

- 7d44141: `createBeadsCache` is now UoW-coherent and generation-aware (GH-296, prx-ebk): `upsert(record)` patches one record by id (write-through) and `remove(id)` drops one — so a write no longer busts the whole cache. With an optional `generation` source (the daemon's dolt HEAD etag), `load()` re-fetches only when the dataset moved, so a stable HEAD serves cached data. Existing `load()`/`invalidate()` callers are unchanged.
- 33fdb36: beadsd now surfaces a **dataset etag** on every `ok` reply (GH-296, prx-ebk): the served clone's dolt HEAD hash — one cheap content-addressed generation token for the whole bead store. The daemon caches it (read on start + after each reconcile via `prx beads serve`'s `readHead`), so reads don't spawn dolt per request. Unchanged HEAD ⇒ nothing moved, so callers can validate caches and sync can short-circuit (skip redundant GitHub API calls) when the bead DB hasn't advanced. The field is optional; the daemon omits it when no HEAD source is wired.
- 0b70ce5: `prx beads list` now accepts `--all` and `--limit <n>` (GH-296), exposing the aggregate read the wire contract already supported (`list { all, limit }`). `prx beads list --all --limit 0` returns every record across statuses — the shape the bulk readers need. First step of routing the bulk readers through the daemon (epic prx-697 / prx-fda).
- 02e3ae4: beadsd writes are now durable (GH-296, sync-agent epic prx-697): the daemon's periodic refresh upgrades from a pull-only freshness step to a **full dolt reconcile** (commit local writes → pull → push). Daemon writes (create/update/close/reopen, which land in the served clone) are committed and pushed to the canonical remote on the interval, instead of sitting local until the next re-provision. Reuses the `dolt-reconcile` pipeline; quiet and non-throwing — if the push step lacks remote creds it's swallowed, and commit+pull still run (writes stay local, never lost). Leverages dolt's native sync (the data-sync framework) rather than a bespoke pusher.
- c8ec403: Additive testability seams (behavior-preserving): `defaultProbe` and
  `bdDelegatingSpawn` in dolt/start take an injectable spawn (default real), and
  `defaultReadLedger`/`defaultWriteLedger` are now exported, so the bd-backed
  start defaults are unit-testable. Production call sites pass nothing.
- 0c8fec1: Additive testability seams (behavior-preserving): `readSubstrateWatermark` and
  `defaultSubstrateRefresher` in the fetch freshness-gate take an injectable
  reader/fetch (default to the real bd/gh implementations) so their outcomes are
  unit-testable. Production call sites pass nothing.
- a34de92: test(prx): cover the `prx ci` (local-ci) phase internals via a `{ run, capture }` subprocess seam

  `phaseSpec` and `runPhase` now accept an optional `LocalCiRunners` seam
  (defaulting to the real `defaultRunner`/`runCaptured`) and are exported, so the
  spec-building, git-SHA bake, dist-dir prepare, and plain/json phase dispatch are
  testable without spawning the heavy `bun`/`git` tools. Behavior is unchanged for
  existing callers. Coverage 37% → 100%.

- e6f4c58: Add the sync-agent build-vs-adopt decision (docs/spikes/prx-3eu): keep dolt as the data-sync framework (already adopted; the daemon's push durability leverages it), keep the bd↔GitHub reconcile bespoke (it's a cross-system transform, not replica sync), and do not adopt a generic sync/CRDT framework. The sync agent is an orchestrator over dolt + the existing reconciler.

## 0.8.1

### Patch Changes

- 9346a94: Add `prx beads prime` — the daemon-aware session primer (the prx-beads twin of `bd prime`, GH-296). It prints how to reach beads (`prx beads <verb>` through the per-repo daemon, not raw `bd`) plus live ready-work from the daemon. Resilient by design: an unreachable daemon still prints the guidance and exits 0, so it's safe as a SessionStart hook. This is the in-repo enabler for repointing the SessionStart hook off raw `bd prime`.
- 47843a4: beadsd now keeps its served clone fresh (GH-296): `runBeadsServe` runs an injected `refresh` on start and every 5 minutes, and `prx beads serve --cwd <clone>` wires that to `bd dolt pull` in the served clone. Refresh errors are swallowed (a stale-but-up daemon beats a crashed one); conflict resolution against local writes is left to the sync agent. So a long-lived local daemon no longer serves indefinitely-stale beads.

## 0.8.0

### Minor Changes

- 3ffdce8: GH-411 slice 5 (finale): **remove the deprecated `ai-home` env-name aliases** and
  flip the nix home-manager module to the neutral name. Breaking, by design.

  - `operator-config.ts` / `build-info.ts` / `prx-compile.ts`: drop the
    `PRX_AI_HOME_ROOT`, `BAKED_AI_HOME_ROOT`, `__PRX_BUILD_AI_HOME_ROOT__`, and
    `PRX_COMPILE_AI_HOME_ROOT` read-aliases. Only the neutral names
    (`PRX_OPERATOR_CONFIG_ROOT` / `BAKED_OPERATOR_CONFIG_ROOT` /
    `__PRX_BUILD_OPERATOR_CONFIG_ROOT__` / `PRX_COMPILE_OPERATOR_CONFIG_ROOT`) are
    read now.
  - `nix/hm-module.nix`: the `programs.prx.aiHomeRoot` option →
    `programs.prx.operatorConfigRoot` (exports `PRX_OPERATOR_CONFIG_ROOT`).

  **Breaking — consumer action required.** Any home-manager config that sets
  `programs.prx.aiHomeRoot` must rename it to `programs.prx.operatorConfigRoot`,
  and any shell/env that exported `PRX_AI_HOME_ROOT` must export
  `PRX_OPERATOR_CONFIG_ROOT`. Without the rename, `home-manager switch` fails with
  an unknown-option error.

### Patch Changes

- 7b12e6a: Remove dead code (knip): the unused `machine/{index,events,state,derive-phase,invariants}.ts` re-export shims and the never-wired `pr-state/personal_sprintx.ts`. The personal-sprint metric/goal model is captured as a backlog idea in #438 for a future, properly-wired implementation.
- c3a8b84: `BeadsResolver` (the canonical=bd hydrate path) now reads through beadsd (GH-296): the `BD-<8hex>` + external-ref snapshot scans use `loadAllBeadsViaDaemon` and the record fetch uses `showBeadViaDaemon`, instead of local `runBdShow`/`loadAllBeads`. Per the per-repo/single-workspace decision (one daemon = one repo; multi-tenant rejected), the resolver's `cwd` is vestigial — it routes to the single per-repo daemon. `toBdLongId` (used by `primePlanSession`'s canonical=bd fork) is now async.

## 0.7.4

### Patch Changes

- 6ab3bf8: Additive testability seams (behavior-preserving): the intake→triage default
  UoW reader is now built via `uowReaderWith(run = defaultRunner)`, and
  `runGhAuthStatus` / `runGhApiUserLogin` take an injectable `spawn` (defaults to
  the real proc). Production call sites pass nothing.
- 038eef8: GH-411 slice 3: make the `prx home update` / `prx upgrade` coupled flake-input
  set config-driven instead of hardcoding `ai-home`. The default now reads
  `homeUpdate.inputs` from `~/.config/prx/config.json` (e.g. `["prx", "ai-home"]`),
  falling back to `["prx"]` when unconfigured — prx always updates its own input.
  `prx upgrade` is now a thin pass-through (no baked `--input prx,ai-home`); an
  explicit `--input` / `PRX_HOME_FLAKE_INPUT` still overrides. Also resolves #21
  (home update now includes `prx`, not just the consumer).

  Operator note: to keep `prx upgrade` bumping the consumer flake, add
  `{"homeUpdate": {"inputs": ["prx", "ai-home"]}}` to `~/.config/prx/config.json`.

- c5c0f96: GH-411 slice 4: make the repo→commit-scope map config-driven instead of
  hardcoding `bdelanghe/ai-home`. `inferOperatorScopeFromCwd` (the `--scope`
  default for `prx intake`) now reads `scopeMap` from `~/.config/prx/config.json`
  (e.g. `{"scopeMap": {"owner/repo": "prx"}}`) — unconfigured → `no-mapping`, so
  the caller requires an explicit `--scope`. Adds a single shared operator-config
  reader (`operator-config.ts`: `readOperatorConfig` / `readOperatorConfigStringMap`)
  that `homeUpdate.inputs` (slice 3) now also uses, de-duplicating the config.json
  parse. Repo-identity doc examples in `registry_store.ts` / `beads/hydrate.ts`
  reworded off the personal repo to `example-owner/example-repo`.

  Operator note: to keep `prx intake` auto-scoping your repo, add
  `{"scopeMap": {"<owner>/<repo>": "prx"}}` to `~/.config/prx/config.json`.

- 5d4bacd: `scout read` signing is now fail-closed in a signing context (GH-352), mirroring `prx ci`: when a read is in scope of a provenance ledger (a reserved work-unit / pipeline) but no signer is configured, the read is refused with a clear message (`prx provenance setup` / `prx provenance status`) — an unsigned in-pipeline read is not trusted. A bare read outside a work-unit (no canonical ledger) is unaffected, and a transient signing-execution error when a signer IS configured stays best-effort (never drops the read).
- 12ac1f2: `prx plan search` and `prx intake search` now read beads through the beadsd daemon (GH-296): the case-insensitive title filter (`searchBd`) is refactored into a pure function over records, and the verbs load via `loadAllBeadsViaDaemon` (search is a legitimate scout-shaped aggregate read). No local `bd` in the search path. The local-only "bd list exited non-zero but emitted a valid array" tolerance no longer applies at the verb level — the daemon (server-mode dolt) owns the parse and that post-listing condition can't occur; bd-unreachable still degrades to GH-only.

## 0.7.3

### Patch Changes

- 3ed1866: Add the `reopen` kind to the beadsd write surface (GH-296 wave 2) — contract + daemon (`bd reopen <id>`, an allowed subcommand so it dispatches directly, unlike the policy-blocked `close`) + `reopenBeadViaDaemon` helper + `prx beads reopen <id>` CLI. This completes the **atomic** write contract (create / update / close / reopen); bulk reconcilers (promote / drift-fix) are left to a future sync agent.
- 7cd371a: Add `prx beads create|update|close` — the single-writer surface routed through beadsd (GH-296 wave 2). Like the read door, no `--vm` ⇒ local daemon (auto-started), `--vm` ⇒ the in-VM daemon. beadsd dispatches writes under the planner role/state so bd's policy allows them (it's the trusted single writer; per-caller authority is gated at the `prx beads` invocation layer). This gives humans and agents a working write path that targets the one canonical beads instead of a worktree's broken local `.beads`.
- 63ff3b5: Add `beadsd/writes.ts` — daemon-routed `createBeadViaDaemon` / `updateBeadViaDaemon` / `closeBeadViaDaemon`, the write twins of `beadsd/reads.ts` (GH-296 wave 2). These are the single-source replacements that internal `execBd` write call sites migrate onto, so host writes go to the one beads the daemon owns. A non-ok daemon verdict throws; the echoed bd record is parsed with the same transform the readers use.
- 26686e6: Extend the beadsd write contract with the fields the internal write call sites need (GH-296 wave 2 parity): `create` gains `externalRef` (`--external-ref`) + `silent` (`--silent`); `update` gains `issueType` (`--type`). Wired through the daemon `beadsArgs` dispatch and the `createBeadViaDaemon`/`updateBeadViaDaemon` helpers. Unblocks flipping `promote` / `intake-mirror` (create with an external ref) and `drift-fix` (update the type axis) onto the daemon.
- 4f75d13: `prx handoff` verbs (enqueue/status/drain/replay) gain an optional `deps` seam
  (store / drain / audit-row) defaulting to the real bd/CAS/audit
  implementations, so the verbs are unit-testable without a live bd substrate.
  Existing call sites pass nothing and are unaffected.
- d084274: The markdown-coverage guard now excludes any `CHANGELOG.md` (changesets-managed per-package release logs) generically, instead of only `packages/prx/CHANGELOG.md`. A release had added `packages/bd|gh|git/CHANGELOG.md`, which the guard flagged as uncatalogued and turned `ci` red on every PR.
- 91fb365: GH-411 slice 1: introduce a deployment-neutral operator-config root resolver
  (`operatorConfigRoot()` in `operator-config.ts`) and route the overlay-path
  resolution (`pr-state/github.ts`) and the wt-hook override resolution
  (`tools/run_hook.ts`) through it. New env names — `PRX_OPERATOR_CONFIG_ROOT`
  (runtime) and `BAKED_OPERATOR_CONFIG_ROOT` / `__PRX_BUILD_OPERATOR_CONFIG_ROOT__`
  (baked) — take precedence, with the old `PRX_AI_HOME_ROOT` / `BAKED_AI_HOME_ROOT`
  / `PRX_COMPILE_AI_HOME_ROOT` kept as deprecated aliases for one release so the
  nix wrapper and existing binaries keep working unchanged. First step toward
  running prx standalone without the hardcoded `ai-home` deployment repo.
- 2d66c67: GH-411 slice 2: rename the internal overlay identifiers off `ai-home` now that
  the resolver indirection (slice 1) is in place. `resolveAiHomeOverlayPath` →
  `resolveOperatorOverlayPath` (`pr-state/github.ts`), and the `aiHomeRoot`
  option field / locals → `overlayRoot` (`tools/run_hook.ts`,
  `tools/ensure_claude_settings.ts`). Pure internal rename — no behavior, env, or
  public-API change. Repo-identity literals (`bdelanghe/ai-home`) are slice 4.
- 51696b4: `prx provenance setup` (GH-352): promotes the signing-setup step into a first-class command — derive each actor's public key from the resolved master, publish the trust map, verify drift is clean, and report the resulting posture (idempotent; exits non-zero if drift remains). `setup-provenance-signing` is now a thin wrapper that adds a master file-perms preflight and delegates to it; the `prx provenance status` onboarding text and `docs/provenance/signing.md` point at the command.
- 75525e0: Hardened provenance signing setup (GH-352): `scripts/setup-provenance-signing` (one-command `keymaker register` + drift check + posture report), a `programs.prx.provenance` home-manager option (declaratively wires `PRX_PROVENANCE_MASTER_FILE` / per-actor `PRX_PROVENANCE_KEY` / `PRX_REQUIRE_SIGNED_DERIVATIONS`), and `docs/provenance/signing.md` (the operator-master runbook — sops/agenix → per-actor keys → committable trust map → fail-closed enforcement).
- 038c325: `prx provenance status` (GH-352): reports the signing posture — production / bootstrap / drifted / unconfigured — from the master source, per-actor mode, trust-map actor count + drift, and enforcement, and when it's not the production configuration bubbles up the exact onboarding next-steps. So a missing or stale signing setup is discoverable from inside prx, not just the docs. The `prx ci` fail-closed message now points at it.
- 10d9010: refactor: remove the `prx tmux reconcile` verb and its config-drift wiring (slice 1 of removing tmux entirely). Drops the tmux `gc` component/driver and the tmux reconcile embedding in `prx home update`. The reconcile path only existed to converge a live tmux server against rendered home-manager config; with tmux on its way out (headless-first + session-host substrate) it has no replacement. Interactive sessions, the parity surface, and the `prx-mux` package are removed in later slices.
- e4110d3: `prx triage close` now reads and closes through beadsd (GH-296 wave 2) instead of local `execBd`: a targeted `showBeadViaDaemon(<id>)` lookup + `closeBeadViaDaemon`, so the close lands on the one canonical beads. First internal write call-site flipped onto the daemon write helpers; `runTriageClose` is now async.

## 0.7.2

### Patch Changes

- 537a118: `prx ci` is now fail-closed on signing (GH-352): local dev is the production surface, so wherever a provenance ledger is in scope (a reserved work-unit, or `PRX_CI_LEDGER` in CI) and no `PRX_PROVENANCE_KEY` is set, the run fails with a clear, actionable message (`set PRX_PROVENANCE_KEY=dev` for the zero-config local signer, or `ed25519:<b64>` for a shared/CI key) instead of silently skipping. Outside a signing context it is unchanged. `.github/workflows/ci.yml` sets `PRX_CI_LEDGER` only when the secret is present, so the `ci` job stays green until remote signing is switched on.
- df7cb2e: Additive testability seams + a dead-code dedupe, all behavior-preserving:

  - `@bounded-systems/gh` — `execGh` gains optional `deps.spawn` / `deps.budget`
    seams so the rate-limit authority boundary is testable without a live `gh`
    spawn or real GitHub budget state. Existing call sites pass nothing.
  - `@bounded-systems/bd` — removed the redundant static `BLOCKED_SUBCOMMANDS`
    check (the policy `isBlocked` gate already enforced the identical list);
    policy is now the single source of truth, pinned by a `blockedSubcommands`
    parity test.
  - `@bounded-systems/prx` — `execWorktrunk`, `runClaudePreflight`, and
    `runHookVerb`/`readStdin` gain optional injectable spawn/exec/stdin seams
    (default to the real implementations) so their subprocess/stdin boundaries
    are unit-testable.

## 0.7.1

### Patch Changes

- b5fa4b1: `prx beads provision` (and `prx lima provision-beads`) now `chmod 700` the `.beads` directory it creates, so bd no longer warns about insecure `0755` permissions on the provisioned canonical clone.
- edf2fbb: `prx snapshot` now surfaces the CI provenance verdict + freshness in `DomainStateV1.ci` via a cached layer (GH-352): `prx ci` writes the verdict to `.pr/local/ci-provenance.json` while the ledger is open, and `snapshot` reads it synchronously and recomputes freshness against HEAD (`fresh` while the cached commit is still HEAD, `stale` once it moves) — so the read stays synchronous and ledger-free.
- 92cc8db: Make the test suite hermetic against the operator's git signing config. Many tests
  `git commit` throwaway fixture repos that fell back to the operator's global
  `~/.config/git/config` — which, with an interactive signer (e.g. 1Password SSH),
  fails headless and broke `prx ci` (and so the pilot's local `checking` gate,
  GH-360). The bun-test preload now points git's global/system config at a hermetic
  file (identity set, signing off), isolating fixture commits from the operator setup.

## 0.7.0

### Minor Changes

- 6bb29a9: Add `prx observe <unit>` — a read-only reader over the audit NDJSON that surfaces a work unit's pilot telemetry timeline (leg heartbeats + seam start/done events). The operator-facing surface for the pilot's `TELEMETRY_*` stream; complements `tail`/`jq` and `PRX_AUDIT_STDOUT=1`. Supports `--limit N` for the most recent events.

### Patch Changes

- 22c949b: Add `prx beads provision --origin <owner/repo> [--cwd <path>]` — the host twin of `prx lima provision-beads`. It dolt-clones the canonical beads into the well-known `~/.local/state/prx/beads` (writing the server-mode `metadata.json` bd needs), so the local daemon serves one healthy beads from every worktree. With this provisioned, `resolveLocalBeadsCwd` auto-selects it and `prx beads ready|list|show` returns real data from any shell — no per-worktree `bd` and no `--vm`.
- 13530a9: `prx beads ready|list|show` is now the reachable beads surface from **any shell**: with no `--vm` it routes through the local daemon via `withBeadsClient` (auto-started), instead of requiring `--vm`/`PRX_BEADS_VM`. `--vm <name>` still targets an in-VM daemon explicitly. This gives interactive agents and humans a working beads path even where raw `bd` is unreachable in a worktree (`issue_prefix config is missing`). The `/prx` orchestrator command now points at `prx beads show` for this reason.
- d93f98f: Adds the local CI provenance projection (GH-352): a `ci` field on `DomainStateV1` (verdict + freshness), the `resolveCiProvenanceState` reader (merge-guard verdict for HEAD plus an `isStale` freshness check — does the recorded green still cover the current tree?), and a uniform `isStale` check in the merge-guard (`projectProvenanceAxis`) so a verified-but-stale derivation fails closed. `buildDomainState`/`prx snapshot` stay synchronous and ledger-free; the `ci` field defaults there pending an async-snapshot follow-up.
- d93f98f: `prx ci` accepts a `PRX_CI_LEDGER` override for the signing ledger, so it can sign in a bare CI checkout (where the workspace-resolved canonical ledger doesn't exist). `.github/workflows/ci.yml` uses it to sign each phase (gated on a `PRX_PROVENANCE_KEY` secret) and uploads the ledger as the chain's async mirror — so remote greens join the same signed chain as local ones. Fully no-op without the secret. (GH-352)
- cfc778f: The local beadsd auto-start now serves a **canonical** beads clone decoupled from the current worktree (GH-296), so `prx beads` returns the same healthy beads from any shell instead of whichever clone's (possibly broken) `.beads` is underfoot. `resolveLocalBeadsCwd` resolves it: `PRX_BEADS_CWD` (explicit override) → the well-known `~/.local/state/prx/beads` clone when present → `findRepoRoot()` (back-compat fallback).

## 0.6.0

### Minor Changes

- 3951ba9: Anchor pilot telemetry into the signed `prx.pilot/v1` summary as an `observed: { digest, count }` field — a hash chain over all seam + leg-heartbeat observations, committed to by the pilot's existing signature. Tamper-evident with zero extra signatures, and never a gate (health stays off the authority chain). Slice 4 of the local-CI-in-the-pipeline work.
- 8eb3397: Add `prx observe <unit>` — a read-only reader over the audit NDJSON that surfaces a work unit's pilot telemetry timeline (leg heartbeats + seam start/done events). The operator-facing surface for the pilot's `TELEMETRY_*` stream; complements `tail`/`jq` and `PRX_AUDIT_STDOUT=1`. Supports `--limit N` for the most recent events.

### Patch Changes

- c0cc075: `prx ci` now records a signed `ci/phase/v1` derivation for each phase that _passed_ even on a partial (failed) run — not only on a fully green run — so a failure still leaves verified, content-addressed evidence for the phases before it (absence of a phase's derivation ≡ that phase not verified). (GH-352)
- 5f21402: `prx ci` accepts a `PRX_CI_LEDGER` override for the signing ledger, so it can sign in a bare CI checkout (where the workspace-resolved canonical ledger doesn't exist). `.github/workflows/ci.yml` uses it to sign each phase (gated on a `PRX_PROVENANCE_KEY` secret) and uploads the ledger as the chain's async mirror — so remote greens join the same signed chain as local ones. Fully no-op without the secret. (GH-352)
- 2cd110c: `prx plan view` and `prx intake view` now read beads through the beadsd daemon (the "one true source", GH-296) via a **targeted** `show <id>` rather than loading the whole set and filtering in JS — a single-id view asks the daemon for that one record, which is both cheaper and keeps provenance to `(query → result)` instead of the entire DB.

  Also fixes a correctness bug in the daemon readers: the daemon returns raw `bd --json` (snake_case `external_ref`, `issue_type`, …), which was being cast straight to `BeadsRecord`. The snake→camel parse (`parseBeadsRecord` / `parseBeadsRecords`, extracted from `loadAllBeads`) is now applied host-side, so `externalRef` / `externalRefs` / `externalIssueNumber` are populated correctly.

- 1487a2b: Emit the pilot and fleet machines' own state transitions to the audit sink
  (`machine:"pilot"` / `machine:"fleet"`), via `makeAuditInspector`. The monitor
  already greps `machine:pilot`, so pilot retreats/loops are now observable —
  the unblocker for diagnosing the implement/test loop (GH-360).
- 2b2a7c6: `prx plan view` now reads beads through the beadsd daemon (the "one true source", GH-296 wave 1) instead of shelling out to a local `bd list --all`. The bd-record arm fails fast if beadsd is unreachable. Also fixes a latent TDZ in the `resolver ↔ intake-id` import cycle by making the `IntakeViewError` alias a live re-export.
- 3951ba9: Fix: `TELEMETRY_SEAM_OBSERVED` was emitted by the pilot's deterministic seams but never registered in `eventOwnerMap`, so `recordEvent` threw `unknown catalog event` and the best-effort sink wrapper silently swallowed it — seam telemetry never reached the audit log. Register it (owner `telemetry`) so the seam stream (intake/checks/ci/merge start/done) lands in the tailable audit NDJSON alongside the leg heartbeat, making a pilot run observable to operators.

## 0.5.0

### Minor Changes

- f0f6f1b: Anchor pilot telemetry into the signed `prx.pilot/v1` summary as an `observed: { digest, count }` field — a hash chain over all seam + leg-heartbeat observations, committed to by the pilot's existing signature. Tamper-evident with zero extra signatures, and never a gate (health stays off the authority chain). Slice 4 of the local-CI-in-the-pipeline work.

## 0.4.0

### Minor Changes

- cf7bc8e: beadsd — beads as a capability-isolated daemon (GH-228/GH-296)

  Run beads behind a daemon so the host (human + agents) queries one source instead
  of N drifting per-worktree dolt clones:

  - `prx lima up|down|daemons|status` — manage in-VM daemons (keeper + beads) over a
    daemon registry; `prx lima provision-beads <vm> --origin <owner/repo>` installs
    bd+dolt and clones the canonical beads into a Lima VM.
  - `prx beads serve` (in-VM read+write daemon: ready/list/show/create/update/close,
    single-writer under the bd policy gate) and `prx beads ready|list|show --vm`
    (host read-door over the Lima-SSH channel).
  - `prx beads doctor [--fix]` — diagnose / re-bootstrap an unhealthy beads clone.
  - Config-driven dolt-database namespace resolver (reverse-DNS is now a swappable
    policy, decoupled from the SQL-safety guard).

  Validated end-to-end against a real Lima VM (local + VM e2e tests).

## 0.3.2

### Patch Changes

- 84b4579: `plugin emit`: route the capability `PreToolUse` hook through a bundled resolver
  script (`bin/prx-policy-guard.sh`) instead of a bare `prx hook policy-guard`.

  The bare command is PATH-dependent: when Claude Code is launched from a GUI /
  Spotlight / launchd context (not a shell), the hook subprocess can inherit a
  minimal PATH without `~/.local/bin`, so `prx` resolves to "command not found"
  and the policy guard silently stops enforcing. The resolver finds `prx` by PATH
  first, then common install locations (`$XDG_BIN_HOME`/`~/.local/bin`, homebrew,
  `/usr/local/bin`, the nix system profile), mirroring the monitor's existing
  `${CLAUDE_PLUGIN_ROOT}` script pattern. Surfaced by dogfooding the emitted
  plugin against the v0.3.1 binary.

## 0.3.1

### Patch Changes

- Re-cut the v0.3.x binary release as **0.3.1**. The first v0.3.0 binary release
  shipped broken — only `prx-x86_64-linux` attached, because the release-binary
  matrix published the GitHub Release in parallel and the second job hit the
  immutable-release lock. The pipeline is fixed (build → artifacts → single
  draft-then-publish release job, #209), but immutable releases permanently
  reserve the `v0.3.0` tag name, so the corrected release ships as 0.3.1. No
  source changes from 0.3.0 — same binary, working release pipeline.

## 0.3.0

### Minor Changes

- 0a8a8bc: **Experimental: pilot/fleet pipeline orchestrator + spec-driven CLI surface.** A
  preview subsystem (tested; not yet wired as `prx` commands — the real run is
  behind `PRX_PILOT_REAL` and gated on the dolt actor). Ships as a tested
  subsystem behind the existing surfaces.

  - **feat(orchestrator):** `pilot` (Layer 1) drives one work unit — each role leg
    invokes a headless Claude subagent (no tmux, "claude over ssh") and signs an
    in-toto step link. The tail `awaiting_ci → ready_to_merge → sealing → merged`
    makes "CI is a HARD BLOCK" _structural_ — the only edge to merge runs through
    a settled-green gate. Termination is proven via a well-founded measure
    `[retreatBudget, distanceToMerged] ∈ ℕ²`. `fleet` (Layer 2) supervises many
    pilots, WIP-bounded, projecting a live board (the agents view) + a signed
    batch attestation.
  - **feat(provenance):** a signed in-toto tree — leg step → pilot summary
    (`prx.pilot/v1`) → fleet batch (`prx.fleet/v1`), real ed25519/DSSE via
    `resolveProvenanceSigner`; verifiable, tamper / wrong-key rejected.
  - **feat(cli-spec):** author a verb once as a Zod `VerbSpec`; project it to CLI
    / MCP / OpenAPI / Anthropic tools / a Claude Code plugin / `prx mcp serve`,
    with a namespaced router and an actor→tool permission projection — the basis
    for collapsing `cli.ts` to a thin router + pretty-printer.
  - **feat(invariant):** no prx agent launches without a signing key
    (`requireSigner`); the CLI is modeled as an actor that inherits identity from
    the controlling tty (`cliActor` → `human` / `noninteractive`,
    `requireCliSigner`).
  - **feat(real):** the `prx pilot` real path (`PRX_PILOT_REAL`) wires legs to
    `openSession` + a headless role agent + the Signer, and the tail to the real
    `prx scout ci` / `prx publisher merge` actors.

  Design: `docs/prx/pipeline-orchestrator.md`, `docs/prx/cli-from-spec.md`.

### Patch Changes

- 4d8d08e: Capability-poor orchestrator, beads-native pipeline, and the compiled-binary audit-DB fix.

  - **fix(audit):** embed `schema.sql` into the `bun --compile` binary — fixes the `ENOENT /$bunfs/root/schema.sql` that broke every audit-DB command (e.g. `prx services status --anthropic`) in the released binary (prx-eky).
  - **feat(submit):** beads-native submit / publish / merge — a beads work unit can travel intake → merged PR (no longer GitHub-issue-only).
  - **feat(agents):** capability-poor orchestrator — actor sub-agents generated from the policy table, a PreToolUse policy hook that denies any command a role doesn't own, orphan-effect provenance verification, and the intake⊗actor salt + ephemeral salted worktrees for per-actor isolation.
  - **feat(commands):** `/prx <unit>` — drive a work unit through the pipeline (plan → implement → submit → merged PR), capability-scoped and delegating to prx's actors.
  - **chore:** automatic GitHub-issue tracking (`intake --to gh` + `Closes #N`/postmerge); value-props + `STATUS.md`; capability ownership/approval `.feature` audit surfaces.

- e6882e0: dolt: add `createDoltDatabase` — an idempotent `CREATE DATABASE` primitive for the shared dolt sql-server (E0 of GH-1685). Probes `SHOW DATABASES` then creates the empty database when absent, reporting `created` / `exists` / `error`; re-validates the canonical reverse-DNS name before any SQL interpolation. Schema seeding (E1, `bd init --database`) and the `prx repo provision` verb (E4) compose it.
- 11d76cf: dolt: canonical `dolt_database` naming standardized on the live reverse-DNS form `io_github_<owner>_<repo>` (D0 of GH-1685). `RepoSlug` now validates that shape (exported as `DOLT_DATABASE_NAME_PATTERN`), and a new `canonicalDoltDatabase()` derives it from a GitHub origin. The legacy `{host}__{owner}__{repo}` form is no longer accepted.
- d6ee05a: deps: migrate to zod 4 (`^4.4.3`). Replaces the Zod-3-only `zod-to-json-schema` with Zod 4's built-in `z.toJSONSchema` behind a shared `toJsonSchemaArtifact` helper (preserving the `{ $ref, definitions }` artifact wrapper), switches `z.record(value)` call sites to the Zod-4 `z.record(key, value)` arity, uses `z.partialRecord` for enum-keyed counters, and updates config-drift issue introspection to Zod 4's `invalid_value`/`values` issue shape. Committed JSON-schema artifacts were regenerated (Zod 4 emits nullable unions as `anyOf` and bounds integers at `MAX_SAFE_INTEGER`); the contract artifacts also pick up roles that had drifted from source. prx-mt9.
