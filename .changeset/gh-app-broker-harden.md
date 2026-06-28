---
"@bounded-systems/prx": patch
---

Harden the GitHub App token broker: scrub the inline PEM from the env after read, and support least-privilege token attenuation.

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
