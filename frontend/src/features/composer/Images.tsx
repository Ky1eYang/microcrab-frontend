import { useEffect, useId, useRef, useState } from "react";
import { focusFirst, trapFocus } from "../../client/viewport";
import { t } from "../../i18n";
import { Icon } from "../shared";

interface ImageItem {
  id: string;
  name?: string;
  url?: string;
  sourceOmitted?: boolean;
}

function imageName(image: ImageItem) {
  return image.name || t("composer.images.alt", { name: "" }).trim();
}

function UnavailableImage({ image }: { image: ImageItem }) {
  return (
    <span
      className="image-unavailable"
      role="img"
      aria-label={`${imageName(image)}${t("common.fieldSep")}${t("composer.images.unavailable")}`}
      data-testid="image-unavailable"
    >
      {t("composer.images.unavailable")}
    </span>
  );
}

function ImagePreview({
  image,
  opener,
  onClose,
}: {
  image: ImageItem & { url: string };
  opener: HTMLElement;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [failedUrl, setFailedUrl] = useState<string>();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    // The browser top layer makes the underlying editor/conversation inert.
    // Close is controlled here so StrictMode cleanup cannot dismiss a reopened dialog.
    element.showModal();
    focusFirst(element);
    return () => {
      if (element.open) element.close();
      if (opener.isConnected) opener.focus();
    };
  }, [opener]);

  return (
    <dialog
      ref={dialog}
      className="image-preview-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      data-testid="image-preview-dialog"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "Tab") {
          event.stopPropagation();
          trapFocus(dialog.current, event.nativeEvent);
        }
      }}
    >
      <div className="image-preview-header">
        <h2 id={titleId}>{imageName(image)}</h2>
        <button
          type="button"
          className="image-preview-close"
          aria-label={t("composer.images.close")}
          title={t("composer.images.close")}
          onClick={onClose}
        >
          <Icon name="close" aria-hidden="true" />
        </button>
      </div>
      <div className="image-preview-content">
        {failedUrl === image.url ? (
          <UnavailableImage image={image} />
        ) : (
          <img
            src={image.url}
            alt={imageName(image)}
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(image.url)}
            data-testid="image-preview-original"
          />
        )}
      </div>
    </dialog>
  );
}

function ImageThumbnail({
  image,
  onPreview,
  onRemove,
}: {
  image: ImageItem;
  onPreview: (opener: HTMLElement) => void;
  onRemove?: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const unavailable =
    image.sourceOmitted || !image.url || failedUrl === image.url;
  const name = imageName(image);
  return (
    <div className="image-attachment" role="listitem">
      {unavailable ? (
        <UnavailableImage image={image} />
      ) : (
        <button
          type="button"
          className="image-thumbnail"
          aria-label={t("composer.images.preview", { name })}
          title={t("composer.images.preview", { name })}
          aria-haspopup="dialog"
          onClick={(event) => onPreview(event.currentTarget)}
          data-testid="image-preview-trigger"
        >
          <img
            src={image.url}
            alt={name}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailedUrl(image.url)}
          />
        </button>
      )}
      {image.name && (
        <span
          className="image-attachment-name"
          title={image.name}
          aria-label={image.name}
        >
          {image.name}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          className="image-remove"
          aria-label={t("composer.images.remove", { name })}
          title={t("composer.images.remove", { name })}
          onClick={onRemove}
          data-testid="composer-image-remove"
        >
          <Icon name="close" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ImageRail({
  images,
  onRemove,
  composer = false,
}: {
  images: ImageItem[];
  onRemove?: (id: string) => void;
  composer?: boolean;
}) {
  const [preview, setPreview] = useState<{ id: string; opener: HTMLElement }>();
  // Resolve against current props; the owner retains URL lifetime responsibility.
  const selected = images.find((image) => image.id === preview?.id);
  useEffect(() => {
    if (preview && (!selected?.url || selected.sourceOmitted)) {
      setPreview(undefined);
    }
  }, [preview, selected]);
  if (!images.length) return null;
  return (
    <>
      <div
        className={`image-rail${composer ? " composer-image-rail" : " conversation-image-rail"}`}
        role="list"
        data-testid={composer ? "composer-images" : "conversation-images"}
      >
        {images.map((image) => (
          <ImageThumbnail
            key={image.id}
            image={image}
            onPreview={(opener) => setPreview({ id: image.id, opener })}
            onRemove={onRemove ? () => onRemove(image.id) : undefined}
          />
        ))}
      </div>
      {preview && selected?.url && !selected.sourceOmitted && (
        <ImagePreview
          image={{ ...selected, url: selected.url }}
          opener={preview.opener}
          onClose={() => setPreview(undefined)}
        />
      )}
    </>
  );
}

export function ComposerImages({
  images,
  onRemove,
}: {
  images: { id: string; name: string; mediaType: string; previewUrl: string }[];
  onRemove: (id: string) => void;
}) {
  return (
    <ImageRail
      composer
      images={images.map((image) => ({
        id: image.id,
        name: image.name,
        url: image.previewUrl,
      }))}
      onRemove={onRemove}
    />
  );
}

export function ConversationImages({
  images,
}: {
  images: {
    partId?: string;
    mime?: string;
    url?: string;
    name?: string;
    sourceOmitted?: boolean;
  }[];
}) {
  return (
    <ImageRail
      images={images.map((image, index) => ({
        ...image,
        id: image.partId || `image-${index}`,
      }))}
    />
  );
}
