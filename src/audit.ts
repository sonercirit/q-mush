export function updatedAuditFields(actorId: string, now: number) {
  return {
    updatedAt: new Date(now),
    updatedById: actorId,
  };
}

export function softDeletedAuditFields(actorId: string, now: number) {
  return {
    ...updatedAuditFields(actorId, now),
    isDeleted: true,
  };
}
