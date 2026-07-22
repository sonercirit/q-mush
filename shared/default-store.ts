import { updatedAuditFields } from "./audit.ts";

export function defaultValues(userId: string, now: number, selected: boolean) {
  return { isDefault: selected, ...updatedAuditFields(userId, now) };
}
