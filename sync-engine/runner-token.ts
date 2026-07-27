import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const LEGACY_DIGEST_BYTES = 32;
const STORED_HASH_PREFIX = "scrypt";
const STORED_HASH_SEPARATOR = ".";
const STORED_KEY_BYTES = 32;
const STORED_SALT_BYTES = 16;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function createTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function createStoredTokenHash(token: string): string {
  const salt = randomBytes(STORED_SALT_BYTES);
  const hash = scryptSync(token, salt, STORED_KEY_BYTES);
  return [
    STORED_HASH_PREFIX,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join(STORED_HASH_SEPARATOR);
}

function currentHashMatches(tokenHash: string, token: string): boolean {
  const [prefix, encodedSalt, encodedHash, extra] = tokenHash.split(
    STORED_HASH_SEPARATOR,
  );
  if (
    prefix !== STORED_HASH_PREFIX ||
    encodedSalt === undefined ||
    encodedHash === undefined ||
    extra !== undefined
  ) {
    return false;
  }
  const salt = Buffer.from(encodedSalt, "base64url");
  const expected = Buffer.from(encodedHash, "base64url");
  return (
    salt.byteLength === STORED_SALT_BYTES &&
    expected.byteLength === STORED_KEY_BYTES &&
    sameBytes(scryptSync(token, salt, STORED_KEY_BYTES), expected)
  );
}

function legacyHashMatches(tokenHash: string, token: string): boolean {
  const expected = Buffer.from(tokenHash, "base64url");
  const actual = createHash("sha256").update(token).digest();
  return (
    expected.byteLength === LEGACY_DIGEST_BYTES && sameBytes(actual, expected)
  );
}

export function tokenHashMatches(tokenHash: string, token: string): boolean {
  return (
    currentHashMatches(tokenHash, token) || legacyHashMatches(tokenHash, token)
  );
}
