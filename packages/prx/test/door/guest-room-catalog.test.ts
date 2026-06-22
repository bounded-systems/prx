// A1: prx describes its keeper door through the guest-room capability model.
import { describe, expect, test } from "bun:test";

import {
  keeperDoorGrant,
  prxDoorCatalog,
  renderPrxRulebook,
} from "../../src/door/guest-room-catalog.ts";

describe("prx keeper door via the guest-room model", () => {
  test("the catalog defines the keeper door against the keeperd endpoint env", () => {
    expect(prxDoorCatalog.keeper).toBeDefined();
    expect(prxDoorCatalog.keeper!.env).toBe("PRX_KEEPER_SOCKET");
  });

  test("resolveDoor maps the preset into a concrete grant", () => {
    const grant = keeperDoorGrant({ PRX_KEEPER_SOCKET: "/run/prx/doors/keeperd.sock" });
    expect(grant.name).toBe("keeper");
    expect(grant.env).toBe("PRX_KEEPER_SOCKET");
    expect(grant.grants).toContain("signed git writes");
  });

  test("the rulebook is honest — a card for keeper, and a DENIED section", () => {
    const book = renderPrxRulebook("prx", ["keeper"], { PRX_KEEPER_SOCKET: "/x.sock" });
    expect(book).toContain("keeper: signed git writes");
    expect(book).toContain("DENIED");
  });
});
