type UserProfile = {
  userId: string;
  username?: string | null | undefined;
  firstName?: string | null | undefined;
  lastName?: string | null | undefined;
};

// Display-only metadata. Missing profiles or directory outages must not change
// ownership, grant access, or prevent otherwise-authorized canvases from listing.
export async function userDisplayNames(userIds: readonly string[], fetchBatch: (ids: string[]) => Promise<Record<string, UserProfile>>) {
  const uniqueIds = [...new Set(userIds)];
  const names = new Map<string, string>();
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const batch = uniqueIds.slice(offset, offset + 100);
    try {
      const profiles = await fetchBatch(batch);
      for (const id of batch) {
        const profile = profiles[id];
        if (!profile || profile.userId !== id) continue;
        const name = profile.username?.trim() || [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(" ");
        if (name) names.set(id, name);
      }
    } catch { /* Do not expose directory errors or substitute IDs/emails for names. */ }
  }
  return names;
}
