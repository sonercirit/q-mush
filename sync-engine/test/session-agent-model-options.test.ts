import { describe, expect, test } from "vitest";
import { discoverAgentModels } from "../../sync-engine/agent-model-discovery.ts";
import {
  catalog,
  containsAny,
  modelOptionIds,
  sessionOptionOutputs,
  testCredential,
  testModelOption,
} from "./session-agent-option-fixtures.ts";
import { testString } from "./session-agent-output-helpers.ts";
import { findToolResultContents } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import { CREDENTIAL_ID } from "./session-integration-fixtures.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

function modelOption(index: number) {
  const matching = index % 2 === 0;
  return testModelOption(`catalog/model-${String(index).padStart(2, "0")}`, {
    contextWindow: 100_000 + index,
    inputModalities: index === 36 ? ["Visión"] : ["text"],
    label: matching ? `Café model ${String(index)}` : `Other ${String(index)}`,
    reasoningEfforts: matching ? ["high"] : [],
  });
}

function largeCatalog() {
  return Array.from({ length: 37 }, (_, index) => modelOption(index));
}

function startModelOptionSession(
  models: ReturnType<typeof modelOption>[],
  turns: Parameters<typeof scriptedModel>[0],
) {
  return startToolSession(scriptedModel(turns), {}, () => catalog(models));
}

function optionCall(
  id: string,
  options: {
    readonly credentialId?: string;
    readonly page?: number;
    readonly provider?: string;
    readonly search?: string;
  },
) {
  return toolCall(
    "get_session_options",
    {
      category: "models",
      credentialId: options.credentialId ?? CREDENTIAL_ID,
      page: options.page ?? 1,
      provider: options.provider ?? "openai",
      ...(options.search === undefined ? {} : { search: options.search }),
    },
    id,
  );
}

describe("agent model option discovery", () => {
  test("pages a large discovered catalog in stable provider order", async () => {
    const models = largeCatalog();
    const setup = await startModelOptionSession(models, [
      {
        content: "Inspect every model page.",
        toolCalls: [1, 2, 3, 4].map((page) =>
          optionCall(`models-${String(page)}`, { page }),
        ),
      },
      { content: "Model pages inspected.", toolCalls: [] },
    ]);
    const pages = await sessionOptionOutputs(setup);

    expect(pages.map(modelOptionIds)).toEqual(
      Array.from({ length: 4 }, (_, pageIndex) =>
        models.slice(pageIndex * 10, (pageIndex + 1) * 10).map(({ id }) => id),
      ),
    );
    expect(pages.map((page) => page["page"])).toEqual([1, 2, 3, 4]);
    expect(pages.flatMap(modelOptionIds)).toHaveLength(37);
    expect(pages.map((page) => page["hasNext"])).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(pages.map((page) => page["hasPrevious"])).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(pages.every((page) => page["totalItems"] === 37)).toBe(true);
    expect(pages.every((page) => page["totalPages"] === 4)).toBe(true);
    expect(pages.flatMap(modelOptionIds)).toHaveLength(
      new Set(pages.flatMap(modelOptionIds)).size,
    );
    closeSessionTestDatabase(setup.database);
  });

  test("searches before paging and rejects invalid model pages", async () => {
    const searchedModels = largeCatalog();
    const setup = await startModelOptionSession(searchedModels, [
      {
        content: "Inspect searched model pages.",
        toolCalls: [
          optionCall("search-first", { search: "CAFE MODEL" }),
          optionCall("search-last", { page: 2, search: "CAFE MODEL" }),
          optionCall("unicode", { search: "VISION" }),
          optionCall("zero", { search: "absent" }),
          optionCall("zero-page-two", { page: 2, search: "absent" }),
          optionCall("page-five", { page: 5 }),
        ],
      },
      { content: "Search inspected.", toolCalls: [] },
    ]);
    const outputs = await sessionOptionOutputs(setup);
    const matchingIds = searchedModels
      .filter((_, index) => index % 2 === 0)
      .map(({ id }) => id);

    expect(modelOptionIds(outputs[0] ?? {})).toEqual(matchingIds.slice(0, 10));
    expect(modelOptionIds(outputs[1] ?? {})).toEqual(matchingIds.slice(10));
    expect(outputs[0]).toMatchObject({
      filters: {
        credentialId: CREDENTIAL_ID,
        provider: "openai",
        search: "CAFE MODEL",
      },
      totalItems: 19,
      totalPages: 2,
    });
    expect(modelOptionIds(outputs[2] ?? {})).toEqual([searchedModels[36]?.id]);
    expect(outputs[3]).toMatchObject({
      items: [],
      totalItems: 0,
      totalPages: 0,
    });
    expect(testString(outputs[4]?.["error"])).toContain("out of range");
    expect(testString(outputs[5]?.["error"])).toContain("out of range");
    closeSessionTestDatabase(setup.database);
  });

  test("returns provider status failures without leaking response bodies", async () => {
    const setup = await startToolSession(
      scriptedModel([
        {
          content: "Inspect a rate-limited catalog.",
          toolCalls: [optionCall("rate-limited", {})],
        },
        { content: "Rate limit inspected.", toolCalls: [] },
      ]),
      {},
      (provider, selectedCredential) =>
        discoverAgentModels(provider, selectedCredential, () =>
          Promise.resolve(
            new Response("provider-secret", {
              status: 429,
              statusText: "provider-secret",
            }),
          ),
        ),
    );
    const detail = await completedParentDetail(setup, "idle");
    const [output] = findToolResultContents(detail, "get_session_options");

    expect(output).toContain("status 429");
    expect(output).not.toContain("provider-secret");
    closeSessionTestDatabase(setup.database);
  });

  test("keeps discovered catalogs isolated by credential", async () => {
    const secondary = testCredential("secondary-openai", "secondary-secret");
    const seen: string[] = [];
    const setup = await startToolSession(
      scriptedModel([
        {
          content: "Inspect both credential catalogs.",
          toolCalls: [
            optionCall("primary-catalog", {}),
            optionCall("secondary-catalog", { credentialId: secondary.id }),
          ],
        },
        { content: "Catalog isolation checked.", toolCalls: [] },
      ]),
      {
        credentials: {
          openai: [testCredential(CREDENTIAL_ID, "provider-secret"), secondary],
        },
      },
      (_provider, selectedCredential) => {
        seen.push(selectedCredential.id);
        const selectedModel = modelOption(
          selectedCredential.id === secondary.id ? 2 : 1,
        );
        return Promise.resolve({
          defaultModel: selectedModel.id,
          models: [selectedModel],
        });
      },
    );
    const outputs = await sessionOptionOutputs(setup);

    expect(outputs.map(modelOptionIds)).toEqual([
      [modelOption(1).id],
      [modelOption(2).id],
    ]);
    expect(seen).toEqual([CREDENTIAL_ID, CREDENTIAL_ID, secondary.id]);
    const serialized = JSON.stringify(outputs);
    expect(containsAny(serialized, ["provider-secret", secondary.secret])).toBe(
      false,
    );
    closeSessionTestDatabase(setup.database);
  });

  test("rejects inaccessible credentials and sanitizes arbitrary failures", async () => {
    const routerCredential = testCredential("router-owned", "router-secret");
    const foreignCredential = testCredential(
      "foreign-openai",
      "foreign-secret",
    );
    const deletedCredential = testCredential(
      "deleted-openai",
      "deleted-secret",
    );
    const setup = await startToolSession(
      scriptedModel([
        {
          content: "Try inaccessible credentials, then provider failure.",
          toolCalls: [
            optionCall("forged", { credentialId: "forged" }),
            optionCall("cross-provider", {
              credentialId: routerCredential.id,
              provider: "openai",
            }),
            optionCall("cross-owner", { credentialId: foreignCredential.id }),
            optionCall("deleted", { credentialId: deletedCredential.id }),
            optionCall("failed-discovery", {}),
          ],
        },
        { content: "Credential checks complete.", toolCalls: [] },
      ]),
      {
        credentials: { openrouter: [routerCredential] },
        deletedCredentials: { openai: [deletedCredential] },
        foreignCredentials: { openai: [foreignCredential] },
      },
      () => Promise.reject(new Error("upstream failed with provider-secret")),
    );
    const detail = await completedParentDetail(setup, "idle");
    const outputs = findToolResultContents(detail, "get_session_options");
    const serialized = JSON.stringify(outputs);

    expect(outputs).toHaveLength(5);
    expect(outputs.every((output) => output.startsWith("Error:"))).toBe(true);
    expect(outputs.every((output) => output.includes("unavailable"))).toBe(
      true,
    );
    expect(
      containsAny(serialized, [
        routerCredential.secret,
        foreignCredential.secret,
        deletedCredential.secret,
        "provider-secret",
        "foreign-user",
        "gpt-4.1-mini",
      ]),
    ).toBe(false);
    closeSessionTestDatabase(setup.database);
  });
});
