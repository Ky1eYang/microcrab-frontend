type DiagnosticEntry = { key: string; value: () => DiagnosticNode };
export type DiagnosticNode = { text: string; entries?: DiagnosticEntry[] };

/** Explicitly local diagnostic adapter, not a backend JSON source. Lazy children
 * inspect own descriptors only. Markers are not exact JSON and should not be
 * passed to the reader as copy evidence. As with reflection generally, callers
 * must not supply untrusted Proxy objects (which can execute traps). */
export function describeLocalJs(value: unknown): DiagnosticNode {
  return describe(value, []);
}

function describe(
  value: unknown,
  ancestors: readonly object[],
): DiagnosticNode {
  if (typeof value === "undefined") return { text: "[undefined]" };
  if (typeof value === "function") return { text: "[Function]" };
  if (typeof value === "bigint") return { text: `${value}n` };
  if (typeof value === "symbol")
    return { text: Symbol.prototype.toString.call(value) };
  if (!value || typeof value !== "object")
    return {
      text:
        typeof value === "string"
          ? JSON.stringify(value)
          : Object.is(value, -0)
            ? "-0"
            : String(value),
    };
  if (ancestors.includes(value)) return { text: "[Ancestor cycle]" };
  const proto = Object.getPrototypeOf(value);
  if (proto === Date.prototype) {
    const time = Date.prototype.getTime.call(value);
    return {
      text: Number.isNaN(time)
        ? "[Invalid Date]"
        : `[Date ${Date.prototype.toISOString.call(value)}]`,
    };
  }
  if (proto === RegExp.prototype) {
    const source = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "source",
    )?.get?.call(value);
    const flags = (
      [
        ["hasIndices", "d"],
        ["global", "g"],
        ["ignoreCase", "i"],
        ["multiline", "m"],
        ["dotAll", "s"],
        ["unicode", "u"],
        ["unicodeSets", "v"],
        ["sticky", "y"],
      ] as const
    )
      .filter(([key]) =>
        Object.getOwnPropertyDescriptor(RegExp.prototype, key)?.get?.call(
          value,
        ),
      )
      .map(([, flag]) => flag)
      .join("");
    return { text: `[RegExp /${source}/${flags}]` };
  }
  const array = Array.isArray(value);
  if (
    array
      ? proto !== Array.prototype
      : proto !== Object.prototype && proto !== null
  )
    return { text: "[Unsupported object]" };
  const path = [...ancestors, value];
  return {
    text: array ? "[Array]" : "[Object]",
    entries: Reflect.ownKeys(value).flatMap((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable) return [];
      return [
        {
          key: String(key),
          value: () =>
            "value" in property
              ? describe(property.value, path)
              : { text: "[Accessor not read]" },
        },
      ];
    }),
  };
}
