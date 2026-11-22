import { jsonLanguage } from "@codemirror/lang-json";

const MAX_FIELDS = 64;
const MAX_TYPES = 8;

/** A shallow index of declared fields, not an evaluation of JSON Schema. */
export function describeSchemaFields(source: string) {
  const root = jsonLanguage.parser.parse(source).topNode.firstChild;
  if (root?.name !== "Object") return undefined;
  const text = (node: { from: number; to: number }) =>
    source.slice(node.from, node.to);
  const string = (node: typeof root | null | undefined): string | undefined =>
    node?.name === "String" ? JSON.parse(text(node)) : undefined;
  function fields(node: typeof root) {
    const map = new Map<string, typeof root>();
    for (const property of node?.getChildren("Property") ?? []) {
      const name = property.firstChild;
      if (name?.name !== "PropertyName" || !property.lastChild)
        return undefined;
      const key: string = JSON.parse(text(name));
      if (map.has(key)) return undefined;
      map.set(key, property.lastChild);
    }
    return map;
  }
  const top = fields(root);
  const properties = top?.get("properties");
  if (properties?.name !== "Object") return undefined;
  const members = fields(properties);
  if (!members) return undefined;
  const requiredNode = top?.get("required");
  const required = new Set(
    requiredNode?.name === "Array"
      ? requiredNode.getChildren("String").map(string)
      : [],
  );
  const rows = [];
  for (const [name, value] of members) {
    if (rows.length === MAX_FIELDS) break;
    const field = value?.name === "Object" ? fields(value) : undefined;
    const type = field?.get("type");
    const directType = string(type);
    const types =
      directType !== undefined
        ? [directType]
        : type?.name === "Array"
          ? type
              .getChildren("String")
              .slice(0, MAX_TYPES + 1)
              .map(string)
          : [];
    rows.push({
      name,
      required: required.has(name),
      type:
        types.length > MAX_TYPES ? undefined : types.join(" | ") || undefined,
      description: string(field?.get("description")),
    });
  }
  return { rows, truncated: members.size > rows.length };
}
