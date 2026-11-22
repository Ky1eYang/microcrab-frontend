import { jsonLanguage } from "@codemirror/lang-json";
import type { ApiClient } from "../../client/api";

export interface PromptSelection {
  sessionId: string;
  lineage: string;
  epoch: number;
}

export type PromptResult =
  | { status: "available"; system: string; tools: readonly DeclaredTool[] }
  | { status: "stale" | "unavailable" | "responseLimit" | "failed" };

export interface DeclaredTool {
  name: string;
  description: string;
  /** Original JSON value, including exact number spellings and key order. */
  parameters: string;
}

export type ReadFrozenPrompt = (
  selection: PromptSelection,
  signal: AbortSignal,
) => Promise<PromptResult>;

const MAX_RESPONSE_BYTES = 256 * 1024;

async function readBody(response: Response) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  if (!reader) throw Error("Missing frozen prompt body");
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw Error("Frozen prompt body exceeds its limit");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function decodePrompt(text: string, selection: PromptSelection): PromptResult {
  // Use the syntax tree to preserve the schema's raw JSON. Parsing it into JS
  // numbers (or stringifying it again) can round integers and reorder keys.
  const tree = jsonLanguage.parser.parse(text);
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) return { status: "failed" };
  } while (cursor.next());

  const root = tree.topNode.firstChild;
  if (root?.name !== "Object") return { status: "failed" };
  const slice = ({ from, to }: { from: number; to: number }) =>
    text.slice(from, to);
  function fields(node: NonNullable<typeof root>) {
    const result = new Map<string, NonNullable<typeof root>>();
    for (const property of node.getChildren("Property")) {
      const key = JSON.parse(slice(property.firstChild!)) as string;
      if (result.has(key)) return undefined;
      result.set(key, property.lastChild!);
    }
    return result;
  }
  const envelope = fields(root);
  if (!envelope) return { status: "failed" };
  const str = (node: typeof root | undefined): string | undefined =>
    node?.name === "String" ? JSON.parse(slice(node)) : undefined;
  const sessionId = str(envelope.get("session_id"));
  const lineage = str(envelope.get("history_lineage"));
  const epoch = envelope.get("epoch");
  if (!sessionId || !lineage || epoch?.name !== "Number")
    return { status: "failed" };
  if (
    sessionId !== selection.sessionId ||
    lineage !== selection.lineage ||
    slice(epoch) !== String(selection.epoch)
  )
    return { status: "stale" };

  const status = str(envelope.get("status"));
  if (status === "unavailable") {
    return {
      status:
        str(envelope.get("reason")) === "response_limit"
          ? "responseLimit"
          : "unavailable",
    };
  }
  const system = str(envelope.get("system"));
  const declarations = envelope.get("tools");
  if (
    status !== "available" ||
    system === undefined ||
    declarations?.name !== "Array"
  )
    return { status: "failed" };
  const tools: DeclaredTool[] = [];
  for (let node = declarations.firstChild; node; node = node.nextSibling) {
    if (
      node.type.isAnonymous ||
      node.type.isSkipped ||
      ["[", "]", ","].includes(node.name)
    )
      continue;
    if (node.name !== "Object") return { status: "failed" };
    const tool = fields(node);
    if (!tool) return { status: "failed" };
    const name = str(tool.get("name"));
    const description = str(tool.get("description"));
    const parameters = tool.get("parameters");
    if (name === undefined || description === undefined || !parameters)
      return { status: "failed" };
    tools.push({ name, description, parameters: slice(parameters) });
  }
  return { status, system, tools };
}

export async function readFrozenPrompt(
  api: Pick<ApiClient, "url" | "tabId">,
  selection: PromptSelection,
  signal: AbortSignal,
): Promise<PromptResult> {
  const { sessionId, lineage, epoch } = selection;
  const url = new URL(
    api.url(`api/v1/sessions/${encodeURIComponent(sessionId)}/history/prompt`),
  );
  url.search = new URLSearchParams({
    history_lineage: lineage,
    epoch: String(epoch),
  }).toString();
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json", "x-client-tab-id": api.tabId },
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
  if (response.status === 409) {
    // Only this code denotes stale evidence; the server can also be busy.
    const result = JSON.parse(await readBody(response));
    signal.throwIfAborted();
    return {
      status: result?.error?.code === "stale_history" ? "stale" : "failed",
    };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if ([401, 403, 404].includes(response.status))
      return { status: "unavailable" };
    return { status: "failed" };
  }
  const text = await readBody(response);
  signal.throwIfAborted();
  return decodePrompt(text, selection);
}
