import { describe, expect, test } from "vitest";
import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import { createdAuditFields } from "../../shared/audit.ts";
import { createDatabase } from "../../shared/database.ts";
import {
  agentSessions,
  providerCredentials,
  providerCredentialWorkspaces,
  runners,
  runnerWorkspaces,
  users,
} from "../../shared/database/schema.ts";
import { SYSTEM_ID } from "../../shared/ids.ts";
import { WorkspaceStore } from "../../sync-engine/workspace-store.ts";

const NOW = 1_700_000_000_000;
const USER_ID = "018bcfe5-6800-7000-8000-000000000091";
const DEFAULT_ID = "018bcfe5-6800-7000-8000-000000000092";
const SECOND_ID = "018bcfe5-6800-7000-8000-000000000093";
const RUNNER_ID = "018bcfe5-6800-7000-8000-000000000094";
const CREDENTIAL_ID = "018bcfe5-6800-7000-8000-000000000095";
const SCOPE_ID = "018bcfe5-6800-7000-8000-000000000096";
const SESSION_ID = "018bcfe5-6800-7000-8000-000000000097";

function setup() {
  const database = createDatabase(":memory:");
  database
    .insert(users)
    .values({
      createdAt: new Date(NOW),
      createdById: SYSTEM_ID,
      email: "workspace@example.com",
      googleSubject: "workspace-user",
      id: USER_ID,
      name: "Workspace User",
      updatedAt: new Date(NOW),
      updatedById: SYSTEM_ID,
    })
    .run();
  const ids = [DEFAULT_ID, SECOND_ID];
  const store = new WorkspaceStore(database, () => {
    const id = ids.shift();
    if (id === undefined) {
      throw new Error("No workspace ID remains");
    }
    return id;
  });
  return { database, store };
}

describe("workspace store", () => {
  test("creates a default and supports owned CRUD", () => {
    const { database, store } = setup();
    expect(store.createDefault(USER_ID, NOW)).toEqual({
      id: DEFAULT_ID,
      isDefault: true,
      name: "Default",
    });
    expect(store.create(USER_ID, " Work ", NOW + 1)).toEqual({
      id: SECOND_ID,
      isDefault: false,
      name: "Work",
    });
    expect(store.create(USER_ID, "Global", NOW + 2)).toBeUndefined();
    expect(store.create(USER_ID, "gLoBaL", NOW + 2)).toBeUndefined();
    expect(store.rename(USER_ID, SECOND_ID, "Projects", NOW + 3)).toEqual({
      id: SECOND_ID,
      isDefault: false,
      name: "Projects",
    });
    expect(store.setDefault(USER_ID, SECOND_ID, NOW + 4)).toBe(true);
    expect(store.list(USER_ID)).toMatchObject({
      defaultWorkspaceId: SECOND_ID,
      workspaces: [
        { id: DEFAULT_ID, isDefault: false, name: "Default" },
        { id: SECOND_ID, isDefault: true, name: "Projects" },
      ],
    });
    expect(store.remove(USER_ID, DEFAULT_ID, NOW + 5)).toBe("removed");
    expect(store.remove(USER_ID, SECOND_ID, NOW + 6)).toBe("last_workspace");
    expect(store.exists(USER_ID, DEFAULT_ID)).toBe(false);
    expect(store.exists("another-user", SECOND_ID)).toBe(false);
    database.$client.close();
  });

  test("blocks deletion while sessions or scoped connections reference a workspace", () => {
    const { database, store } = setup();
    store.createDefault(USER_ID, NOW);
    store.create(USER_ID, "Work", NOW + 1);
    const audit = createdAuditFields(USER_ID, NOW);
    database
      .insert(runners)
      .values({ ...audit, id: RUNNER_ID, tokenHash: "hash", userId: USER_ID })
      .run();
    database
      .insert(providerCredentials)
      .values({
        ...audit,
        credentialFingerprint: "fingerprint",
        encryptedCredential: "encrypted",
        id: CREDENTIAL_ID,
        label: "Credential",
        provider: "openai",
        source: "api_key",
        userId: USER_ID,
      })
      .run();
    database
      .insert(runnerWorkspaces)
      .values({
        ...audit,
        id: SCOPE_ID,
        runnerId: RUNNER_ID,
        userId: USER_ID,
        workspaceId: SECOND_ID,
      })
      .run();
    expect(store.remove(USER_ID, SECOND_ID, NOW + 2)).toBe("workspace_in_use");
    database.update(runnerWorkspaces).set({ isDeleted: true }).run();
    database
      .insert(providerCredentialWorkspaces)
      .values({
        ...audit,
        id: `${SCOPE_ID}-credential`,
        providerCredentialId: CREDENTIAL_ID,
        userId: USER_ID,
        workspaceId: SECOND_ID,
      })
      .run();
    expect(store.remove(USER_ID, SECOND_ID, NOW + 3)).toBe("workspace_in_use");
    database
      .update(providerCredentialWorkspaces)
      .set({ isDeleted: true })
      .run();
    database
      .insert(agentSessions)
      .values({
        ...audit,
        id: SESSION_ID,
        model: "gpt-4.1-mini",
        provider: "openai",
        providerCredentialId: CREDENTIAL_ID,
        runnerId: RUNNER_ID,
        status: "idle",
        title: "Session",
        tools: JSON.stringify(AGENT_SESSION_TOOL_NAMES),
        userId: USER_ID,
        workingDirectory: ".",
        workspaceId: SECOND_ID,
      })
      .run();
    expect(store.remove(USER_ID, SECOND_ID, NOW + 4)).toBe("workspace_in_use");
    database.$client.close();
  });
});
