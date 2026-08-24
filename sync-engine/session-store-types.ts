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
  readonly turnId?: string | null;
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

export type SpawnedReportParameters = readonly [
  userId: string,
  childId: string,
  childGeneration: number,
  parentId: string,
  parentGeneration: number,
  content: string,
  now: number,
];
