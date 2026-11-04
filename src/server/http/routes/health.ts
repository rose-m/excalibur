import { Hono } from "hono";
import type { HttpEnv } from "../types.js";

export const healthRoutes = new Hono<HttpEnv>()
  .get("/live", (c) => c.json({ status: "ok" }))
  .get("/ready", (c) => c.json({ status: "ok" }));
