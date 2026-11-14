import type { ReactNode, SVGProps } from "react";

// Only geometry that is identical in both live Icon wrappers belongs here.
// Variant shapes and unknown-name fallbacks remain with their callers.
const shapes = new Map<string, ReactNode>([
  [
    "wrap",
    <>
      <path d="M3 6h18M3 11h13a4 4 0 0 1 0 8h-4" />
      <path d="m15 16-3 3 3 3M3 16h4" />
    </>,
  ],
  [
    "line-numbers",
    <>
      <path d="M9 5h12M9 12h12M9 19h12M3 4h1v3M3 11h2l-2 3h2M3 18h2v3H3" />
    </>,
  ],
  [
    "pause",
    <>
      <path d="M7 4h3v16H7zM14 4h3v16h-3z" />
    </>,
  ],
  ["play", <path d="m8 4 12 8-12 8z" />],
  [
    "edit",
    <>
      <path d="m16 3 5 5-12 12-6 1 1-6zM13 6l5 5" />
    </>,
  ],
  [
    "save",
    <>
      <path d="M4 3h13l4 4v14H3V3h1ZM7 3v6h10V3M7 21v-8h10v8" />
    </>,
  ],
  ["maximize", <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />],
  ["minimize", <path d="M3 8h5V3M21 8h-5V3M16 21v-5h5M3 16h5v5" />],
  [
    "eye",
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  ],
  [
    "eye-off",
    <>
      <path d="m3 3 18 18M9.9 5.2A11.6 11.6 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3 3.8M6.2 6.2A18 18 0 0 0 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>,
  ],
  [
    "refresh",
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 11.6-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" />
    </>,
  ],
  [
    "copy",
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>,
  ],
  [
    "ellipsis",
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>,
  ],
  [
    "ellipsis-vertical",
    <>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </>,
  ],
  ["chevron", <polyline points="9 18 15 12 9 6" />],
  ["spinner", <path d="M21 12a9 9 0 1 1-6.219-8.56" />],
  [
    "warning",
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>,
  ],
  [
    "expand",
    <>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </>,
  ],
]);

export function commonIconShape(name: string) {
  return shapes.get(name);
}

/** Callers retain their size defaults; explicit SVG props retain precedence. */
export function IconSvg({
  size,
  ...props
}: SVGProps<SVGSVGElement> & { size: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}
