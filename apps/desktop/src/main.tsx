import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted brand fonts (no CDN → offline + privacy, local-first).
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import { initAccent, initTheme } from "./lib/accent";
import "./styles.css";

initTheme();
initAccent();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
