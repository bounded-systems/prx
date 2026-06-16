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
— a sibling-container harness, deferred.

## Harness gotchas (for the next runner)

- **podman-machine mounts `$HOME`/`/var/folders`, not `/tmp`** — put bind-mount
  dirs under a default `mktemp -d` (→ `/var/folders`), never `/tmp/...`, or the
  mount fails `statfs … no such file`.
- A bare repo defaults `HEAD` to `master`; pin it (`git symbolic-ref HEAD
  refs/heads/main`) or clones come up empty.
- keeperd-box is a minimal image — no `grep`; pipe `/proc/1/environ` out and
  filter on the host.

## Outcome

prx-b44y's secret mechanism is **validated**; the runtime split (secret-holding
daemons via `podman --secret`, agent via kube-play) holds. Two follow-ups:
prx-a36l (return `signedDerivation`) unblocks signed publish over the door, and
the live import+push e2e needs a sibling-container client harness (the
host-driven shortcut is impossible by design — finding C).
