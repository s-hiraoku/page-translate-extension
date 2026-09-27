import React from "react";
import { createRoot } from "react-dom/client";
import { SidePanel } from "./SidePanel";
import { applyTheme, cachedTheme } from "./theme";
import "./sidepanel.css";

// Apply the last known theme before the first paint to avoid a light flash.
applyTheme(cachedTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>,
);
