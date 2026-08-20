import { expect, test, vi } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import {
  createValidatedSession,
  type SessionCreationDependencies,
} from "../../sync-engine/session-creation.ts";
import type { CreateSessionInput } from "../../sync-engine/session-input.ts";
import { SessionRestartAbort } from "../../sync-engine/session-restart-abort.ts";
import { createTestProviderCredential } from "./authenticated-integration-test-helpers.ts";
import { emptyTestModelCatalog } from "./realtime-session-fixture.ts";

const TEST_USER = {
  email: "mushroom@example.com",
  id: "user-1",
  name: "Mush Room",
};
const TEST_CREDENTIAL = createTestProviderCredential(
  TEST_SESSION_DETAIL.credentialId,
);

function detailResponse(value: unknown): AgentSessionDetail {
  if (!isRecord(value)) {
    throw new Error("The creation response was not a session detail");
  }
  return {
    ...TEST_SESSION_DETAIL,
    ...value,
  };
}

function sessionInput(): CreateSessionInput & { readonly workspaceId: string } {
  return {
    autoCompact: true,
    credentialId: TEST_SESSION_DETAIL.credentialId,
    executionEnvironment: TEST_SESSION_DETAIL.executionEnvironment,
    images: [],
    model: TEST_SESSION_DETAIL.model,
    openRouterProviderTag: null,
    prompt: "Create exactly one durable session",
    provider: TEST_SESSION_DETAIL.provider,
    reasoningEffort: TEST_SESSION_DETAIL.reasoningEffort,
    runnerId: TEST_SESSION_DETAIL.runnerId,
    tools: TEST_SESSION_DETAIL.tools,
    workingDirectory: TEST_SESSION_DETAIL.workingDirectory,
    workspaceId: TEST_SESSION_DETAIL.workspaceId,
  };
}

function setupCreation(options: {
  readonly launch: () => boolean;
  readonly serializeCreatedDetail?: () => string;
}) {
  const committed = {
    ...TEST_SESSION_DETAIL,
    id: "session-created",
    status: "queued" as const,
    updatedAt: 10,
  };
  let authoritative: AgentSessionDetail = committed;
  const store: SessionCreationDependencies["store"] = {
    create: vi.fn(() => ({ detail: committed, status: "created" as const })),
    get: vi.fn(() => authoritative),
    pauseQueuedForRestart: vi.fn(() => false),
    transitionRuntime: vi.fn(() => {
      authoritative = {
        ...authoritative,
        status: "failed",
        updatedAt: authoritative.updatedAt + 1,
      };
      return true;
    }),
  };
  const dependencies = {
    discoverModels: emptyTestModelCatalog,
    discoverOpenRouterProviders: () =>
      Promise.resolve({ providers: [], stale: false }),
    launch: options.launch,
    notify: vi.fn(),
    now: () => 20,
    onCreated: vi.fn(),
    restartSignal: () => new AbortController().signal,
    runtimes: {
      accepts: () => true,
      pendingRestart: () => undefined,
    },
    ...(options.serializeCreatedDetail === undefined
      ? {}
      : { serializeCreatedDetail: options.serializeCreatedDetail }),
    store,
  } satisfies SessionCreationDependencies;
  return { committed, dependencies, store };
}

function rejectedLaunch(): never {
  throw new Error("launch boundary failed after creation");
}

async function createWithSetup(
  setup: ReturnType<typeof setupCreation>,
  input = sessionInput(),
): Promise<Response> {
  return createValidatedSession(
    setup.dependencies,
    TEST_USER,
    input,
    TEST_CREDENTIAL,
  );
}

async function expectCreatedDetail(
  setup: ReturnType<typeof setupCreation>,
  response: Response,
  expected: Partial<AgentSessionDetail>,
): Promise<AgentSessionDetail> {
  expect(response.status).toBe(201);
  const value = detailResponse(await response.json());
  expect(value).toMatchObject({ id: setup.committed.id, ...expected });
  expect(setup.dependencies.onCreated).toHaveBeenCalledWith(value);
  return value;
}

test("returns authoritative committed state when launch returns false", async () => {
  const setup = setupCreation({ launch: () => false });
  const failedResponse = await createWithSetup(setup);

  await expectCreatedDetail(setup, failedResponse, {
    status: "failed",
    updatedAt: 11,
  });
  expect(setup.store.transitionRuntime).toHaveBeenCalledOnce();
});

test("persists the requested creation auto-compaction value", async () => {
  const setup = setupCreation({ launch: rejectedLaunch });
  const response = await createWithSetup(setup, {
    ...sessionInput(),
    autoCompact: false,
  });

  expect(setup.store.create).toHaveBeenCalledWith(
    expect.objectContaining({ autoCompact: false }),
    20,
  );
  expect(response.status).toBe(201);
});

test("returns committed creation when launch throws after the commit", async () => {
  const setup = setupCreation({ launch: rejectedLaunch });
  const queuedResponse = await createWithSetup(setup);

  await expectCreatedDetail(setup, queuedResponse, {
    status: "queued",
    updatedAt: 10,
  });

  expect(setup.store.transitionRuntime).not.toHaveBeenCalled();
});

test("classifies an unrepresentable post-commit result as uncertain without launching", async () => {
  const launch = vi.fn(() => true);
  const setup = setupCreation({
    launch,
    serializeCreatedDetail: () => {
      throw new Error("result serialization failed");
    },
  });
  const response = await createWithSetup(setup);

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    error: "outcome_unknown",
  });
  expect(setup.store.create).toHaveBeenCalledOnce();
  expect(launch).not.toHaveBeenCalled();
  expect(setup.dependencies.onCreated).not.toHaveBeenCalled();
});

test("classifies discovery with the captured restart signal after recovery", async () => {
  const restart = new SessionRestartAbort();
  const setup = setupCreation({ launch: () => restart.signal.aborted });
  setup.dependencies.restartSignal = () => restart.signal;
  setup.dependencies.discoverModels = () => {
    const cancellation = new Error("discovery aborted by restart");
    restart.abort(cancellation);
    restart.restore();
    return Promise.reject(cancellation);
  };

  const response = await createWithSetup(setup);

  expect({
    status: response.status,
    writes: vi.mocked(setup.store.create).mock.calls,
  }).toEqual({
    status: 503,
    writes: [],
  });
});
