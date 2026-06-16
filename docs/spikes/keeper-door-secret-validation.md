# Spike — validate the keeper door: host-backed secret + live push (prx-b44y)

A throwaway, local validation of the prx-asr keeper path: does a **host-backed
podman secret** deliver the signing key to keeperd-box, and does the **keeper
door** (#634) push end to end? No GitHub, no real key — a throwaway ed25519 key,
a podman secret, and a local bare repo as the "remote".

## What was validated

### ✅ A. Host-backed podman secret → keeperd reads the key + serves (prx-b44y)

```sh
KEY="ed25519:$(bun -e '…raw 32-byte ed25519 seed, base64…')"     # throwaway
printf '%s' "$KEY" | podman secret create prx-keeper-key -        # encrypted at rest (driver=file)
podman run -d --secret prx-keeper-key,target=/run/secrets/keeper-key \
  -v "$DOORS":/run/prx/doors localhost/keeperd-box:0.9.0 \
  keeper serve --socket /run/prx/doors/keeperd.sock
# → "keeperd: listening on /run/prx/doors/keeperd.sock"
```

The keeperd-box entrypoint reads `/run/secrets/keeper-key` into
`PRX_PROVENANCE_KEY` and serves. **The prx-b44y mechanism works**: the key comes
from a host-backed, at-rest-encrypted store (not a plaintext file, not the
manifest), injected to a tmpfs path — and never touches an image layer, a git
file, or a registry. The key format is `ed25519:<base64 of the raw 32-byte
seed>` (`anchored-chain/src/signing.ts` `importEd25519PrivateKey`).

### ✅ D. LIVE sibling-container e2e: keeperd imports + signs + pushes over the door (prx-b44y)

The full path finding C left deferred — a door client **co-located in the pod**
driving keeperd to a real signed push — now runs end to end. No GitHub: a local
**bare repo** is the "remote", a throwaway ed25519 key the signer.

```sh
ROOT=$(mktemp -d)                                 # /var/folders (VM-mounted), NOT /tmp
git init -q --bare "$ROOT/bare.git"
git -C "$ROOT/bare.git" symbolic-ref HEAD refs/heads/main   # bare defaults to master
# … seed one commit C0 on main, then:
git clone -q "$ROOT/bare.git" "$ROOT/keeper-work"           # keeperd's clone …
git -C "$ROOT/keeper-work" remote set-url origin /remote.git #  … origin → in-box path

# the keyless committer (model A) builds C1 on top of C0 and bundles (C0, branch]:
#   tree=write-tree; C1=commit-tree $tree -p $C0; branch test-branch -> C1
#   git bundle create range.bundle "$C0..test-branch"

printf 'ed25519:%s' "$SEED" | podman secret create prx-keeper-key -   # host-backed
podman run -d --name e2e-keeperd \
  --secret prx-keeper-key,target=/run/secrets/keeper-key \
  -v "$ROOT/doors:/run/prx/doors" \
  -v "$ROOT/keeper-work:/work" \
  -v "$ROOT/bare.git:/remote.git" -w /work \
  localhost/keeperd-box:0.9.0          # entrypoint → prx keeper serve … keeperd.sock

# drive the door from a SIBLING container holding NO git authority — just socat:
podman run --rm -v "$ROOT/doors:/run/prx/doors" -v "$ROOT:/host" alpine \
  sh -c 'apk add -q socat && socat -T3 - UNIX-CONNECT:/run/prx/doors/keeperd.sock \
           < /host/req.frame > /host/resp.frame'
#   req.frame = <uint32-BE len><json>  (door/framing.ts), built on the host:
#   {"kind":"import-and-push","bundleBase64":…,"commitSha":"<C1>",
#    "branch":"test-branch","remote":"origin","ledgerRef":"/work/ledger.sqlite"}
```

**Results (all PASS):**

- **Push landed.** `git -C "$ROOT/bare.git" rev-parse refs/heads/test-branch`
  equals the host-built `C1` — keeperd imported the bundle into its clone and
  pushed the branch to the bare "remote" through the door. The sibling container
  never held git authority; it only spoke the socket.
- **Push was signed in the box.** With `PRX_PROVENANCE_KEY` resolved from the
  host secret, the request's `ledgerRef` made the daemon emit a SLSA `push/v1`
  derivation into `/work/ledger.sqlite` (an anchored-chain-sqlite ledger):
  `producer prx://claude-code/keeper`, subject `gitCommit:<C1>`, predicate
  `https://slsa.dev/provenance/v1`, buildType `https://prx.dev/git/push`.
- **Signature verifies against the throwaway *pubkey*.** `verifySlsaDerivation`
  with `ed25519Verifier(importEd25519PublicKey(<pub>))` returns `true`; a wrong
  key returns `false` (negative control). The host verifies with the public half
  only — it never held the signing key.

So the prx-b44y runtime split is validated all the way through: a host-backed
secret delivers the key → keeperd-box exposes its door on the shared fabric → a
sibling container ships a keyless host-built bundle → keeperd performs the *only*
sensitive step (signed push) and a third party verifies the signature.

> **One gap, expected.** The loaded box is prx **v0.9.0**, which predates #644
> (prx-a36l): the daemon writes the signed `push/v1` to the **ledger** but does
> not yet RETURN it in the response (`status:ok` carried only `commitSha` +
> `pushedRef`, `signedDerivation` was absent — exactly finding B). #634's box-mode
> `requireSigned` gate reads `resp.signedDerivation`, so **that gate needs a
> keeperd-box rebuilt from a release ≥ #644**. The signing itself already works
> in v0.9.0 — only the return wiring is missing from the released binary.

> **Door client, in practice.** There is no standalone door-push CLI verb, and
> the box wraps the *released* prx binary (`nix/oci/prx-fhs.nix`), so a new
> `prx keeper door-push` verb cannot be exercised in the box without a release +
> image rebuild. For the live run the door was driven with a **host-built frame +
> `socat` sibling** — a faithful, dependency-free stand-in for the claude-room
> consumer (model A: the keyless committer builds the bundle; the box only relays
> it over the door reference it holds). Once a release carries the door-push path,
> re-run this against the box's own `/bin/prx` to retire the socat shim.

## What the spike found (two real things)

### 🔧 B. The keeperd daemon does not RETURN `signedDerivation` → #634's door + requireSigned is a no-op (prx-a36l)

`keeperd/daemon.ts` `handleKeeperRequest` returns `{ status, commitSha,
pushedRef }` — it writes the signed `push/v1` to the **ledger** (the `ledgerRef`
→ `openLedger` → `attest` path) but never returns it. #634 wired
`runSubmitPublish`'s door path to read `resp.signedDerivation` for the GH-2249
`requireSigned` gate, so today that field is **always undefined** → in box mode
with `requireSigned`, publish fails closed ("emitted no signed derivation").
Safe (never opens an unsigned PR) but it means the box can never *satisfy*
requireSigned over the door. **Fix** (filed prx-a36l): the daemon should capture
the appended derivation (decorate the ledger `store.append`, as `publish.ts`
does for the local path) and return it as `signedDerivation`.

### 🏛 C. The door is pod-local by construction — a host-driven e2e is impossible

Driving `runKeeperDoorPush` from the **macOS host** (with
`PRX_KEEPER_SOCKET=$DOORS/keeperd.sock`) fails with `ECONNREFUSED`. The socket
**file** mirrors to the host via virtiofs, but a **unix socket can't be dialed
across the podman-machine VM boundary** — the listening socket lives in the VM's
kernel. This is not a bug; it *confirms the intended architecture*: the door
client (claude-box) and keeperd are **sibling containers in the same pod**,
sharing the `/run/prx/doors` tmpfs and one kernel. A full live import+push
validation therefore needs the client **co-located in the pod**, not on the host
— a sibling-container harness. **Now done — see finding D**: a sibling container
sharing `/run/prx/doors` drove keeperd to a real signed push, confirming the
host-can't-dial boundary is the *only* boundary (the in-kernel sibling reaches
the door unchanged).

## Harness gotchas (for the next runner)

- **podman-machine mounts `$HOME`/`/var/folders`, not `/tmp`** — put bind-mount
  dirs under a default `mktemp -d` (→ `/var/folders`), never `/tmp/...`, or the
  mount fails `statfs … no such file`.
- A bare repo defaults `HEAD` to `master`; pin it (`git symbolic-ref HEAD
  refs/heads/main`) or clones come up empty.
- keeperd-box is a minimal image — no `grep`; pipe `/proc/1/environ` out and
  filter on the host.

## Outcome

prx-b44y is **validated end to end**: the host-backed secret delivers the key
(A), the runtime split (secret-holding daemons via `podman --secret`, agent via
kube-play) holds, and a **sibling container drives keeperd to a real, verifiable
signed push over the door** (D) — the live import+push e2e finding C left open.

One follow-up remains on the *release* path, not the mechanism: prx-a36l (#644,
merged to `main`) makes the daemon RETURN `signedDerivation` so #634's box-mode
`requireSigned` gate can verify it — but the in-pod box must be **rebuilt from a
release ≥ #644** (the loaded v0.9.0 box signs into the ledger but doesn't return
the derivation). The production runtime form (a systemd podman **quadlet** with
`Secret=`, borrowing claude-box's doors hardening) lands alongside this.
