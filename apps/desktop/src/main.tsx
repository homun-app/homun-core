import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted technical font (no CDN, offline and privacy friendly).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import { initAccent, initTheme } from "./lib/accent";
import "./i18n";
import { registerPluginI18n } from "./plugins/registry";
import "./styles.css";
import "./styles/foundation.css";
import "./styles/menus.css";
import "./styles/sidebar.css";
import "./styles/chat.css";

initTheme();
initAccent();
// Register each plugin's own i18n namespace (self-contained addons, ADR 0011 §6).
registerPluginI18n();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
