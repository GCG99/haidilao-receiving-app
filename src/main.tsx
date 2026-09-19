import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OverviewPage } from "./components/OverviewPage";
import { WorkbenchPage } from "./components/WorkbenchPage";
import { OpsPage } from "./components/OpsPage";
import { StatementsPage } from "./components/StatementsPage";
import "./styles.css";

const isOverviewRoute = window.location.pathname.startsWith("/overview");
const isWorkbenchRoute = window.location.pathname.startsWith("/workbench");
const isOpsRoute = window.location.pathname.startsWith("/ops");
const isStatementsRoute = window.location.pathname.startsWith("/statements");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isOverviewRoute ? (
      <OverviewPage />
    ) : isWorkbenchRoute ? (
      <WorkbenchPage />
    ) : isOpsRoute ? (
      <OpsPage />
    ) : isStatementsRoute ? (
      <StatementsPage />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
