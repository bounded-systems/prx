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
    expect(prxDoorCatalog.keeper!.env).toBe("KEEPERD_SOCK");
  });

  test("resolveDoor maps the preset into a concrete grant", () => {
    const grant = keeperDoorGrant({ KEEPERD_SOCK: "/run/prx/doors/keeperd.sock" });
    expect(grant.name).toBe("keeper");
    expect(grant.env).toBe("KEEPERD_SOCK");
    expect(grant.grants).toContain("signed git writes");
  });

  test("the rulebook is honest — a card for keeper, and a DENIED section", () => {
    const book = renderPrxRulebook("prx", ["keeper"], { KEEPERD_SOCK: "/x.sock" });
    expect(book).toContain("keeper: signed git writes");
    expect(book).toContain("DENIED");
  });
});
