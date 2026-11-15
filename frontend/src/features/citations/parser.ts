export interface LocalCitation {
  path: string;
  filename: string;
}
/** CommonMark AST destination, decoded once. Query/fragment are locators, never
 * filesystem bytes. Protocol-relative URLs remain external; UNC uses backslashes. */
export function classifyCitation(href: string): LocalCitation | null {
  if (!href || href.length > 4096 || href.startsWith("#")) return null;
  const raw = href.split(/[?#]/, 1)[0];
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (/[\x00-\x1f\x7f%@?#]/.test(value)) return null;
  value = value.replace(/\\/g, "/").replace(/:[1-9][0-9]*$/, "");
  const drive = /^[A-Za-z]:\//.test(value);
  if (value.includes(":") && (!drive || value.slice(2).includes(":")))
    return null;
  const unc = value.startsWith("//");
  if (unc && !raw.startsWith("\\\\")) return null;
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (
    !parts.length ||
    (drive && parts.length < 2) ||
    (unc && parts.length < 3) ||
    parts.some(
      (part) => part === ".." || /[. ]$/.test(part) || /[<>"|*]/.test(part),
    )
  )
    return null;
  const path = `${unc ? "//" : value.startsWith("/") ? "/" : ""}${parts.join("/")}`;
  return { path, filename: parts.at(-1)! };
}

/** Preserve default react-markdown URL sanitization. Metadata travels from
 * explicit link/image AST nodes to the scoped component, never via an unsafe URL. */
export function citationDestinations() {
  return (tree: any) => {
    const definitions = new Map<string, string>();
    const collect = (node: any) => {
      if (node.type === "definition")
        definitions.set(node.identifier, node.url);
      node.children?.forEach(collect);
    };
    collect(tree);
    const visit = (node: any) => {
      if (
        ["link", "image", "linkReference", "imageReference"].includes(node.type)
      ) {
        const href = node.url ?? definitions.get(node.identifier);
        if (typeof href === "string" && classifyCitation(href)) {
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              "data-citation-href": href,
            },
          };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
