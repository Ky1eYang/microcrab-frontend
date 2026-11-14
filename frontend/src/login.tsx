import { diagnosticMessage, reportDiagnostic } from "./client/diagnostics";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiClient } from "./client/api";
import {
  authErrorMessage,
  claimAutomaticLogin,
  clearAutomaticLogin,
  navigateAuth,
} from "./client/auth";
import { t } from "./i18n";
import "./styles/auth-transition.css";
export { authErrorMessage } from "./client/auth";

/** Shared pure form for the dedicated route and effect-free fixture. */
export function LoginPageView({
  checking,
  error,
  onSubmit,
}: {
  checking: boolean;
  error: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main
      className="auth-page"
      data-testid="auth-login-page"
      data-status={checking ? "checking" : "ready"}
      aria-labelledby="auth-login-heading"
    >
      <section className="auth-content">
        <div className="auth-wordmark">microcrab</div>
        <h1 id="auth-login-heading">{t("auth.login.title")}</h1>
        <p className="auth-description">{t("auth.login.body")}</p>
        {error ? (
          <p className="auth-login-error" role="alert">
            {error}
          </p>
        ) : null}
        <form
          action="/api/auth/login"
          method="get"
          className="auth-login-form"
          onSubmit={onSubmit}
        >
          <div className="auth-actions">
            <button
              className="primary-btn"
              data-testid="auth-login-submit"
              disabled={checking}
              type="submit"
            >
              {checking ? t("auth.login.checking") : t("settingsDlg.login")}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

export function LoginPage() {
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(() => authErrorMessage(location.search));
  const alive = useRef(false);
  const pending = useRef(false);
  const api = useRef<ApiClient | null>(null);
  if (!api.current) api.current = new ApiClient();
  const probe = async (manual = false) => {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    try {
      const client = api.current!;
      const session = await client.browserSession();
      if (!alive.current) return;
      const params = new URLSearchParams(location.search);
      if (session.authenticated) {
        clearAutomaticLogin(client.base);
        // Explicit logout must never silently sign back in, even if IdP logout
        // returned before another tab's cookie changed.
        if (!params.has("signed_out") || manual) location.replace("/");
        else setChecking(false);
      } else if (
        manual ||
        (!params.has("auth_error") &&
          !params.has("signed_out") &&
          claimAutomaticLogin(client.base))
      ) {
        // Manual attempts also mark the durable guard before leaving, so an
        // unauthenticated callback bounce cannot trigger another automatic try.
        if (manual) claimAutomaticLogin(client.base);
        setError("");
        navigateAuth(client.base, "/api/auth/login");
      } else setChecking(false);
    } catch (failure) {
      if (alive.current) {
        reportDiagnostic("login", "browserSession", failure);
        setError(
          `${t("auth.login.unavailable")} ${diagnosticMessage(failure)}`,
        );
        setChecking(false);
      }
    } finally {
      pending.current = false;
    }
  };
  useEffect(() => {
    alive.current = true;
    document.title = `${t("auth.login.title")} | microcrab`;
    void probe();
    const restored = (event: PageTransitionEvent) => {
      // Back restores this document with the spent durable guard intact.
      if (event.persisted) setChecking(false);
    };
    window.addEventListener("pageshow", restored);
    return () => {
      alive.current = false;
      window.removeEventListener("pageshow", restored);
    };
  }, []);
  return (
    <LoginPageView
      checking={checking}
      error={error}
      onSubmit={(event) => {
        event.preventDefault();
        void probe(true);
      }}
    />
  );
}
