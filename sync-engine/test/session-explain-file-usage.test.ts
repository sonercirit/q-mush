import { describe, expect, test } from "vitest";
import type {
  AgentModelCatalog,
  AgentModelOption,
} from "../../shared/agent-configuration.ts";
import type { AgentTokenUsage } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import type { ProviderModelPricing } from "../../shared/provider-model-pricing.ts";
import { SESSION_ATTACHMENT_FALLBACKS_PATH } from "../../shared/routes.ts";
import { testAgentModelOption } from "../../shared/test/agent-model-fixtures.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSessionSetup,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  CREDENTIAL_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  completeRunnerCommand,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

const ATTACHMENT = {
  data: "AQ==",
  mediaType: "application/pdf",
  name: "spec.pdf",
} as const;
const CURRENT_PRICING = { input: 0.01, output: 0.02 } as const;
const FALLBACK_PRICING = { input: 0.001, output: 0.002 } as const;
const AUXILIARY_USAGE: AgentTokenUsage = {
  cacheWriteInputTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 100,
  outputTokens: 10,
};
const MAIN_CONTEXT_TOKENS = 321;
const MAIN_COST_USD = 0.25;
const AUXILIARY_CONTEXT_TOKENS = 9_999;

function modelOption(
  id: string,
  inputModalities: readonly string[],
  pricing: ProviderModelPricing,
): AgentModelOption {
  return testAgentModelOption({ id, inputModalities, pricing });
}

function catalog(currentCanReadPdf: boolean): AgentModelCatalog {
  return {
    defaultModel: "gpt-4.1-mini",
    models: [
      modelOption(
        "gpt-4.1-mini",
        currentCanReadPdf ? ["text", "file"] : ["text"],
        CURRENT_PRICING,
      ),
      modelOption("pdf-model", ["text", "pdf"], FALLBACK_PRICING),
    ],
  };
}

function usageModel(costUsd: number | null) {
  return scriptedModel([
    {
      content: "I will explain the PDF.",
      contextTokens: MAIN_CONTEXT_TOKENS,
      costUsd: MAIN_COST_USD,
      toolCalls: [toolCall("explain_file", { path: "spec.pdf" })],
    },
    {
      content: "The PDF explanation.",
      contextTokens: AUXILIARY_CONTEXT_TOKENS,
      costUsd,
      tokenUsage: AUXILIARY_USAGE,
      toolCalls: [],
    },
    { content: "Explanation complete.", toolCalls: [] },
  ]);
}

type SessionSetup = ReturnType<typeof connectedSessionSetup>;

function usageSetup(costUsd: number | null, currentCanReadPdf: boolean) {
  const model = usageModel(costUsd);
  return {
    model,
    setup: connectedSessionSetup(model, "api_key", () =>
      Promise.resolve(catalog(currentCanReadPdf)),
    ),
  };
}

async function completeExplainFile(setup: SessionSetup): Promise<unknown> {
  await waitForSessionValue(setup.latestRunnerCommand, (value) =>
    isRecord(value) ? value["tool"] === "explain_file" : false,
  );
  const completion = completeRunnerCommand(setup, JSON.stringify(ATTACHMENT));
  expect(completion.status).toBe(204);
  return completedParentDetail(setup, "idle");
}

async function configurePdfFallback(setup: SessionSetup): Promise<void> {
  const response = await setup.sessions.attachmentFallbacks?.(
    createAuthenticatedRequest(
      SESSION_ATTACHMENT_FALLBACKS_PATH,
      {
        credentialId: CREDENTIAL_ID,
        modality: "pdf",
        model: "pdf-model",
        openRouterProviderTag: null,
        provider: "openai",
      },
      "PUT",
    ),
  );
  if (response === undefined) {
    throw new Error("Attachment fallback API is unavailable");
  }
  expect(response.status).toBe(200);
}

function expectUsage(
  detail: unknown,
  costBasis: "estimated" | "reported",
  costUsd: number,
): void {
  expect(detail).toEqual(
    expect.objectContaining({
      costBasis,
      currentContextTokens: MAIN_CONTEXT_TOKENS,
    }),
  );
  expect(isRecord(detail) ? detail["costUsd"] : null).toBeCloseTo(costUsd);
}

describe("explain file usage", () => {
  test("adds provider-reported session-model usage without replacing main context", async () => {
    const { model, setup } = usageSetup(0.75, true);
    await startToolSessionSetup(setup);

    const detail = await completeExplainFile(setup);

    expectUsage(detail, "reported", 1);
    expect(setup.selectedPricing).toEqual([CURRENT_PRICING, CURRENT_PRICING]);
    expect(model.requests[1]?.[0]).toEqual(
      expect.objectContaining({ attachments: [ATTACHMENT], role: "user" }),
    );
    closeSessionTestDatabase(setup.database);
  });

  test("estimates fallback usage from its selected catalog pricing", async () => {
    const { setup } = usageSetup(null, false);
    const response = await setup.sessions.collection(createSessionRequest());
    if (response.status !== 201) {
      throw new Error("The test session was not created");
    }
    await configurePdfFallback(setup);
    await completeAgentFileLookup(setup);

    const detail = await completeExplainFile(setup);

    expectUsage(detail, "estimated", 0.37);
    expect(setup.selectedPricing).toEqual([CURRENT_PRICING, FALLBACK_PRICING]);
    closeSessionTestDatabase(setup.database);
  });
});
