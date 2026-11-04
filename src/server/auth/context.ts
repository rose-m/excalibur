export type OperationContext = Readonly<{
  userId: string;
  organizationId: string;
}>;

// Local development only. A future authenticated adapter must validate current
// membership before constructing this context; never use client-supplied IDs.
export const developmentContext: OperationContext = Object.freeze({
  userId: "development-user",
  organizationId: "development-organization",
});
