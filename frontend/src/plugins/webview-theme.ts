import type { ResolvedTheme } from "../client/theme";

/** Public presentation tokens. Private styles and plugin state never cross here. */
export const WEBVIEW_THEME_TOKENS = {
  bg: "--bg",
  "bg-subtle": "--bg-subtle",
  surface: "--surface",
  "bg-muted": "--bg-muted",
  text: "--text",
  "text-muted": "--text-2",
  "text-faint": "--text-3",
  border: "--border",
  "border-strong": "--border-strong",
  "control-border": "--control-border",
  focus: "--focus",
  success: "--success",
  warning: "--warn",
  danger: "--danger",
  info: "--info",
  ink: "--ink",
  "ink-contrast": "--ink-contrast",
  overlay: "--overlay",
  "shadow-modal": "--shadow-modal",
  "font-sans": "--font-sans",
  "font-mono": "--font-mono",
  "syntax-key": "--syntax-key",
  "syntax-string": "--syntax-string",
  "syntax-literal": "--syntax-literal",
} as const;

export interface WebviewTheme {
  scheme: ResolvedTheme;
  tokens: Record<string, string>;
}

export function readWebviewTheme(): WebviewTheme {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return {
    scheme: root.dataset.theme === "dark" ? "dark" : "light",
    tokens: Object.fromEntries(
      Object.entries(WEBVIEW_THEME_TOKENS).map(([name, source]) => [
        `--microcrab-${name}`,
        styles.getPropertyValue(source).trim(),
      ]),
    ),
  };
}
