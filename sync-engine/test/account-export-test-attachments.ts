import { sha256 } from "../../shared/sha256.ts";

export const TEST_ATTACHMENT_BYTES = Uint8Array.from([1, 2, 3]);
export const TEST_ATTACHMENT_DATA = TEST_ATTACHMENT_BYTES.toBase64();
export const TEST_ATTACHMENT_DIGEST = sha256(TEST_ATTACHMENT_BYTES);
