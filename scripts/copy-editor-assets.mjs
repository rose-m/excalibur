import { cpSync, mkdirSync } from "node:fs";

// Excalidraw resolves fonts relative to window.EXCALIDRAW_ASSET_PATH.
// Serve the pinned package's fonts locally instead of depending on a CDN.
mkdirSync("public/excalidraw-assets", { recursive: true });
cpSync("node_modules/@excalidraw/excalidraw/dist/prod/fonts", "public/excalidraw-assets/fonts", { recursive: true });
