import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installContextmenuGuard } from "./lib/globalContextmenu";
import "./i18n";
import "./index.css";

if (import.meta.env.DEV) {
  void import("./dev/devConsole").then((m) => m.installDevConsole());
}

installContextmenuGuard();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
