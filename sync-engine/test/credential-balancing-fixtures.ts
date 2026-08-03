import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { ModelCredentialPool } from "../model-credential-pool.ts";
import type { SessionRealtimeCommands } from "../session-realtime-commands.ts";

export function balancedTestCredentialOrder(
  first: string,
  second: string,
): readonly string[] {
  return [first, second, first, second];
}

async function repeatFour<Value>(
  operation: () => Promise<Value>,
): Promise<Value[]> {
  const values: Value[] = [];
  for (let index = 0; index < 4; index += 1) {
    values.push(await operation());
  }
  return values;
}

export async function fourBalancedPoolSelections(
  pool: ModelCredentialPool,
  userId: string,
  selection: Parameters<ModelCredentialPool["candidates"]>[1],
): Promise<readonly (string | undefined)[]> {
  return repeatFour(
    async () => (await pool.candidates(userId, selection))[0]?.id,
  );
}

export async function fourBalancedSessions(options: {
  readonly commands: SessionRealtimeCommands;
  readonly create: Parameters<SessionRealtimeCommands["createForUser"]>;
  readonly persistedCredentialId: (
    detail: AgentSessionDetail,
  ) => string | undefined;
}): Promise<readonly string[]> {
  const details = await repeatFour(() =>
    options.commands.createForUser(...options.create),
  );
  return details.map((detail) => {
    if (options.persistedCredentialId(detail) !== detail.credentialId) {
      throw new Error("The resolved session credential was not persisted");
    }
    return detail.credentialId;
  });
}
