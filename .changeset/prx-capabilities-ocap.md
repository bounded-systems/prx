---
"@bounded-systems/prx": minor
---

Add `prx capabilities` (aliases `caps` / `can`): an OCAP self-report surface. An agent launched in a sealed box (claude-box) otherwise assumes it can run any verb and discovers the capability boundary one opaque failure at a time. This command is zero-dependency by design — it works in a bare box where git / bd / gh / repos are all absent — and reports what the box CAN do, what it CANNOT, and, for each missing capability, how to enable it. The room tells the man how to translate.
