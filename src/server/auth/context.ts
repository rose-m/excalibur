export type OperationContext = Readonly<{
  userId: string;
  organizationId: string;
}>;

// Local development only. The authenticated adapter validates current membership
// before constructing an operation context; never trust client-supplied identity.
export const developmentContext: OperationContext = Object.freeze({
  userId: "development-user",
  organizationId: "development-organization",
});
