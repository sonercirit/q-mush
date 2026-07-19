import { expect, test } from "bun:test";
import { createUuidV7 } from "../ids.ts";

const NOW = 1_700_000_000_000;

test("creates monotonic UUIDv7 identifiers for a supplied timestamp", () => {
  const firstId = createUuidV7(NOW);
  const secondId = createUuidV7(NOW);

  expect(firstId).toMatch(
    /^018bcfe5-6800-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
  );
  expect(secondId).toMatch(
    /^018bcfe5-6800-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
  );
  expect(firstId < secondId).toBeTrue();
});
