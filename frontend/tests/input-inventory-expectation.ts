import { readFileSync } from "node:fs";

/** Expected governed inventory for the unmodified assembled default plugins.
 * Read the exact artifact pin lazily so rebuilding guest assets cannot stale tests. */
export function expectedPluginVariables(
  installed = false,
  set: Record<string, unknown> = {},
) {
  const index = installed
    ? JSON.parse(
        readFileSync(
          new URL("../public/plugins/current.json", import.meta.url),
          "utf8",
        ),
      )
    : null;
  const plugin = index?.plugins.find(
    (entry: { id: string }) => entry.id === "microcrab.mcp-bridge",
  );
  if (installed && !plugin)
    throw Error("Assembled MCP plugin is required by the input fixture");
  return {
    set,
    scoped_set: [
      {
        name: "plugins",
        value: installed
          ? [
              {
                id: "microcrab.mcp-bridge",
                name: "MCP bridge",
                version: "0.4.0",
                description:
                  "Multi-server MCP tools. List or describe tools, then call with pin and arguments. Expired references require describe again; never retry uncertain effects.",
                artifact: plugin.sha256,
              },
            ]
          : [],
        visibility: "visible",
        persistence: "persisted",
        editors: ["client"],
      },
    ],
    remove: [],
  };
}
