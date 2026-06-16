---
"@bounded-systems/prx": patch
---

keeperd now **returns** the signed `push/v1` derivation in its ok response (prx-a36l). The daemon previously wrote the signed derivation only to the ledger, so `KeeperRemoteResponse.signedDerivation` was always absent — which made #634's door + `requireSigned` publish path a no-op (it could never satisfy the GH-2249 gate, failing closed). `handleKeeperRequest` now captures the derivation the attesting push appends (decorating the ledger's `append`, no `attest` change) and returns it; a bare push (no `ledgerRef`/signer) returns no `signedDerivation`. Tested at the handler and over the real socket (it survives the encode→decode round-trip). Found by the keeper-door spike (prx-b44y).
