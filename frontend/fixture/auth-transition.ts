/** Render-only login showcase: no store, probes, timers or navigation. */
import React from "react";
import { createRoot } from "react-dom/client";
import { LoginPageView } from "../src/login";
import { authErrorMessage } from "../src/client/auth";
import { syncLocaleFromPreference, t } from "../src/i18n";
import "../src/styles/tokens.css";
import "../src/styles/chrome.css";
import "../src/styles/components.css";
import "../src/styles/interaction-polish.css";

export const AUTH_SCENARIOS = ["login-page", "login-error", "login-checking"];
export function renderAuthFixture(
  id: string,
  root: HTMLElement,
  params: URLSearchParams,
) {
  syncLocaleFromPreference(params.get("locale") === "en" ? "en" : "zh-CN");
  document.documentElement.dataset.theme =
    params.get("theme") === "dark" ? "dark" : "light";
  document.title = `${t("auth.login.title")} | microcrab`;
  createRoot(root).render(
    React.createElement(
      "div",
      {
        style: { minHeight: "100%" },
        onSubmit: (event: React.FormEvent) => event.preventDefault(),
        "data-testid": "auth-fixture",
      },
      React.createElement(LoginPageView, {
        checking: id === "login-checking",
        error:
          id === "login-error"
            ? authErrorMessage("?auth_error=access_denied")
            : "",
      }),
    ),
  );
  document.documentElement.dataset.fixture = "ready";
}
