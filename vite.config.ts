import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = `http://127.0.0.1:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.EXCALIBUR_ALLOW_LOCAL === "1" ? "0.0.0.0" : "127.0.0.1",
    proxy: {
      // Preserve the public Host for the backend's origin/rebinding checks.
      "/api": { target, ws: true, changeOrigin: false },
      "/health": { target, changeOrigin: false },
      "/mcp": { target, changeOrigin: false },
      "/.well-known": { target, changeOrigin: false },
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
});
