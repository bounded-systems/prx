# Spike — the git-gateway permission intersection model (prx-0wsf round 5)

> **Type:** code spike / POC &nbsp;·&nbsp; **Bead:** `prx-0wsf` (epic; round 5 notes)

PR [#969](https://github.com/bounded-systems/prx/pull/969) shipped forge-d's
`repos=`/`perms=` caveats — real scoping of *what* an already-authenticated
caller may lease. This spike proves out the next layer: a full git HTTP
gateway's authority is never any **one** check, it's the **intersection** of
five independent layers, each of which can only narrow, never widen:

```
gateway JWT capability
    ∩ gateway server policy           (an org-wide floor — e.g. "no force ever")
    ∩ GitHub App installation scope   (the ceiling forge-d's App actually has)
    ∩ minted installation-token scope (what forge-d actually asked GitHub for)
    ∩ GitHub repository rules         (rulesets — the FINAL authority)
```

The canonical example from the design discussion this spike is modeled on:

```
JWT:          write repository 67890
GitHub token: contents:write for repository 67890
ruleset:      cannot directly update main
effective:    may push allowed feature refs, may not push main
```

## Run

```sh
bun docs/spikes/git-gateway-permission-intersection/poc.ts
```

**Setup note:** same pre-existing workspace gap as
[`docs/spikes/signed-ref-snapshot/`](../signed-ref-snapshot/) — this spike has
no external dependencies (no anchored-chain/guest-room imports), so it runs
standalone without the `node_modules` symlink workaround that spike needs.

## Output

```
── git-gateway permission intersection (prx-0wsf round 5) ──────────
jwt: repo=67890 git=[read,write] refs.update=refs/heads/users/bobby/*
installation.contents=write  mintedToken.contents=write
rules.protectedRefPatterns=refs/heads/main

happy.feature-push           ALLOW  write update refs/heads/users/bobby/feature
deny.jwt-read-only           DENY   write update refs/heads/users/bobby/feature  [gateway JWT] JWT does not grant git:write
deny.jwt-ref-pattern         DENY   write update refs/heads/someone-else/feature  [gateway JWT] JWT does not permit update on refs/heads/someone-else/feature
deny.policy-no-force         DENY   write force refs/heads/users/bobby/feature  [gateway policy] force pushes are disabled gateway-wide
deny.installation-ceiling    DENY   write update refs/heads/users/bobby/feature  [installation scope] installation holds contents:read, need contents:write
deny.token-exceeds-ceiling   DENY   read update refs/heads/users/bobby/feature  [minted token] minted token exceeds the installation's own ceiling — minting bug, fail closed
deny.ruleset-protects-main   DENY   write update refs/heads/main  [repository rules] ruleset protects refs/heads/main — direct push not allowed
happy.read                   ALLOW  read update refs/heads/main
```

## What it shows

1. **Five layers, five independent denials.** Each scenario is engineered so
   exactly one layer fails while every other layer would have allowed it —
   proving each layer actually does independent work, not that one dominant
   check happens to catch everything.
2. **Fail fast, fail closed, first-denial-wins.** Mirrors guest-room's
   `checkCaveats` convention (already shipped in forge-d, PR #969): layers run
   in order, the first denial is reported, and no later layer is ever
   consulted to widen an earlier layer's refusal.
3. **Defense in depth, not just a ceiling check.** The minted-token layer
   checks *two* directions — is it enough for what's needed, AND does it
   exceed the installation's own ceiling. A minting bug that hands back a
   token broader than the installation actually has is caught here
   independently of the installation-scope check, not silently trusted
   because "the ceiling layer already ran."
4. **Rulesets are the final word, deliberately not reimplemented.** The
   gateway model never tries to parse "no direct push to main" itself — it
   defers entirely to GitHub's own ruleset enforcement as the last layer, per
   the design note: *"Do not give the Git proxy GitHub Administration
   permission... rulesets should remain the final authority."*

## Caveats / next steps

- The `refs={update,create,delete,force}` glob-pattern JWT scoping prototyped
  here does **not** exist on forge-d's real wire contract
  (`src/forge-d/contract.ts`) yet — forge-d has no visibility into which refs
  a push touches (that requires an actual git-aware gateway parsing
  receive-pack, which doesn't exist). This spike's `GatewayJwt.refs` and the
  `globMatches` grammar are the prototype for a future `refs=<glob>,...`
  caveat alongside forge-d's existing `repos=`/`perms=` ones.
- No real GitHub call, no real signing — every layer is an in-memory stub.
  Real integration means: the JWT layer becomes an actual signed grant
  (reusing `mintDoorGrant`'s `caveats`), the installation-scope/minted-token
  layers become real `mintInstallationToken` responses, and the
  repository-rules layer becomes an actual GitHub rulesets API check (or is
  simply *not* pre-checked at all, relying on GitHub to reject the push and
  surfacing that as the gateway's own denial).
- Lives under `docs/spikes/` so it is outside the build/test globs; it is a
  demo, not shipped code.
