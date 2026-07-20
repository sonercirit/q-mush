export function createdAuditFields(actorId: string, now: number) {
  const timestamp = new Date(now);
  return {
    createdAt: timestamp,
    createdById: actorId,
    isDeleted: false,
    updatedAt: timestamp,
    updatedById: actorId,
  };
}

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
