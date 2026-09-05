// Native account ID is the identity key. Handles may be renamed or recycled.
export async function resolveTwitterIdentity(input, { findById, createById, persist }) {
  const { platformUserId, username, displayName } = input;
  const unresolved = { id: '', name: displayName || username, nickname: null, bio: null, relationship: null,
    interaction_count: null, last_interaction_at: null };
  if (typeof platformUserId !== 'string' || !/^[0-9]+$/.test(platformUserId)) return unresolved;
  const existing = await findById(platformUserId);
  if (existing) return existing;
  if (!persist) return unresolved;
  return await createById(platformUserId, username, displayName) || unresolved;
}
