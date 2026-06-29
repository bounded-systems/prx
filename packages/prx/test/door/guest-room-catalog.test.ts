// A1: prx describes its keeper door through the guest-room capability model.
import { describe, expect, test } from "bun:test";

import {
  forgeDoorGrant,
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

describe("prx forge door via the guest-room model", () => {
  test("the catalog defines the forge door against PRX_FORGE_DOOR", () => {
    expect(prxDoorCatalog.forge).toBeDefined();
    expect(prxDoorCatalog.forge!.env).toBe("PRX_FORGE_DOOR");
  });

  test("resolveDoor maps the forge preset into a concrete grant", () => {
    const grant = forgeDoorGrant({ PRX_FORGE_DOOR: "/run/prx/doors/forge-d.sock" });
    expect(grant.name).toBe("forge");
    expect(grant.env).toBe("PRX_FORGE_DOOR");
    expect(grant.grants).toContain("GitHub App installation tokens");
  });

  test("the rulebook denies forge when only keeper is granted", () => {
    const book = renderPrxRulebook("prx", ["keeper"], { KEEPERD_SOCK: "/x.sock" });
    expect(book).toContain("DENIED");
    expect(book).toContain("forge");
  });
});
