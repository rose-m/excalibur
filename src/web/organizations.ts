export type Organization = { id: string; name: string };

export function selectOrganization(organizations: readonly Organization[], requested: string | null, remembered: string | null): string | undefined {
  // Explicit but invalid selections must not silently open another workspace.
  const candidate = requested ?? remembered;
  if (candidate && organizations.some(org => org.id === candidate)) return candidate;
  if (requested !== null) return undefined;
  return organizations.length === 1 ? organizations[0]!.id : undefined;
}

export function organizationStorageKey(userId: string) { return `excalibur:organization:${userId}`; }

export function organizationUrl(organizationId: string, path = "/") {
  return `${path}?${new URLSearchParams({ organization: organizationId })}`;
}
