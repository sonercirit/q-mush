import { isBalancedCredentialId } from "../shared/provider-credential-pool.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { RealtimeCommandError } from "../shared/user-realtime-protocol.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import { attemptBalancedCredentials } from "./session-balanced-credential-attempt.ts";
import {
  createPreparedSession,
  prepareSessionCredential,
  sessionMetadataErrorResponse,
  type SessionCreationDependencies,
} from "./session-creation.ts";
import type { CreateSessionInput } from "./session-input.ts";
import type {
  SessionRealtimeActionResult,
  WorkspaceSessionRealtimeActionOptions,
} from "./session-realtime-action-types.ts";
import {
  requireCredentialCandidates,
  requireJsonResponse,
  successfulCredentialAttempt,
} from "./session-realtime-errors.ts";
import type { SessionRunnerAvailability } from "./session-runner-availability.ts";

interface BalancedSessionCreationDependencies extends SessionCreationDependencies {
  readonly modelCredentialPool: ModelCredentialPool;
  readonly readCredential: SessionCreationCredentialReader;
  readonly runnerIsAvailable: SessionRunnerAvailability;
}

type SessionCreationCredentialReader = (
  userId: string,
  selection: CreateSessionInput & { readonly workspaceId: string },
) => Promise<Parameters<typeof createPreparedSession>[3]>;

export async function createSessionWithCredentialPool(
  options: WorkspaceSessionRealtimeActionOptions<
    CreateSessionInput & { readonly parentUserInitiated?: boolean }
  > & { readonly dependencies: BalancedSessionCreationDependencies },
): SessionRealtimeActionResult {
  const { dependencies, input, user, workspaceId } = options;
  const scopedInput = { ...input, workspaceId };
  if (!dependencies.runnerIsAvailable(user.id, input.runnerId, workspaceId)) {
    throw new RealtimeCommandError("runner_unavailable");
  }
  const balanced = isBalancedCredentialId(input.provider, input.credentialId);
  const credentials = balanced
    ? await dependencies.modelCredentialPool.candidates(user.id, scopedInput)
    : [await dependencies.readCredential(user.id, scopedInput)];
  requireCredentialCandidates(credentials);
  return successfulCredentialAttempt(
    attemptBalancedCredentials<AgentSessionDetail, typeof scopedInput>({
      credentials,
      dependencies: {
        attempt: async (credential, resolvedInput) => {
          const metadata = await prepareSessionCredential(
            {
              ...dependencies,
              rejectCredentialErrors: balanced,
            },
            user,
            resolvedInput,
            credential,
          );
          if ("error" in metadata) {
            await requireJsonResponse(sessionMetadataErrorResponse(metadata));
            throw new RealtimeCommandError("command_failed");
          }
          const created: { detail?: AgentSessionDetail } = {};
          const response = await createPreparedSession(
            {
              ...dependencies,
              onCreated: (detail) => {
                created.detail = detail;
              },
            },
            user,
            resolvedInput,
            credential,
            metadata,
          );
          await requireJsonResponse(response);
          if (created.detail === undefined) {
            throw new RealtimeCommandError("command_failed");
          }
          return created.detail;
        },
        pool: dependencies.modelCredentialPool,
      },
      input: scopedInput,
      userId: user.id,
    }),
  );
}
