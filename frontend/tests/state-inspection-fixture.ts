import type { Json } from "../src/plugins/types";

/** One atomic Server inspection; fixtures keep values and governance independent. */
export function stateInspection(
  values: Record<string, Json>,
  metadata: Record<string, Record<string, Json>> = {},
  revision = "1",
) {
  return {
    values,
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [
        key,
        { owner: "client", editors: ["client", "agent"], ...value },
      ]),
    ),
    descriptors: Object.fromEntries(
      Object.keys(values).map((key) => [
        key,
        key in metadata
          ? {
              kind: "custom",
              editable:
                !Array.isArray(metadata[key].editors) ||
                metadata[key].editors.includes("client"),
              owner_editable: (metadata[key].owner ?? "client") === "client",
              deletable: (metadata[key].owner ?? "client") === "client",
            }
          : {
              kind: "framework",
              editable: false,
              owner_editable: false,
              deletable: false,
              reason: "Framework State is read-only",
            },
      ]),
    ),
    witness: {
      runtime_instance_id: "1a348fbe-3f8f-47e8-b4fc-561531759c42",
      variables_revision: revision,
    },
  };
}
