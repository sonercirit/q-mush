import { Buffer } from "node:buffer";

export function createIdToken(email: string, accountId: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      email,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_user_id: `user-${accountId}`,
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.test-signature`;
}
