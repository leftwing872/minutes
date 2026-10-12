import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate, loadConfig } from "./lib/auth";
import "./styles.css";

loadConfig().then((config) => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AuthGate config={config}>
        <App />
      </AuthGate>
    </React.StrictMode>,
  );
});
