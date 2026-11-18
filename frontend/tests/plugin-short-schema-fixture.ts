// Frozen base45e5254 schema snapshot; never derive this fixture from the live schema.
export const previousShortArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["plugin", "action", "artifact"],
  properties: {
    plugin: { type: "string", maxLength: 128 },
    artifact: { type: "string", pattern: "^[a-f0-9]{16}([a-f0-9]{48})?$" },
    action: { type: "string", enum: ["list", "describe", "call"] },
    server: { type: "string", maxLength: 64 },
    tool: { type: "string", maxLength: 256 },
    cursor: { type: "string", maxLength: 4096 },
    limit: { type: "integer", minimum: 1, maximum: 32 },
    pin: { type: "string", pattern: "^[a-f0-9]{16}$" },
    schema_pin: { type: "string", maxLength: 128 },
    config_pin: { type: "string", maxLength: 128 },
    arguments: { type: "object" },
  },
  oneOf: [
    { properties: { action: { enum: ["list"] }, pin: false } },
    {
      properties: { action: { enum: ["describe"] }, pin: false },
      required: ["server"],
    },
    {
      properties: {
        action: { enum: ["call"] },
        server: false,
        tool: false,
        config_pin: false,
        schema_pin: false,
      },
      required: ["pin"],
    },
    {
      properties: { action: { enum: ["call"] }, pin: false },
      required: ["server", "tool", "config_pin", "schema_pin"],
    },
  ],
};
