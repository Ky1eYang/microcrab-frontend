import type { ReactNode } from "react";

/** Shell keeps absolute menus unclipped; the inner box clips the offline tip to --r-lg. */
export function ComposerSurface({
  menu,
  clip,
  children,
}: {
  menu?: ReactNode;
  /** When true, clip the rounded box (offline notice-bar). */
  clip?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="home-composer-shell">
      {menu}
      <div
        className="home-composer-box"
        data-testid="composer"
        data-clip={clip ? "true" : undefined}
      >
        {children}
      </div>
    </div>
  );
}
