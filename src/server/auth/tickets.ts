import { createHash, randomBytes } from "node:crypto";
import type { OperationContext } from "./context.js";
import { ServiceError } from "../canvas/errors.js";

type Ticket = { context: OperationContext; canvasId: string; origin: string; expiresAt: number };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Process-local by design: the application currently supports one instance.
export class ConnectionTickets {
  private tickets = new Map<string, Ticket>();
  constructor(private now = Date.now) {}

  issue(context: OperationContext, canvasId: string, origin: string) {
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(key);
    const count = [...this.tickets.values()].filter(ticket => ticket.context.userId === context.userId).length;
    if (count >= 20 || this.tickets.size >= 10_000) throw new ServiceError(429, "Too many pending connections");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(digest(ticket), { context: Object.freeze({ ...context }), canvasId, origin, expiresAt: this.now() + 30_000 });
    return { ticket, expiresIn: 30 };
  }

  consume(value: string | undefined, canvasId: string, origin: string): OperationContext {
    if (!value || !/^[\w-]{43}$/.test(value)) throw new ServiceError(401, "Connection ticket required");
    const key = digest(value);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key); // Consume atomically, including failed binding checks.
    if (!ticket || ticket.expiresAt <= this.now() || ticket.canvasId !== canvasId || ticket.origin !== origin) {
      throw new ServiceError(401, "Connection ticket invalid or expired");
    }
    return ticket.context;
  }
}
