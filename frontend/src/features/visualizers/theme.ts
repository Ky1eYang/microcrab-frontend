import { useEffect, useState } from "react";
/** Observe the existing resolved data-theme owner; never write theme state here. */
export function useVisualTheme() {
  const read = () =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
