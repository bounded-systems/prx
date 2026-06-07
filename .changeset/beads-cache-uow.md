---
"@bounded-systems/prx": patch
---

`createBeadsCache` is now UoW-coherent and generation-aware (GH-296, prx-ebk): `upsert(record)` patches one record by id (write-through) and `remove(id)` drops one — so a write no longer busts the whole cache. With an optional `generation` source (the daemon's dolt HEAD etag), `load()` re-fetches only when the dataset moved, so a stable HEAD serves cached data. Existing `load()`/`invalidate()` callers are unchanged.
