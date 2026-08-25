import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../shared/auth-model.ts";

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
    readonly expiresAt: number;
    readonly transcript: string;
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
  if (!isRecord(value))
    throw new Error("The anonymous device identity is invalid");
  const fields = [
    "accountId",
    "deviceId",
    "encryptionPrivateKey",
    "encryptionPublicKey",
    "signingPrivateKey",
    "signingPublicKey",
  ] as const;
  const accountId = value["accountId"];
  const deviceId = value["deviceId"];
  const encryptionPrivateKey = value["encryptionPrivateKey"];
  const encryptionPublicKey = value["encryptionPublicKey"];
  const signingPrivateKey = value["signingPrivateKey"];
  const signingPublicKey = value["signingPublicKey"];
  if (
    fields.some((field) => typeof value[field] !== "string") ||
    typeof accountId !== "string" ||
    typeof deviceId !== "string" ||
    typeof encryptionPrivateKey !== "string" ||
    typeof encryptionPublicKey !== "string" ||
    typeof signingPrivateKey !== "string" ||
    typeof signingPublicKey !== "string"
  )
    throw new Error("The anonymous device identity is invalid");
  return {
    accountId,
    deviceId,
    encryptionPrivateKey,
    encryptionPublicKey,
    signingPrivateKey,
    signingPublicKey,
  };
}
export function createAnonymousRunnerIdentity(
  directory: string,
  now = Date.now(),
  pairingCode?: string,
  pairingTranscript?: string,
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
      code: pairingCode ?? randomBytes(9).toString("base64url"),
      expiresAt: now + 5 * 60_000,
      transcript: pairingTranscript ?? randomBytes(16).toString("base64url"),
    },
    publicIdentity: {
      accountId: stored.accountId,
      deviceId: stored.deviceId,
      encryptionPublicKey: stored.encryptionPublicKey,
      signingPublicKey: stored.signingPublicKey,
    },
  };
}
