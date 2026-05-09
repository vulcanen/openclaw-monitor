import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root not found");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
