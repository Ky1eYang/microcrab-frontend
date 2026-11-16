import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { forceLinting, lintGutter, linter, lintKeymap } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import type { EditDiagnostic } from "./diagnostics";
import type { PromptField } from "../../client/settings";
import { promptHighlighting } from "./prompt-highlighting";

export type SourceEditorProps = {
  text: string;
  promptField?: PromptField;
  autoFocus?: boolean;
  json: boolean;
  wrap: boolean;
  lineNumbers: boolean;
  disabled: boolean;
  label: string;
  diagnostics: EditDiagnostic[];
  onChange: (text: string) => void;
};

const colors = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--syntax-key)" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-literal)" },
  { tag: tags.punctuation, color: "var(--syntax-muted)" },
]);

/** Own one editor for a captured draft. Reconfiguration retains selection, IME
 * composition and undo history; presentation controls never replace its text. */
export default function SourceEditor(props: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const config = useRef(new Compartment());
  const extensions = (value: SourceEditorProps) => [
    EditorState.readOnly.of(value.disabled),
    EditorView.editable.of(!value.disabled),
    EditorView.contentAttributes.of({
      "aria-label": value.label,
      "aria-multiline": "true",
      "aria-disabled": String(value.disabled),
      "data-testid": "content-viewer-editor",
      spellcheck: "false",
    }),
    value.wrap ? EditorView.lineWrapping : [],
    value.lineNumbers ? lineNumbers() : [],
    value.json ? json() : [],
    value.promptField ? promptHighlighting(value.promptField) : [],
  ];
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current.current.text,
        extensions: [
          EditorState.lineSeparator.of("\n"),
          history(),
          drawSelection(),
          highlightSpecialChars(),
          highlightActiveLine(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...lintKeymap,
          ]),
          syntaxHighlighting(colors),
          lintGutter(),
          linter((view) => {
            const supplied = current.current.diagnostics.flatMap((item) => {
              let from = item.from;
              let to = item.to;
              if (
                from === undefined &&
                item.path?.startsWith("/") &&
                current.current.json
              ) {
                let node = syntaxTree(view.state).topNode.firstChild;
                for (const key of item.path
                  .slice(1)
                  .split("/")
                  .map((part) =>
                    part.replace(/~1/g, "/").replace(/~0/g, "~"),
                  )) {
                  if (node?.name === "Object") {
                    const property = node
                      .getChildren("Property")
                      .find((entry) => {
                        const name = entry.getChild("PropertyName");
                        if (!name) return false;
                        try {
                          return (
                            JSON.parse(
                              view.state.sliceDoc(name.from, name.to),
                            ) === key
                          );
                        } catch {
                          return false;
                        }
                      });
                    node = property?.lastChild ?? null;
                  } else if (
                    node?.name === "Array" &&
                    /^(0|[1-9]\d*)$/.test(key)
                  ) {
                    const values = [];
                    for (
                      let child = node.firstChild;
                      child;
                      child = child.nextSibling
                    ) {
                      if (!["[", "]", ","].includes(child.name))
                        values.push(child);
                    }
                    node = values[Number(key)] ?? null;
                  } else {
                    node = null;
                    break;
                  }
                }
                if (node) {
                  from = node.from;
                  to = node.to;
                }
              }
              if (from === undefined) return [];
              from = Math.min(view.state.doc.length, Math.max(0, from));
              to = Math.min(view.state.doc.length, Math.max(from, to ?? from));
              return [
                {
                  from,
                  to,
                  severity: item.severity,
                  message: item.path
                    ? `${item.path}: ${item.message}`
                    : item.message,
                },
              ];
            });
            return [
              ...(current.current.json ? jsonParseLinter()(view) : []),
              ...supplied,
            ];
          }),
          config.current.of(extensions(current.current)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              current.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    if (current.current.autoFocus !== false) view.focus();
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    view.dispatch({ effects: config.current.reconfigure(extensions(props)) });
  }, [
    props.json,
    props.wrap,
    props.lineNumbers,
    props.disabled,
    props.label,
    props.promptField,
  ]);
  useEffect(() => {
    const view = editor.current;
    if (!view) return;
    forceLinting(view);
  }, [props.diagnostics]);
  return (
    <div
      ref={host}
      className="content-source-editor"
      data-testid="content-source-editor"
    />
  );
}
