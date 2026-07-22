export const SYSTEM_ID = "SYSTEM";

export type IdGenerator = (timestamp: number) => string;

export function createUuidV7(timestamp: number = Date.now()): string {
  return Bun.randomUUIDv7("hex", timestamp);
}
