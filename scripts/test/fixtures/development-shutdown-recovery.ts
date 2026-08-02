import { createHash } from "node:crypto";
import { createDatabase } from "../../../shared/database.ts";
import {
  providerCredentials,
  runners,
  users,
  workspaces,
} from "../../../shared/database/schema.ts";
import { FINAL_SHUTDOWN_PREPARED_MESSAGE } from "../../../shared/development-shutdown.ts";
import { createUuidV7 } from "../../../shared/ids.ts";
import { SessionRuntimes } from "../../../sync-engine/session-runtime.ts";
import { ShutdownInterruptedSessionStore } from "../../../sync-engine/session-shutdown-interrupted-store.ts";
import { SessionStore } from "../../../sync-engine/session-store.ts";

const now = Date.now();
const [databasePath, statePath, mode] = process.argv.slice(2);
if (
  databasePath === undefined ||
  statePath === undefined ||
  mode === undefined
) {
  throw new Error("Missing shutdown recovery fixture arguments");
}
const database = createDatabase(databasePath);
function shutdownStore() {
  return new ShutdownInterruptedSessionStore({
    database,
    generateId: (timestamp) => createUuidV7(timestamp),
  });
}

if (mode === "start" || mode === "start-no-ack") {
  const userId = createUuidV7(now);
  const workspaceId = createUuidV7(now + 1);
  const runnerId = createUuidV7(now + 2);
  const credentialId = createUuidV7(now + 3);
  const sessionId = createUuidV7(now + 4);
  const audit = {
    createdAt: new Date(now),
    createdById: userId,
    updatedAt: new Date(now),
    updatedById: userId,
  };
  const user = {
    ...audit,
    email: "fixture@example.test",
    googleSubject: "fixture-user",
    id: userId,
    name: "Fixture User",
  };
  database.insert(users).values(user).run();
  database
    .insert(workspaces)
    .values({
      ...audit,
      id: workspaceId,
      isDefault: true,
      name: "Fixture",
      userId,
    })
    .run();
  database
    .insert(runners)
    .values({
      ...audit,
      architecture: "x64",
      id: runnerId,
      lastSeenAt: new Date(now),
      machineFingerprint: "shutdown-recovery-fixture",
      platform: "linux",
      tokenHash: createHash("sha256")
        .update("fixture-token")
        .digest("base64url"),
      userId,
    })
    .run();
  const credential = {
    ...audit,
    credentialFingerprint: "fixture-credential",
    encryptedCredential: "fixture-encrypted",
    id: credentialId,
    label: "Fixture key",
    provider: "openai" as const,
    source: "api_key" as const,
    userId,
  };
  database.insert(providerCredentials).values(credential).run();
  const generatedIds = [sessionId];
  const store = new SessionStore(
    database,
    (timestamp) => generatedIds.shift() ?? createUuidV7(timestamp),
  );
  const created = store.create(
    {
      agentFilePath: null,
      autoCompact: true,
      credentialId,
      executionEnvironment: "bare_metal",
      images: [],
      maxContextTokens: null,
      model: "fixture-model",
      openRouterProviderTag: null,
      prompt: "Keep this running across bounded shutdown.",
      provider: "openai",
      providerPricing: null,
      reasoningEffort: null,
      runnerId,
      tools: [],
      userId,
      workingDirectory: "/fixture",
      workspaceId,
    },
    now,
  );
  if (created.status !== "created") {
    throw new Error("The shutdown fixture session was not created");
  }
  store.transitionRuntime(sessionId, "running", now + 1, 0);
  const interrupted = shutdownStore();
  const runtimes = new SessionRuntimes();
  runtimes.launch(sessionId, runnerId, 0, "step", ({ restartRequest }) => {
    restartRequest((request, durable) => {
      if (durable) {
        interrupted.mark(sessionId, 0, request.restartId, "agent", Date.now());
      }
    });
    return new Promise(() => undefined);
  });
  process.on("SIGTERM", () => {
    void Bun.sleep(150)
      .then(() => runtimes.mark({ kind: "server" }, "bounded-final-shutdown"))
      .then(() => {
        if (mode === "start") {
          process.send?.(FINAL_SHUTDOWN_PREPARED_MESSAGE);
        }
      });
  });
  await Bun.write(statePath, JSON.stringify({ sessionId, userId }));
  setInterval(() => undefined, 1_000);
} else {
  const state: unknown = await Bun.file(statePath).json();
  if (
    typeof state !== "object" ||
    state === null ||
    !("sessionId" in state) ||
    typeof state.sessionId !== "string" ||
    !("userId" in state) ||
    typeof state.userId !== "string"
  ) {
    throw new Error("The shutdown fixture state is invalid");
  }
  const interrupted = shutdownStore();
  interrupted.failInvalid(now);
  interrupted.restore(now);
  const store = new SessionStore(database);
  store.failInterrupted(now + 1);
  const detail = store.get(state.userId, state.sessionId);
  if (detail === undefined) {
    throw new Error("The recovered shutdown fixture session is unavailable");
  }
  await Bun.write(statePath, JSON.stringify(detail));
  database.$client.close();
}
