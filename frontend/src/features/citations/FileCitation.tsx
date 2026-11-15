import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { ContentDialog } from "../ContentDialog";
import { Icon } from "../shared";
import { t } from "../../i18n";
import type { CitationScope } from "./context";
import { classifyCitation } from "./parser";
import "./citations.css";

function FileCitation({
  scope,
  href,
  children,
}: {
  scope: CitationScope;
  href: string;
  children: ReactNode;
}) {
  const local = classifyCitation(href)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState<string>();
  const operation = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current.clear();
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, []);
  const close = () => {
    if (image) {
      URL.revokeObjectURL(image);
      urls.current.delete(image);
    }
    setImage(undefined);
  };
  const open = async () => {
    if (operation.current) {
      operation.current.abort();
      return;
    }
    if (!scope.current()) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      const blob = await scope.read(
        {
          sessionId: scope.sessionId,
          messageId: scope.messageId,
          historyLineage: scope.historyLineage,
          childSessionId: scope.childSessionId,
          href,
        },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted || !scope.current())
        return;
      const url = URL.createObjectURL(blob);
      urls.current.add(url);
      if (
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          blob.type,
        )
      )
        setImage(url);
      else {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = local.filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          urls.current.delete(url);
          timers.current.delete(timer);
        }, 1000);
        timers.current.add(timer);
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && scope.current())
        setError(
          failure instanceof Error ? failure.message : t("citation.failed"),
        );
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="file-citation"
        data-testid="file-citation"
        title={t(busy ? "citation.cancel" : "citation.open", {
          path: local.path,
        })}
        aria-label={t(busy ? "citation.cancel" : "citation.open", {
          path: local.path,
        })}
        aria-busy={busy}
        onClick={() => void open()}
      >
        <Icon name={busy ? "close" : "file"} size={12} />
        <span>{children || local.filename}</span>
      </button>
      {error && (
        <span className="file-citation-error" role="alert">
          {error}
        </span>
      )}
      {image && scope.current() && (
        <ContentDialog
          title={local.filename}
          onClose={close}
          layout="workspace"
        >
          <div className="citation-lightbox" data-testid="citation-lightbox">
            <img src={image} alt={local.filename} />
            <a href={image} download={local.filename}>
              {t("citation.download")}
            </a>
          </div>
        </ContentDialog>
      )}
    </>
  );
}
function key(scope: CitationScope, href: string) {
  return JSON.stringify([
    scope.owner,
    scope.sessionId,
    scope.childSessionId,
    scope.historyLineage,
    scope.messageId,
    href,
  ]);
}
/** Factories run only for opted-in finalized assistant Markdown. External images
 * become ordinary links so this scope never issues eager render-time requests. */
export function citationComponents(scope: CitationScope): Components {
  return {
    a: ({ node, href, children }) => {
      const cited = node?.properties["data-citation-href"];
      if (typeof cited === "string")
        return (
          <FileCitation key={key(scope, cited)} scope={scope} href={cited}>
            {children}
          </FileCitation>
        );
      return href && /^(?:https?:|mailto:|tel:|ftp:|#|\/\/)/i.test(href) ? (
        <a href={href}>{children}</a>
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ node, src, alt }) => {
      const cited = node?.properties["data-citation-href"];
      if (typeof cited === "string")
        return (
          <FileCitation key={key(scope, cited)} scope={scope} href={cited}>
            {alt}
          </FileCitation>
        );
      return typeof src === "string" && /^https?:/i.test(src) ? (
        <a href={src}>{alt}</a>
      ) : (
        <span>{alt}</span>
      );
    },
  };
}
