declare const __MICROCRAB_FRONTEND_VERSION__: string;

export const frontendVersion = __MICROCRAB_FRONTEND_VERSION__;

export function buildSha256(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

export function frontendSha256(): string | undefined {
  return buildSha256(
    document.querySelector<HTMLMetaElement>('meta[name="microcrab-frontend-sha256"]')?.content,
  );
}
