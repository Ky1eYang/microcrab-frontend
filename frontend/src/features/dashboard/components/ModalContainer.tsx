import React, { useEffect, useId, useRef } from "react";

export interface ModalContainerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onConfirm?: () => void;
  confirmText?: string;
  cancelText?: string;
  confirmDisabled?: boolean;
  maxWidth?: string;
}

export const ModalContainer: React.FC<ModalContainerProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  onConfirm,
  confirmText = "确认",
  cancelText = "取消",
  confirmDisabled = false,
  maxWidth = "max-w-lg",
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="sb-native-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className={`sb-modal-box sb-card ${maxWidth}`}>
        <div className="sb-modal-header">
          <h3 id={titleId} className="sb-modal-title">
            {title}
          </h3>
          <button
            type="button"
            className="sb-modal-close"
            onClick={onClose}
            aria-label={cancelText}
          >
            ✕
          </button>
        </div>

        <div className="sb-modal-body">{children}</div>

        <div className="sb-modal-footer">
          {footer ? (
            footer
          ) : (
            <div className="sb-modal-btn-row">
              <button
                type="button"
                className="sb-btn sb-btn-ghost"
                onClick={onClose}
              >
                {cancelText}
              </button>
              {onConfirm && (
                <button
                  type="button"
                  className="sb-btn sb-btn-primary"
                  onClick={onConfirm}
                  disabled={confirmDisabled}
                >
                  {confirmText}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
};
