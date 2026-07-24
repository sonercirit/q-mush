import { expect, test } from "vitest";

async function readClient(): Promise<string> {
  return Bun.file(new URL("../client.tsx", import.meta.url)).text();
}

test("client integration keeps the panel modular and realtime-only", async () => {
  const client = await readClient();

  expect(client).toContain('data-workspace-layout="desktop-status-panel"');
  expect(client).toContain("lg:grid-cols-[minmax(0,1fr)_17rem]");
  expect(client).toContain("xl:grid-cols-[minmax(0,1fr)_18rem]");
  expect(client).toContain("2xl:grid-cols-[minmax(0,1fr)_20rem]");
  expect(client).toContain("min-h-screen overflow-x-hidden");
  expect(client).toContain("<RunningSessionsPanel");

  expect(client).toContain("runningSessions.applySnapshot(event.sessions)");
  expect(client).toContain("runningSessions.applyDelta()");
  expect(client).toContain("runningSessions.connectionLost()");
  expect(client).toContain("if (!authenticatedWorkspace)");
  expect(client).not.toMatch(/runningSessions[\s\S]{0,80}requestJson/u);
  expect(client).not.toMatch(/runningSessions[\s\S]{0,80}fetch\(/u);
});
