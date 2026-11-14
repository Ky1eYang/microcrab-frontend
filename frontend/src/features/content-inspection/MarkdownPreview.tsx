import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeText, syntaxForLanguage } from "./CodeText";

/** Inspection never loads images or interprets raw HTML. */
export default function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="markdown-body markdown-content content-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          code: ({ className, children }) => {
            const language = /(?:^|\s)language-([^\s]+)/.exec(
              className ?? "",
            )?.[1];
            return language ? (
              <CodeText
                text={String(children)}
                kind={syntaxForLanguage(language)}
              />
            ) : (
              <code>{children}</code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
