import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/tokens.css";
import "@/styles/base.css";
import { App } from "@/App";
import { initI18n } from "@/i18n";

initI18n();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html no tiene el elemento #root");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
