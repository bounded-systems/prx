---
---

Step 4 of the SDK-leverage convergence: prx's SLSA adapter now imports the
canonical predicate identifiers (`IN_TOTO_STATEMENT_TYPE`,
`SLSA_PROVENANCE_V1`) from the published `@bounded-systems/ocap-provenance`
contract instead of redefining them locally, so prx's emitted in-toto Statement
type can never drift from the contract. Values are identical; prx's git-specific
SLSA builder types/functions are unchanged. No API or behavior change, no release.
