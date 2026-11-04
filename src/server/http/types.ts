import type { OperationContext } from "../auth/context.js";

export type HttpEnv = {
  Variables: {
    context: OperationContext;
  };
};
