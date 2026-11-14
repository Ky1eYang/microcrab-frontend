import { reportDiagnostic } from "./diagnostics";
import { t } from "../i18n";

export interface BrowserAuthSession {
  authenticated: boolean;
  principal?: {
    owner: string;
    subject: string;
    display_name: string;
    expires_at: number;
  };
}
const RETURN_CONTEXT = "microcrab.auth-return.v1";
const MAX_RETURN_COMPOSER = 262144;
const MAX_RETURN_ROUTE = 2048;
// JSON may escape each source code unit as six characters (for example \u0000).
// Reserve bounded overhead for the exact owner, expiry and object field names.
const MAX_RETURN_RECORD = 6 * (MAX_RETURN_COMPOSER + MAX_RETURN_ROUTE) + 4096;
export interface AuthReturnContext {
  owner: string;
  route: string;
  composer: string;
  expires: number;
}
/** One-use, tab-local navigation/draft context contains no credentials or history.
 * Restore only after verifying the current cookie's exact owner. */
export function rememberAuthReturn(
  owner: string,
  route: string,
  composer: string,
) {
  try {
    sessionStorage.setItem(
      RETURN_CONTEXT,
      JSON.stringify({
        owner,
        route: route.startsWith("#") || route === "" ? `/${route}` : route,
        composer: composer.slice(0, MAX_RETURN_COMPOSER),
        expires: Date.now() + 20 * 60 * 1000,
      }),
    );
  } catch (error) {
    reportDiagnostic("storage", "rememberAuthReturn", error, undefined, "warn");
  }
}
export function takeAuthReturn(owner: string): AuthReturnContext | null {
  try {
    const raw = sessionStorage.getItem(RETURN_CONTEXT);
    sessionStorage.removeItem(RETURN_CONTEXT);
    if (!raw || raw.length > MAX_RETURN_RECORD) return null;
    const value = JSON.parse(raw);
    if (
      value.owner !== owner ||
      !Number.isFinite(value.expires) ||
      value.expires <= Date.now() ||
      value.expires > Date.now() + 20 * 60 * 1000 ||
      !validAuthReturnRoute(value.route) ||
      typeof value.composer !== "string" ||
      value.composer.length > MAX_RETURN_COMPOSER
    )
      return null;
    return value;
  } catch (error) {
    reportDiagnostic("storage", "takeAuthReturn", error, undefined, "warn");
    return null;
  }
}

/** Only application routes can be restored; never OAuth callbacks or external URLs. */
export function validAuthReturnRoute(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_RETURN_ROUTE ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return false;
  const route =
    /^(?:\/?|dashboard|admin|(?:session|s)\/[^/?#]+(?:\/sub\/[^/?#]+)?|(?:session\/[^/?#]+\/)?plugins(?:\/[^/?#]+)?)\/?$/;
  const [pathname, hash, extra] = value.split("#");
  if (extra !== undefined || !route.test(pathname.slice(1))) return false;
  return hash === undefined || route.test(hash.replace(/^\//, ""));
}

/** The dedicated page owns probes, automatic OAuth attempts and retry UI. */
export function navigateLoginPage(base: string, search = "") {
  const target = new URL("/login", base);
  if (
    target.origin !== location.origin ||
    target.origin !== new URL(base).origin
  )
    throw Error("Invalid login page origin");
  const params = new URLSearchParams(search);
  if (params.has("auth_error"))
    target.searchParams.set("auth_error", params.get("auth_error") ?? "");
  if (params.has("signed_out")) target.searchParams.set("signed_out", "1");
  window.location.replace(target.toString());
}

/** Authentication redirects stay on the configured server origin. */
export function navigateAuth(base: string, destination: string) {
  const target = new URL(destination, base);
  if (
    target.origin !== new URL(base).origin ||
    !target.pathname.startsWith("/api/auth/")
  )
    throw Error("Invalid authentication destination");
  window.location.assign(target.toString());
}

/** Callback codes are deliberately vocabulary-limited; never render provider details. */
export function authErrorMessage(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has("auth_error")) return "";
  const code = params.get("auth_error");
  if (code === "access_denied") return t("auth.error.denied");
  if (code === "login_required" || code === "interaction_required")
    return t("auth.error.loginRequired");
  if (code === "temporarily_unavailable" || code === "server_error")
    return t("auth.error.unavailable");
  if (
    code &&
    [
      "invalid_request",
      "invalid_scope",
      "unauthorized_client",
      "unsupported_response_type",
      "consent_required",
      "account_selection_required",
      "authentication_failed",
      "login_cookie_missing",
      "login_expired",
      "state_mismatch",
      "issuer_mismatch",
      "configuration_missing",
      "token_exchange_failed",
    ].includes(code)
  )
    return t(`auth.error.${code}`);
  return t("auth.error.failed");
}

// Per-tab, per-server, versioned attempt marker. Written BEFORE leaving the
// document, survives reload/Back and an unauthenticated IdP bounce. It is not
// a credential or a timer: only a verified session rearms automatic sign-in.
function autoLoginKey(base: string) {
  return `microcrab.auth.auto-login.v1:${new URL(base).origin}`;
}
export function claimAutomaticLogin(base: string): boolean {
  try {
    const key = autoLoginKey(base);
    if (sessionStorage.getItem(key) !== null) return false;
    sessionStorage.setItem(key, "attempted");
    return true;
  } catch (error) {
    reportDiagnostic(
      "storage",
      "claimAutomaticLogin",
      error,
      undefined,
      "warn",
    );
    // Without durable storage we cannot promise loop prevention. Fail closed
    // to the existing manual Login, not an unsafe memory-only redirect.
    return false;
  }
}
export function clearAutomaticLogin(base: string) {
  try {
    sessionStorage.removeItem(autoLoginKey(base));
  } catch (error) {
    reportDiagnostic(
      "storage",
      "clearAutomaticLogin",
      error,
      undefined,
      "warn",
    );
  }
}
