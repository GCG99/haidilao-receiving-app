import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OverviewPage } from "./components/OverviewPage";
import "./styles.css";

const isOverviewRoute = window.location.pathname.startsWith("/overview");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isOverviewRoute ? <OverviewPage /> : <App />}
  </React.StrictMode>
);
