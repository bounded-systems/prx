---
---

Remove the now-dead bespoke keeper door-client factory: after Phase C the live
keeper door push consumes door-kit, leaving `keeperd/client-factory.ts`
(`withKeeperClient`) and `keeperd/protocol-transport.ts` (`guestRoomKeeperTransport`)
with no live callers. Deleted both + their tests. `IsolatedKeeperClient`
(`client.ts`) and `isKeeperDoorMode`/`resolveKeeperEndpoint` (`endpoint.ts`) stay —
still used by session-host/lima and the publish gate. No API or behavior change,
no release.
