import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/overlays/ErrorBoundary";
import { initApp } from "./store/init";

// Mount the app immediately so the window is never blank.
// initApp runs in the background and updates store state as data arrives.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

initApp().catch((e) => {
  console.error("[eve-nexus] initApp failed:", e);
});
