import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const CIPHER_VERSION = "v1";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BASE64URL_PATTERN = /^[A-Za-z\d_-]+={0,2}$/u;

type NonceGenerator = (size: number) => Uint8Array;

function decodeBase64Url(value: string, allowEmpty = false): Buffer {
  if (!(allowEmpty && value.length === 0) && !BASE64URL_PATTERN.test(value)) {
    throw new Error("The encrypted credential is malformed");
  }

  return Buffer.from(value, "base64url");
}

export class CredentialCipher {
  readonly #key: Buffer;
  readonly #randomBytes: NonceGenerator;

  constructor(
    key: Uint8Array,
    nonceGenerator: NonceGenerator = randomBytes,
    keyName = "Credential encryption key",
  ) {
    if (key.byteLength !== 32) {
      throw new Error(`${keyName} must be a 32-byte base64url value`);
    }

    this.#key = Buffer.from(key);
    this.#randomBytes = nonceGenerator;
  }

  open(value: string, context: string): string {
    const parts = value.split(".");

    if (parts.length !== 4) {
      throw new Error("The encrypted credential is malformed");
    }

    const [version = "", nonceValue = "", tagValue = "", payloadValue = ""] =
      parts;
    const nonce = decodeBase64Url(nonceValue);
    const tag = decodeBase64Url(tagValue);
    const payload = decodeBase64Url(payloadValue, true);

    if (
      version !== CIPHER_VERSION ||
      nonce.byteLength !== NONCE_LENGTH ||
      tag.byteLength !== AUTH_TAG_LENGTH
    ) {
      throw new Error("The encrypted credential is malformed");
    }

    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, this.#key, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(payload), decipher.final()]).toString(
      "utf8",
    );
  }

  seal(value: string, context: string): string {
    const nonce = Buffer.from(this.#randomBytes(NONCE_LENGTH));

    if (nonce.byteLength !== NONCE_LENGTH) {
      throw new Error("The credential nonce generator returned invalid data");
    }

    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.#key, nonce);
    cipher.setAAD(Buffer.from(context));
    const payload = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      CIPHER_VERSION,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      payload.toString("base64url"),
    ].join(".");
  }
}

export function createCredentialCipher(
  encodedKey: string,
  keyName = "Credential encryption key",
): CredentialCipher {
  if (!BASE64URL_PATTERN.test(encodedKey)) {
    throw new Error(`${keyName} must be a 32-byte base64url value`);
  }

  return new CredentialCipher(
    Buffer.from(encodedKey, "base64url"),
    randomBytes,
    keyName,
  );
}

export function fingerprintCredential(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
