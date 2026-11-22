import { ComposerHostNotice } from "./ComposerHostNotice";
import { t } from "../../i18n";
import { useAppSelector } from "../../state";
import { RoundLimitPrompt } from "../RoundLimitPrompt";
import { BrowserHostTakeoverNotice } from "./BrowserHostTakeoverNotice";
import "../../styles/composer-notification-dock.css";

/** Scrolling this region leaves the transcript's reading position alone. */
export function ComposerNotificationDock({
  showHostNotice,
}: {
  showHostNotice: boolean;
}) {
  const locale = useAppSelector((state) => state.resolvedLocale);
  return (
    <div
      className="composer-notification-dock"
      data-testid="composer-notification-dock"
      role="region"
      aria-label={t("composer.notifications", undefined, locale)}
      tabIndex={0}
    >
      <BrowserHostTakeoverNotice />
      <RoundLimitPrompt />
      {showHostNotice && <ComposerHostNotice inDock />}
    </div>
  );
}
