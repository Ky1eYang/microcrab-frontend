import type { Block } from "./types";
import { PLUGIN_META_TOOL_DEFINITION } from "../plugins/tool-hub";

export function todosFromHistory(
  blocks: Block[],
  durableResults: ReadonlyMap<string, unknown> = new Map(),
): Todo[] {
  let todos: Todo[] = [];
  for (const block of blocks) {
    if (
      block.tool?.name !== "update_todo_list" ||
      !block.clientInvocationId ||
      block.temporary ||
      block.tool.status !== "completed"
    )
      continue;
    try {
      const output =
        block.clientInvocationId && durableResults.has(block.clientInvocationId)
          ? durableResults.get(block.clientInvocationId)
          : (block.payload.structured ?? JSON.parse(block.payload.text));
      todos = parseTodos(output);
    } catch {
      /* Failed or missing results never replace the last successful list. */
    }
  }
  return todos;
}

export function sameToolSchema(
  left: unknown,
  right: unknown,
  depth = 0,
): boolean {
  if (left === right) return true;
  if (
    depth > 128 ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        sameToolSchema(value, right[index], depth + 1),
      )
    );
  const a = Object.keys(left).sort(),
    b = Object.keys(right).sort();
  return (
    a.length === b.length &&
    a.every(
      (key, index) =>
        key === b[index] &&
        sameToolSchema(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          depth + 1,
        ),
    )
  );
}
export interface ClientToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permissions: {
    tool: { kind: "exact"; value: string };
    action: "allow";
  }[];
  reclaimable: boolean;
  interaction?: { mode_pointer: string; wait_timeout_ms: number };
}
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}
export interface Question {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiple: boolean;
  custom: boolean;
}
export interface Todo {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "low" | "medium" | "high";
}
const string = { type: "string", minLength: 1, maxLength: 4000 };
export const CLIENT_TOOL_DEFINITIONS: ClientToolDefinition[] = [
  {
    name: "ask_user_question",
    description:
      "Ask the user questions with stable question and option IDs, multiple selection, custom answers and dismissal. blocking (default) pauses the turn execution budget while waiting; after five minutes a complete explicit recommended answer is used, otherwise the turn remains paused. deferred continues immediately and publishes the eventual answer in State. Recommended options must be marked explicitly; never invent a timeout answer. Automatic fallback results include source: timeout_recommendation and are not human confirmation.",
    permissions: [
      {
        tool: { kind: "exact", value: "ask_user_question" },
        action: "allow",
      },
    ],
    reclaimable: true,
    interaction: { mode_pointer: "/blocking_mode", wait_timeout_ms: 300000 },
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        blocking_mode: {
          type: "string",
          enum: ["blocking", "deferred"],
          default: "blocking",
          description:
            "Optional. Omit to use blocking. blocking waits with an independent five-minute interaction budget; deferred immediately continues and the eventual user answer is published in State. Mark recommended options explicitly for a complete blocking-timeout fallback; otherwise the turn pauses waiting. Empty and null values are invalid.",
        },
        questions: {
          type: "array",
          description:
            "Required nonempty list of questions. Each question has a stable ID; empty and null lists are invalid.",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            description:
              "One required question object. Null entries are invalid.",
            additionalProperties: false,
            required: ["id", "question"],
            properties: {
              id: {
                ...string,
                description:
                  "Required stable question ID, unique within this call. Empty and null values are invalid.",
              },
              header: {
                ...string,
                description:
                  "Optional short heading. Omit for no heading; empty and null values are invalid.",
              },
              question: {
                ...string,
                description:
                  "Required nonempty Markdown body: GFM, KaTeX, safe inline SVG, svg/mermaid/echarts fenced previews, and safe semantic HTML. Embed SVG here directly; no files, Shell or hosting needed. Scripts and arbitrary HTML are unsupported. Images load on click: absolute http(s) URLs or authorized local PNG/JPEG/GIF/WebP (active Host; 8 MiB; 4096px per dimension). Local image restrictions do not apply to embedded SVG. Options remain plain text.",
              },
              multiple: {
                type: "boolean",
                default: false,
                description:
                  "Optional. Omit or use false for one selection; true allows multiple options. Null is invalid.",
              },
              custom: {
                type: "boolean",
                default: true,
                description:
                  "Optional. Omit or use true to allow a custom answer; false restricts answers to options. Null is invalid.",
              },
              options: {
                type: "array",
                description:
                  "Optional choices. Omit or use [] for no predefined choices; custom answers must then be allowed. Null is invalid.",
                maxItems: 100,
                items: {
                  type: "object",
                  description:
                    "One selectable option. Null entries are invalid.",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: {
                      ...string,
                      description:
                        "Required stable option ID, unique within this question. Empty and null values are invalid.",
                    },
                    label: {
                      ...string,
                      description:
                        "Required option label shown to the user. Empty and null values are invalid.",
                    },
                    description: {
                      ...string,
                      description:
                        "Optional explanation of the choice. Omit for no explanation; empty and null values are invalid.",
                    },
                    recommended: {
                      type: "boolean",
                      default: false,
                      description:
                        "Optional. Omit or use false for no recommendation; true explicitly permits this option in a complete timeout fallback. Null is invalid.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "update_todo_list",
    description:
      "Replace the complete todo list. An empty list clears it. Supply at most 200 items; statuses are pending, in_progress, completed or cancelled. Priority is optional.",
    permissions: [
      {
        tool: { kind: "exact", value: "update_todo_list" },
        action: "allow",
      },
    ],
    reclaimable: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              id: string,
              content: string,
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
              priority: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
      },
    },
  },
  PLUGIN_META_TOOL_DEFINITION,
];
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Expected an object");
  return value;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000)
    throw Error(`Invalid ${name}`);
  return value;
}
function keys(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("Unexpected parameter");
}
export function parseQuestions(value: unknown): Question[] {
  const input = object(value);
  keys(input, ["questions", "blocking_mode"]);
  if (
    input.blocking_mode !== undefined &&
    !["blocking", "deferred"].includes(input.blocking_mode)
  )
    throw Error("Invalid question blocking mode");
  if (
    !Array.isArray(input.questions) ||
    !input.questions.length ||
    input.questions.length > 20
  )
    throw Error("Expected 1–20 questions");
  const ids = new Set<string>();
  return input.questions.map((raw: unknown) => {
    const q = object(raw);
    keys(q, ["id", "header", "question", "options", "multiple", "custom"]);
    const id = text(q.id, "question ID");
    if (ids.has(id)) throw Error("Duplicate question ID");
    ids.add(id);
    if (
      (q.multiple !== undefined && typeof q.multiple !== "boolean") ||
      (q.custom !== undefined && typeof q.custom !== "boolean")
    )
      throw Error("Invalid question flags");
    if (
      q.options !== undefined &&
      (!Array.isArray(q.options) || q.options.length > 100)
    )
      throw Error("Too many options");
    const optionIds = new Set<string>();
    const options = (q.options ?? []).map((raw: unknown) => {
      const o = object(raw);
      keys(o, ["id", "label", "description", "recommended"]);
      if (o.recommended !== undefined && typeof o.recommended !== "boolean")
        throw Error("Invalid option recommendation");
      const optionId = text(o.id, "option ID");
      if (optionIds.has(optionId)) throw Error("Duplicate option ID");
      optionIds.add(optionId);
      return {
        id: optionId,
        label: text(o.label, "option label"),
        recommended: o.recommended === true,
        ...(o.description === undefined
          ? {}
          : { description: text(o.description, "description") }),
      };
    });
    if (q.custom === false && !options.length)
      throw Error("A question without options must allow custom answers");
    return {
      id,
      question: text(q.question, "question"),
      ...(q.header === undefined ? {} : { header: text(q.header, "header") }),
      options,
      multiple: q.multiple === true,
      custom: q.custom !== false,
    };
  });
}
export function questionMode(value: unknown): "blocking" | "deferred" {
  parseQuestions(value);
  return object(value).blocking_mode === "deferred" ? "deferred" : "blocking";
}
export function recommendedQuestionResult(value: unknown) {
  const questions = parseQuestions(value);
  if (questionMode(value) === "deferred") return undefined;
  const answers = questions.map((q) => ({
    id: q.id,
    option_ids: q.options
      .filter((option) => option.recommended)
      .map((option) => option.id),
  }));
  if (
    answers.some(
      (answer, index) =>
        !answer.option_ids.length ||
        (!questions[index].multiple && answer.option_ids.length !== 1),
    )
  )
    return undefined;
  return {
    ...questionResult(questions, answers),
    source: "timeout_recommendation",
  };
}
export function parseTodos(value: unknown): Todo[] {
  const input = object(value);
  keys(input, ["todos"]);
  if (!Array.isArray(input.todos) || input.todos.length > 200)
    throw Error("Expected at most 200 todos");
  const ids = new Set<string>();
  return input.todos.map((raw: unknown) => {
    const t = object(raw);
    keys(t, ["id", "content", "status", "priority"]);
    if (
      !["pending", "in_progress", "completed", "cancelled"].includes(t.status)
    )
      throw Error("Invalid todo status");
    if (
      t.priority !== undefined &&
      !["low", "medium", "high"].includes(t.priority)
    )
      throw Error("Invalid todo priority");
    if (t.id !== undefined) {
      text(t.id, "todo ID");
      if (ids.has(t.id)) throw Error("Duplicate todo ID");
      ids.add(t.id);
    }
    return {
      ...(t.id === undefined ? {} : { id: t.id }),
      content: text(t.content, "todo content"),
      status: t.status,
      ...(t.priority === undefined ? {} : { priority: t.priority }),
    };
  });
}
export function questionResult(
  questions: Question[],
  answers: unknown,
  dismissed = false,
) {
  if (dismissed) return { dismissed: true, answers: [] };
  if (!Array.isArray(answers) || answers.length !== questions.length)
    throw Error("Answer every question");
  return {
    dismissed: false,
    answers: questions.map((q, index) => {
      const answer = object(answers[index]);
      if (answer.id !== q.id || !Array.isArray(answer.option_ids))
        throw Error("Invalid answer identity");
      const option_ids = [...new Set(answer.option_ids)] as string[];
      if (option_ids.some((id) => !q.options.some((o) => o.id === id)))
        throw Error("Unknown option");
      const custom =
        typeof answer.custom === "string" ? answer.custom.trim() : "";
      if (
        custom.length > 4000 ||
        (custom && !q.custom) ||
        (!option_ids.length && !custom) ||
        (!q.multiple && option_ids.length + Number(!!custom) > 1)
      )
        throw Error("Invalid answer selection");
      return { id: q.id, option_ids, ...(custom ? { custom } : {}) };
    }),
  };
}
