import { operationEntityIntent } from "../sync-engine/operation-producer";

export const promptBodySet = (value: string, oldBody: string) =>
  operationEntityIntent(
    "prompts",
    "prompt",
    "prompt.body.set",
    { value },
    { name: "P", body: oldBody },
  );
