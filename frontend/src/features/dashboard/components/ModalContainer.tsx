import React, { useEffect } from "react";

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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="sb-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={`sb-modal-box sb-card ${maxWidth}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="sb-modal-header">
          <h3 className="sb-modal-title">{title}</h3>
          <button
            type="button"
            className="sb-modal-close"
            onClick={onClose}
            aria-label="Close"
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
    </div>
  );
};
