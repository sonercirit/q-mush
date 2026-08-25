import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface StoredDeviceIdentity {
  readonly accountId: string;
  readonly deviceId: string;
  readonly encryptionPrivateKey: string;
  readonly encryptionPublicKey: string;
  readonly signingPrivateKey: string;
  readonly signingPublicKey: string;
}

export interface AnonymousRunnerIdentity {
  readonly pairing: {
    readonly browserGrant: string;
    readonly code: string;
  };
  readonly publicIdentity: Pick<
    StoredDeviceIdentity,
    "accountId" | "deviceId" | "encryptionPublicKey" | "signingPublicKey"
  >;
}

function createStoredIdentity(): StoredDeviceIdentity {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  return {
    accountId: randomUUID(),
    deviceId: randomUUID(),
    encryptionPrivateKey: encryption.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
    encryptionPublicKey: encryption.publicKey.export({
      format: "pem",
      type: "spki",
    }),
    signingPrivateKey: signing.privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
    signingPublicKey: signing.publicKey.export({ format: "pem", type: "spki" }),
  };
}

function parseStoredIdentity(value: unknown): StoredDeviceIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    !("accountId" in value) ||
    typeof value.accountId !== "string" ||
    !("deviceId" in value) ||
    typeof value.deviceId !== "string" ||
    !("encryptionPrivateKey" in value) ||
    typeof value.encryptionPrivateKey !== "string" ||
    !("encryptionPublicKey" in value) ||
    typeof value.encryptionPublicKey !== "string" ||
    !("signingPrivateKey" in value) ||
    typeof value.signingPrivateKey !== "string" ||
    !("signingPublicKey" in value) ||
    typeof value.signingPublicKey !== "string"
  )
    throw new Error("The anonymous device identity is invalid");
  return {
    accountId: value.accountId,
    deviceId: value.deviceId,
    encryptionPrivateKey: value.encryptionPrivateKey,
    encryptionPublicKey: value.encryptionPublicKey,
    signingPrivateKey: value.signingPrivateKey,
    signingPublicKey: value.signingPublicKey,
  };
}

export function createAnonymousRunnerIdentity(
  directory: string,
): AnonymousRunnerIdentity {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "device-identity.json");
  const stored = existsSync(path)
    ? parseStoredIdentity(JSON.parse(readFileSync(path, "utf8")))
    : createStoredIdentity();
  if (!existsSync(path))
    writeFileSync(path, JSON.stringify(stored), { mode: 0o600 });
  return {
    pairing: {
      browserGrant: randomBytes(32).toString("base64url"),
      code: randomBytes(9).toString("base64url"),
    },
    publicIdentity: {
      accountId: stored.accountId,
      deviceId: stored.deviceId,
      encryptionPublicKey: stored.encryptionPublicKey,
      signingPublicKey: stored.signingPublicKey,
    },
  };
}
