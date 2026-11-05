import React from "react";
import { createRoot } from "react-dom/client";
import { Auth } from "./Auth.js";
import "./styles.css";

window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><Auth /></React.StrictMode>,
);
