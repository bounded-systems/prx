---
"@bounded-systems/verbspec": minor
---

Add OpenRPC and JSON-RPC/NDJSON projections to `@bounded-systems/verbspec`.

A verb registry can now be projected to an OpenRPC document (`toOpenRpcMethod` / `toOpenRpcDocument` — the JSON-RPC analogue of the existing OpenAPI projection) and served over a line-delimited JSON-RPC 2.0 transport (`handleJsonRpc` / `dispatchNdjson`). This lets daemon-shaped libraries expose the same verbs they author once — params validated against the verb's Zod input, results derived from its output schema — with no drift between the protocol, its OpenRPC description, and the client types.
