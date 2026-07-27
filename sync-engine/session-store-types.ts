export interface SessionRuntimeTarget<Resources> {
  readonly generation: number;
  readonly now: number;
  readonly resources: Resources;
  readonly sessionId: string;
}

export interface StoredUserMessageInput {
  readonly content: string;
  readonly now: number;
  readonly segment?: number;
  readonly sessionId: string;
  readonly userId: string;
}

export interface StoredMessageInsertOptions extends Omit<
  StoredUserMessageInput,
  "content"
> {
  readonly actorId: string;
  readonly id: string;
}

export type SystemStoredMessageInput = Omit<
  StoredMessageInsertOptions,
  "actorId" | "id"
>;
