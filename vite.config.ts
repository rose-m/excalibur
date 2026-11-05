import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.EXCALIBUR_ALLOW_LOCAL === "1" ? "0.0.0.0" : "127.0.0.1",
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 3000}`, ws: true },
      "/health": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
});
