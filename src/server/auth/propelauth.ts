import { initBaseAuth } from "@propelauth/node";
import { ServiceError } from "../canvas/errors.js";
import { userDisplayNames } from "./user-display-names.js";

export type Principal = Readonly<{
  userId: string;
  organizations: ReadonlyArray<{ id: string; name: string }>;
}>;

export type Authentication = {
  authUrl: string;
  authenticate: (authorization: string | undefined) => Promise<Principal>;
  getPrincipal: (userId: string) => Promise<Principal>;
  getUserDisplayNames?: (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
};

export function propelAuthentication(authUrl: string, apiKey: string): Authentication {
  const auth = initBaseAuth({ authUrl, apiKey });
  async function getPrincipal(userId: string): Promise<Principal> {
    // JWT organization claims can be stale. Check current account eligibility
    // and membership for browser requests, live tickets and MCP exchanges.
    let current;
    try { current = await auth.fetchUserMetadataByUserId(userId, true); }
    catch { throw new ServiceError(503, "Authentication service unavailable"); }
    if (!current || current.userId !== userId || !current.enabled || current.locked) throw new ServiceError(401, "Account unavailable");
    return {
      userId,
      organizations: Object.entries(current.orgIdToOrgInfo ?? {}).map(([id, org]) => ({ id, name: org.orgName })),
    };
  }
  return {
    authUrl,
    getPrincipal,
    getUserDisplayNames: userIds => userDisplayNames(userIds, ids => auth.fetchBatchUserMetadataByUserIds(ids, false)),
    async authenticate(authorization) {
      let user;
      try { user = await auth.validateAccessTokenAndGetUserClass(authorization); }
      catch { throw new ServiceError(401, "Please sign in again"); }
      return getPrincipal(user.userId);
    },
  };
}
