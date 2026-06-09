import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAccent } from "./lib/accent";
import "./styles.css";

initAccent();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
