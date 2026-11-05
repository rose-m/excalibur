import { initBaseAuth } from "@propelauth/node";
import { ServiceError } from "../canvas/errors.js";

export type Principal = Readonly<{
  userId: string;
  organizations: ReadonlyArray<{ id: string; name: string }>;
}>;

export type Authentication = {
  authUrl: string;
  authenticate: (authorization: string | undefined) => Promise<Principal>;
};

export function propelAuthentication(authUrl: string, apiKey: string): Authentication {
  const auth = initBaseAuth({ authUrl, apiKey });
  return {
    authUrl,
    async authenticate(authorization) {
      let user;
      try { user = await auth.validateAccessTokenAndGetUserClass(authorization); }
      catch { throw new ServiceError(401, "Please sign in again"); }
      // JWT organization claims can be stale. Check current membership on every
      // HTTP request and ticket issuance; never fall back to claims on failure.
      let current;
      try { current = await auth.fetchUserMetadataByUserId(user.userId, true); }
      catch { throw new ServiceError(503, "Authentication service unavailable"); }
      if (!current || !current.enabled || current.locked) throw new ServiceError(401, "Account unavailable");
      return {
        userId: user.userId,
        organizations: Object.entries(current.orgIdToOrgInfo ?? {}).map(([id, org]) => ({ id, name: org.orgName })),
      };
    },
  };
}
