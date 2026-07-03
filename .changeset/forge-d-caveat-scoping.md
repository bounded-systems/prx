---
"@bounded-systems/prx": minor
---

`forge-d`'s TCP grant gate now enforces caveat-based scoping on GitHub App
installation-token leases, closing a gap where any caller with a valid
`forge`-door grant (right signature, audience, expiry) could request an
installation token for **any** repositories/permissions the App installation
holds — the base gate only verified who could ask, not what they could ask
for.

- `mintDoorGrant` (`src/door/grant-issuer.ts`) accepts an optional
  `caveats?: readonly string[]`, threaded into the signed grant like any other
  authority-bearing field.
- New `src/forge-d/caveats.ts` adds two caveat verifiers, each owning its own
  comma-separated OR-set grammar (per guest-room's `checkCaveats`
  convention): `repos=<owner/repo>,...` and `perms=<key>:<value>,...`. A
  request must satisfy every caveat on the presented grant; omitting the
  narrowed field entirely (asking for the installation's full scope) is
  denied, not treated as "nothing requested."
- `runForgeDServe` wraps its base `RequestAuthorizer` with
  `withForgeCaveats`, so caveats are checked immediately after
  signature/audience/expiry and before the lease ever reaches
  `mintInstallationToken`.
- Grants with no caveats are unattenuated (unchanged, full installation
  scope) — this is purely additive.
