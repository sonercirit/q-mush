import { isRecord } from "../shared/auth-model.ts";

export interface OpenAiOAuthCredential {
  readonly access: string;
  readonly expires: number;
  readonly refresh: string;
}

export function readOpenAiOAuthCredential(
  secret: string,
): OpenAiOAuthCredential {
  try {
    const value: unknown = JSON.parse(secret);

    if (isRecord(value)) {
      const access = value["access"];
      const expires = value["expires"];
      const refresh = value["refresh"];

      if (
        typeof access === "string" &&
        access.length > 0 &&
        typeof expires === "number" &&
        Number.isSafeInteger(expires) &&
        typeof refresh === "string" &&
        refresh.length > 0
      ) {
        return { access, expires, refresh };
      }
    }
  } catch {
    // The common error deliberately avoids exposing credential contents.
  }

  throw new Error("The stored OpenAI OAuth credential is invalid");
}
