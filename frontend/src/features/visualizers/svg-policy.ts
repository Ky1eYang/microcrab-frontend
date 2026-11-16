const SVG_NS = "http://www.w3.org/2000/svg";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const elements = new Set(
  "svg g defs title desc path rect circle ellipse line polyline polygon text tspan clipPath linearGradient radialGradient stop marker mask pattern style".split(
    " ",
  ),
);
const presentation = new Set(
  "fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity color clip-path clip-rule mask marker-start marker-mid marker-end paint-order vector-effect font-family font-size font-style font-weight font-variant font-stretch letter-spacing word-spacing text-anchor text-decoration dominant-baseline alignment-baseline baseline-shift visibility display shape-rendering text-rendering color-interpolation stop-color stop-opacity".split(
    " ",
  ),
);
const attributes = new Set(
  "version aria-hidden focusable id class style viewBox preserveAspectRatio width height x y x1 y1 x2 y2 cx cy r rx ry d points transform dx dy rotate textLength lengthAdjust gradientUnits gradientTransform spreadMethod offset fx fy fr clipPathUnits maskUnits maskContentUnits markerUnits markerWidth markerHeight refX refY orient patternUnits patternContentUnits patternTransform role aria-label aria-labelledby aria-describedby".split(
    " ",
  ),
);
const idPattern = /^[\w-]+$/;

/** Native SVG only. Reject the complete source on any unadmitted surface. */
export function sanitizeSvg(source: string, prefix: string): string | null {
  if (
    source.length > 65536 ||
    new TextEncoder().encode(source).byteLength > 65536 ||
    !prefix ||
    prefix.length > 256 ||
    /<!\s*(?:DOCTYPE|ENTITY)|<\?(?!xml\s)/i.test(source)
  )
    return null;
  try {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.doctype) return null;
    const all: Element[] = [];
    const pending: [Element, number][] = [[root, 1]];
    while (pending.length) {
      const [el, depth] = pending.pop()!;
      if (
        depth > 32 ||
        all.length >= 1024 ||
        !elements.has(el.localName) ||
        el.prefix ||
        (el.namespaceURI !== SVG_NS && el.namespaceURI !== null) ||
        (el !== root && el.localName === "svg")
      )
        return null;
      all.push(el);
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE)
          pending.push([child as Element, depth + 1]);
        else if (
          child.nodeType !== Node.TEXT_NODE &&
          child.nodeType !== Node.CDATA_SECTION_NODE &&
          child.nodeType !== Node.COMMENT_NODE
        )
          return null;
      }
    }
    // Encode every prefix code point rather than deleting punctuation (which can collide).
    const scope = `svg-${Array.from(prefix, (c) => c.codePointAt(0)!.toString(16)).join("-")}`;
    const className = (token: string): string => {
      if (!idPattern.test(token)) throw new Error("Unsupported SVG class");
      return `${scope}-c${Array.from(token, (c) => c.codePointAt(0)!.toString(16)).join("-")}`;
    };
    const ids = new Map<string, string>();
    for (const el of all) {
      const id = el.getAttribute("id");
      if (id !== null) {
        if (!idPattern.test(id) || ids.has(id)) return null;
        ids.set(id, `${scope}-i${ids.size}`);
      }
    }
    const localUrls = (value: string): string => {
      let count = 0;
      const rewritten = value.replace(
        /url\(\s*(['"]?)#([\w-]+)\1\s*\)/gi,
        (_, _quote, id: string) => {
          const target = ids.get(id);
          if (!target) throw new Error("Unresolved SVG reference");
          count++;
          return `url(#${target})`;
        },
      );
      if (
        /url\s*\(/i.test(rewritten.replace(/url\(#[\w-]+\)/g, "")) ||
        (/\burl\b/i.test(value) && !count)
      )
        throw new Error("Non-local SVG reference");
      return rewritten;
    };
    const safeValue = (value: string): string => {
      // No CSS escapes/comments, at-rules, variables, resource schemes or markup.
      if (
        /[\\@{}<>\u0000-\u0008\u000b\u000e-\u001f]|\/\*|\*\/|(?:https?|data|javascript|vbscript|file|blob):|expression\s*\(|var\s*\(|env\s*\(/i.test(
          value,
        )
      )
        throw new Error("Unsafe SVG value");
      for (const match of value.matchAll(/([a-z-]+)\s*\(/gi))
        if (
          !/^(?:url|rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|calc|min|max|clamp|matrix|translate|translateX|translateY|scale|scaleX|scaleY|rotate|skewX|skewY)$/i.test(
            match[1],
          )
        )
          throw new Error("Unsupported SVG function");
      return localUrls(value);
    };
    const declarations = (css: string): string => {
      if (/[\\@{}]|\/\*|\*\//.test(css)) throw new Error("Unsafe SVG CSS");
      return css
        .split(";")
        .filter((part) => part.trim())
        .map((part) => {
          const colon = part.indexOf(":");
          if (colon < 1) throw new Error("Invalid SVG declaration");
          const property = part.slice(0, colon).trim().toLowerCase();
          if (!presentation.has(property))
            throw new Error("Unsupported SVG property");
          return `${property}:${safeValue(part.slice(colon + 1).trim())}`;
        })
        .join(";");
    };
    const scopedStyles = (css: string): string => {
      if (/[\\@]|\/\*|\*\//.test(css)) throw new Error("Unsafe SVG stylesheet");
      let rest = css.trim();
      let output = "";
      while (rest) {
        const rule = /^([^{}]+)\{([^{}]*)\}/.exec(rest);
        if (!rule) throw new Error("Invalid SVG stylesheet");
        const selectors = rule[1].split(",").map((selector) => {
          const original = selector.trim();
          if (
            !original ||
            original.split(/\s*>\s*|\s+/).some((part) => {
              if (
                !/^(?:[A-Za-z][A-Za-z0-9]*|\*)?(?:[.#][\w-]+)*$/.test(part) ||
                !part
              )
                return true;
              const tag = /^[A-Za-z][A-Za-z0-9]*/.exec(part)?.[0];
              return tag !== undefined && !elements.has(tag);
            })
          )
            throw new Error("Unsupported SVG selector");
          const rewritten = original.replace(
            /[.#]([\w-]+)/g,
            (selector, token: string) => {
              if (selector[0] === ".") return `.${className(token)}`;
              const target = ids.get(token);
              if (!target) throw new Error("Unresolved SVG selector");
              return `#${target}`;
            },
          );
          const anchor = `:where(svg[data-svg-scope="${scope}"])`;
          return `${anchor}:is(${rewritten}),${anchor} :is(${rewritten})`;
        });
        output += `${selectors.join(",")}{${declarations(rule[2])}}`;
        rest = rest.slice(rule[0].length).trim();
      }
      return output;
    };
    // Rebuild in the SVG namespace, including XML sources that omit xmlns.
    const clean = document.implementation.createDocument(SVG_NS, "svg");
    const copy = (el: Element, target: Element): void => {
      for (const attribute of el.attributes) {
        const name = attribute.name;
        if (attribute.namespaceURI === XMLNS_NS || name === "xmlns") {
          if (!(
            (name === "xmlns" && attribute.value === SVG_NS) ||
            (name === "xmlns:xlink" &&
              attribute.value === "http://www.w3.org/1999/xlink")
          ))
            throw new Error("Unknown SVG namespace");
          continue;
        }
        if (attribute.namespaceURI === XML_NS && name === "xml:space") {
          if (!/^(?:default|preserve)$/.test(attribute.value))
            throw new Error("Invalid XML space");
          target.setAttributeNS(XML_NS, name, attribute.value);
          continue;
        }
        if (
          el.localName === "style" &&
          name === "type" &&
          !attribute.namespaceURI
        ) {
          if (attribute.value !== "text/css")
            throw new Error("Unsupported SVG style type");
          continue;
        }
        if (
          attribute.namespaceURI ||
          (!attributes.has(name) && !presentation.has(name))
        )
          throw new Error("Unsupported SVG attribute");
        let value = attribute.value;
        if (name === "id") value = ids.get(value)!;
        else if (name === "class")
          value = value.split(/\s+/).filter(Boolean).map(className).join(" ");
        else if (name === "style") value = declarations(value);
        else if (name === "aria-labelledby" || name === "aria-describedby")
          value = value
            .trim()
            .split(/\s+/)
            .map((id) => {
              const targetId = ids.get(id);
              if (!targetId)
                throw new Error("Unresolved SVG accessibility reference");
              return targetId;
            })
            .join(" ");
        else value = safeValue(value);
        target.setAttribute(name, value);
      }
      if (el.localName === "style") {
        if (el.children.length) throw new Error("Invalid SVG style content");
        target.textContent = scopedStyles(el.textContent ?? "");
        return;
      }
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const next = clean.createElementNS(
            SVG_NS,
            (child as Element).localName,
          );
          target.append(next);
          copy(child as Element, next);
        } else if (
          child.nodeType === Node.TEXT_NODE ||
          child.nodeType === Node.CDATA_SECTION_NODE
        )
          target.append(clean.createTextNode(child.textContent ?? ""));
      }
    };
    copy(root, clean.documentElement);
    clean.documentElement.setAttribute("data-svg-scope", scope);
    if (!clean.documentElement.hasAttribute("fill"))
      clean.documentElement.setAttribute("fill", "currentColor");
    if (!clean.documentElement.hasAttribute("viewBox")) {
      const dimensions = ["width", "height"].map((name) => {
        const value = root.getAttribute(name) ?? "";
        return /^\d+(?:\.\d+)?(?:px)?$/.test(value)
          ? Number.parseFloat(value)
          : 0;
      });
      if (dimensions.every((value) => value > 0 && Number.isFinite(value)))
        clean.documentElement.setAttribute(
          "viewBox",
          `0 0 ${dimensions.join(" ")}`,
        );
    }
    // Rendering bounds override authored dimensions, without replacing authored colors.
    const style = clean.documentElement.getAttribute("style");
    clean.documentElement.setAttribute(
      "style",
      `${style ? `${style};` : ""}max-width:100%;height:auto;display:block`,
    );
    return new XMLSerializer().serializeToString(clean.documentElement);
  } catch {
    return null;
  }
}
