import type {
  AskQuestionsPersistenceTransaction,
  StoredQuestionSession,
} from "./ask-questions-store.ts";

export function activeQuestionSession(
  transaction: AskQuestionsPersistenceTransaction,
  userId: string,
  sessionId: string,
): StoredQuestionSession | undefined {
  const session = transaction.findSession(userId, sessionId);
  return session === undefined || session.isDeleted ? undefined : session;
}
