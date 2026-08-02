import { describe, expect, test } from "vitest";
import { CredentialPoolBalancer } from "../credential-pool-balancer.ts";

const MEMBERS = [{ id: "first" }, { id: "second" }] as const;

function memberIds(balancer: CredentialPoolBalancer): readonly string[] {
  return balancer.ordered("pool", MEMBERS).map(({ id }) => id);
}

describe("credential pool balancer", () => {
  test("selects members in deterministic round-robin order", () => {
    const balancer = new CredentialPoolBalancer();

    expect(
      Array.from({ length: 4 }, () => balancer.ordered("pool", MEMBERS)[0]?.id),
    ).toEqual(["first", "second", "first", "second"]);
    expect(balancer.ordered("another-pool", MEMBERS)[0]?.id).toBe("first");
  });

  test("skips a cooled-down member until its cooldown expires", () => {
    let now = 1_000;
    const balancer = new CredentialPoolBalancer({
      cooldownMilliseconds: 30_000,
      now: () => now,
    });

    balancer.coolDown("pool", "first");
    expect(memberIds(balancer)).toEqual(["second"]);

    now += 30_000;
    expect(memberIds(balancer)).toEqual(["second", "first"]);
  });
});
