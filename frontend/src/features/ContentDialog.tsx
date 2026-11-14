import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { trapFocus } from "../client/viewport";
import { t } from "../i18n";
import { Icon } from "./shared";
import { requestGuardedLeave } from "../client/document-leave";
import { ContentCloseGuardContext } from "./content-inspection/close-guard";

const ContentDialogContext = createContext(false);
let openDialogs = 0;
let previousBodyOverflow = "";
export const useInContentDialog = () => useContext(ContentDialogContext);

/** Controlled, top-layer content inspection. Mount to open; the owner closes it. */
export function ContentDialog({
  title,
  children,
  onClose,
  layout = "content",
  maximizable = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  layout?: "content" | "workspace";
  maximizable?: boolean;
}) {
  const [maximized, setMaximized] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const guards = useRef(new Set<(proceed?: () => void) => boolean>());
  const registerGuard = useCallback(
    (guard: (proceed?: () => void) => boolean) => {
      guards.current.add(guard);
      return () => {
        guards.current.delete(guard);
      };
    },
    [],
  );
  const requestClose = () => {
    requestGuardedLeave(
      () => (dialog.current?.isConnected ? [...guards.current] : []),
      () => {
        if (dialog.current?.isConnected) onClose();
      },
    );
  };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    element.showModal();
    if (openDialogs++ === 0)
      previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    return () => {
      element.close();
      if (--openDialogs === 0)
        document.body.style.overflow = previousBodyOverflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <ContentDialogContext.Provider value={true}>
      <ContentCloseGuardContext.Provider value={registerGuard}>
        <dialog
          ref={dialog}
          className="content-dialog"
          data-layout={layout}
          data-maximized={maximized || undefined}
          data-testid="content-dialog"
          aria-labelledby={headingId}
          aria-modal="true"
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            requestClose();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.defaultPrevented) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              requestClose();
            } else trapFocus(dialog.current, event.nativeEvent);
          }}
          onClick={(event) => {
            event.stopPropagation();
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              requestClose();
          }}
        >
          <header className="content-dialog-head">
            <h2 id={headingId}>{title}</h2>
            <div className="content-dialog-actions">
              {maximizable && (
                <button
                  type="button"
                  className="settings-close-btn"
                  data-testid="content-dialog-maximize"
                  aria-pressed={maximized}
                  aria-label={t(
                    maximized
                      ? "contentViewer.restoreSize"
                      : "contentViewer.maximize",
                  )}
                  title={t(
                    maximized
                      ? "contentViewer.restoreSize"
                      : "contentViewer.maximize",
                  )}
                  onClick={() => setMaximized((value) => !value)}
                >
                  <Icon name={maximized ? "minimize" : "maximize"} size={16} />
                </button>
              )}
              <button
                ref={close}
                type="button"
                className="settings-close-btn"
                aria-label={t("content.close")}
                title={t("content.close")}
                onClick={requestClose}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </header>
          <div
            className="content-dialog-body"
            data-testid="content-dialog-body"
          >
            {children}
          </div>
        </dialog>
      </ContentCloseGuardContext.Provider>
    </ContentDialogContext.Provider>,
    document.body,
  );
}
