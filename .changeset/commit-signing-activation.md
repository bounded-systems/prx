---
---

prx-e7cl: activate prx's internal commit-signing key on the direct keeper path,
and add `prx provenance commit-pubkey`. `KeeperGitDeps.signingKeyPath` lets a
caller resolve a signing key that `runKeeperCommitTree` injects as
`PRX_COMMIT_SIGNING_KEY` onto the child git env (never the ambient environment);
`submit/publish.ts` wires it to prx's own internal key so the materialized commit
is signed at creation, while the keyless remote path (`keeperd/host.ts`, signed
in-VM) is unchanged. The new verb prints prx's commit-signing public key
(generate-on-first-use) for one-time GitHub registration. No release.
