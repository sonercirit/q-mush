import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { createApiError, createJsonResponse } from "./http.ts";
import {
  selectedSessionModel,
  type CreateSessionInput,
} from "./session-input.ts";
import type { DrizzleSessionIntegrationRuntime } from "./session-runtime-access.ts";

export async function launchCreatedSession(
  runtime: DrizzleSessionIntegrationRuntime,
  user: AuthenticatedUser,
  input: CreateSessionInput & { readonly workspaceId: string },
  credential: ProviderCredentialAccess,
): Promise<Response> {
  const selectedModel = selectedSessionModel(input, credential.source);
  let maxContextTokens: number | null = null;
  let providerPricing: AgentSessionSummary["providerPricing"] = null;

  try {
    const catalog = await runtime.discoverModels(input.provider, credential);
    const model = catalog.models.find(({ id }) => id === selectedModel);
    maxContextTokens = model?.contextWindow ?? null;
    providerPricing = model?.pricing ?? null;
  } catch {
    // Model discovery enhances display but does not gate a session.
  }

  if (runtime.draining()) {
    return createApiError("server_restarting", 503);
  }

  const detail = runtime.store.create(
    {
      ...input,
      autoCompact: true,
      maxContextTokens,
      model: selectedModel,
      providerPricing,
      userId: user.id,
    },
    runtime.now(),
  );
  runtime.launch(detail, credential, user.id);
  runtime.notify(user.id, detail.id);
  return createJsonResponse(detail, 201);
}
