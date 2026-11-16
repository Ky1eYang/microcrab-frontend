import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { PromptField } from "../../client/settings";

export const HELPER_BINDINGS: Record<
  Exclude<PromptField, "system_template" | "client_prompt">,
  readonly string[]
> = {
  compact_template: ["user_input"],
  auto_compact_template: [],
  rename_template: ["user_input"],
  action_review_template: ["tool", "tool_name", "tool_args", "user_input"],
};

/** Presentation hints only. Core remains the authoritative Tera2/helper validator. */
export function promptHighlighting(field: PromptField): Extension {
  const decorate = (view: EditorView) => {
    if (field === "client_prompt") return Decoration.none;
    const source = view.state.doc.toString();
    const marks: { from: number; to: number; kind: string }[] = [];
    const expression =
      /{{[\s\S]*?}}|{%[\s\S]*?%}|{#[\s\S]*?#}|{{[^\n]*$|{%[^\n]*$|{#[^\n]*$|}}|%}|#}/gm;
    let loopDepth = 0;
    for (const match of source.matchAll(expression)) {
      const from = match.index!;
      const text = match[0];
      if (field !== "system_template") {
        const name = /^{{\s*(\w+)\s*}}$/.exec(text)?.[1];
        const valid =
          name !== undefined && HELPER_BINDINGS[field].includes(name);
        marks.push({
          from,
          to: from + text.length,
          kind: valid ? "variable" : "invalid",
        });
        continue;
      }
      const statement = /^{%[-+]?\s*(\w+)/.exec(text)?.[1];
      const nestedLoop = statement === "for" && loopDepth > 0;
      if (statement === "for") loopDepth++;
      if (statement === "endfor") loopDepth = Math.max(0, loopDepth - 1);
      // This is an advisory scan, not a second implementation of Core's grammar.
      // Function-like tokens inside quoted authored strings are ordinary data.
      const unquoted = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
      const prohibited =
        (statement !== undefined &&
          !["if", "elif", "else", "endif", "for", "endfor"].includes(
            statement,
          )) ||
        nestedLoop ||
        (statement === "for" &&
          !/^{%[-+]?\s*for\s+(?:rule\s+in\s+agent\.rules|hint\s+in\s+agent\.hints)\s*[-+]?%}$/.test(
            text,
          )) ||
        (!text.startsWith("{#") &&
          ([...unquoted.matchAll(/\|\s*([A-Za-z_]\w*)/g)].some(
            (filter) =>
              ![
                "safe",
                "length",
                "default",
                "json_encode",
                "upper",
                "lower",
                "trim",
                "capitalize",
                "title",
                "str",
                "int",
                "float",
                "first",
                "last",
              ].includes(filter[1]),
          ) ||
            [...unquoted.matchAll(/\b[A-Za-z_]\w*\s*\(/g)].some(
              (call) => !/\|\s*$/.test(unquoted.slice(0, call.index)),
            )));
      marks.push({
        from,
        to: from + text.length,
        kind: prohibited ? "invalid" : "delimiter",
      });
      for (const token of text.matchAll(
        /\b(agent|client_prompt|if|else|elif|endif|for|in|endfor|is|defined|and|or|not|true|false|safe)\b/g,
      )) {
        const start = from + token.index!;
        marks.push({
          from: start,
          to: start + token[0].length,
          kind: ["agent", "client_prompt"].includes(token[0])
            ? "variable"
            : "keyword",
        });
      }
      if (!/^(?:{{|{%|{#)/.test(text) || !/}}$|%}$|#}$/.test(text))
        marks.push({ from, to: from + text.length, kind: "invalid" });
    }
    return Decoration.set(
      marks
        .sort((a, b) => a.from - b.from || b.to - a.to)
        .map(({ from, to, kind }) =>
          Decoration.mark({ class: `prompt-token-${kind}` }).range(from, to),
        ),
      true,
    );
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        if (update.docChanged) this.decorations = decorate(update.view);
      }
    },
    { decorations: (value) => value.decorations },
  );
}
