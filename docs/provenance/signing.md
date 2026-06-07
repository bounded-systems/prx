# Provenance signing — setup

prx deployed in a dev environment **is** production for prx. So signing is not a
dev convenience you bolt on later — it is the identity layer that makes every
privileged effect attributable to the actor that produced it, verifiable against
a pinned key, fail-closed. This is the setup runbook for the hardened,
operator-master configuration.

## The model

| Thing | What | Where |
| --- | --- | --- |
| **master** | a 32-byte secret; per-actor signing keys derive from it | an agenix/sops-decrypted file (mode `0600`), pointed at by `PRX_PROVENANCE_MASTER_FILE`. **Never** in config, the nix store, or env (env carries only the path). |
| **per-actor keys** | each actor (`plan`, `implement`, `submit`, …) signs with its own key derived from the master — attributable | derived at runtime; never persisted. `PRX_PROVENANCE_KEY=dev` selects per-actor mode. |
| **trust map** | actor → **public** key; what verification pins | `~/.config/prx/config.json` `provenance.trust` — declarative, safe to commit. Written by `prx keymaker register`. |
| **enforcement** | reject unsigned/untrusted derivations, fail-closed | `PRX_REQUIRE_SIGNED_DERIVATIONS=1`, read by the merge-guard / publisher tier. |

Public keys verify; they don't sign. The master signs; it never leaves the
secret file. (`packages/prx/src/provenance/config.ts`, `signer.ts`, `keymaker.ts`.)

## Setup

### 1. Mint a master

```bash
head -c 32 /dev/urandom | base64      # the 32-byte master, base64 — this is the secret
```

### 2. Encrypt it as a deployment secret

Pick your secret manager; both decrypt to a runtime file at switch time.

```nix
# agenix
age.secrets.prx-provenance-master.file = ./secrets/prx-provenance-master.age;
# → /run/agenix/prx-provenance-master  (mode 0600)
```

```yaml
# sops-nix
sops.secrets.prx-provenance-master = { };
# → /run/secrets/prx-provenance-master  (mode 0600)
```

### 3. Wire it declaratively (home-manager)

The `programs.prx.provenance` block exports the env (path-only — never the
secret) into the prx launcher:

```nix
programs.prx = {
  enable = true;
  provenance = {
    enable = true;
    masterFile = "/run/agenix/prx-provenance-master";  # the decrypted secret
    requireSigned = true;                              # fail-closed (default)
  };
};
```

That sets `PRX_PROVENANCE_MASTER_FILE`, `PRX_PROVENANCE_KEY=dev` (per-actor), and
`PRX_REQUIRE_SIGNED_DERIVATIONS=1`. Without home-manager, export those three
yourself.

### 4. Publish the trust map + verify

The declarative wiring can't derive keys; one command does that imperative step
— register the per-actor trust map, verify drift, report the posture:

```bash
prx provenance setup
```

```
prx provenance setup:
  trust map:   7 actor(s) → ~/.config/prx/config.json
  registered:  author, implement, intake, plan, scratch, submit, triage
  verify:      drift clean

provenance signing: production
  production — operator master, per-actor trust map, fail-closed verification.
  mode:        per-actor
  master:      operator-file
  trust map:   7 actor(s)
  enforcement: on (fail-closed)
```

It derives each actor's **public** key from the master, writes
`provenance.trust`, and confirms drift is clean (the published map matches the
master's derived keys). **Commit the trust map** (`~/.config/prx/config.json`
`provenance.trust`) — it's public and is the verification anchor.
(`packages/prx/scripts/setup-provenance-signing` wraps this with a file-perms
preflight on the master.)

## The loop, verified

With signing on, a green `prx ci` in a work-unit signs a `ci/phase/v1` per phase,
and a `scout read` signs a `scout/read/v1` — each attributed to the acting actor
via its `builder.id`, verified against the trust map. Under enforcement, an
unsigned or wrongly-keyed derivation is **rejected** at the merge gate, not
trusted. (See `docs/prx/ci-as-derivation.md`.)

## Rotation

Rotate the master (re-encrypt, redeploy), then re-run `prx provenance setup`. It
republishes the changed actor keys (and `prx provenance status` will show the
`drifted` posture beforehand if you check); commit the updated trust map. Old
signatures no longer verify, which is the point of a rotation.

## Bootstrap / dev fallback

With **no** `PRX_PROVENANCE_MASTER_FILE`, `PRX_PROVENANCE_KEY=dev` falls back to a
**zero-config persisted dev master** (`<state>/prx/provenance/dev-ed25519.json`,
generated on first use, atomic write + `chmod 0600`, self-verifying). It still
signs and verifies a full loop locally — handy for bootstrap — but it is
per-machine and not the shared operator identity. Configure the master for the
real deployment.

## Don'ts

- **Never commit the master** or the decrypted file. Gitignore its path; it lives
  only in your secret manager + the `0600` runtime file.
- Don't put the master in `PRX_PROVENANCE_KEY` or any committed config — the env
  carries the *path* (`PRX_PROVENANCE_MASTER_FILE`), never the bytes.
- Don't disable `requireSigned` outside debugging — fail-closed is the posture.

## Env reference

| Var | Meaning |
| --- | --- |
| `PRX_PROVENANCE_MASTER_FILE` | path to the decrypted base64 master (the deployment secret) |
| `PRX_PROVENANCE_KEY=dev` | per-actor signing mode (keys derive from the resolved master) |
| `PRX_REQUIRE_SIGNED_DERIVATIONS=1` | fail-closed verification at the merge-guard / publisher tier |
| `PRX_PROVENANCE_PER_ACTOR=off` | escape hatch: single-key instead of per-actor (debug only) |
