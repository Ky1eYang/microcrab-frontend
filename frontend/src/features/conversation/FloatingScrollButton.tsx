import { t } from "../../i18n";
import type React from "react";
import { useEffect, useState, useCallback, useRef } from "react";
import { Icon } from "../../shell/Icon";

export interface FloatingScrollButtonProps {
  /** Conversation owns follow intent; geometry only derives button visibility. */
  following?: boolean;
  /** 绑定的目标滚动容器引用，未传时默认监听 window */
  targetRef?: React.RefObject<HTMLElement | null>;
  /** 触发显示的离底距离阈值（默认 85px） */
  threshold?: number;
  /** 点击滚动后的回调，如重置 following/stick 标志位 */
  onScrollToBottom?: () => void;
  /** 自定义提示文本（用于 aria-label 与 title tooltip） */
  tooltip?: string;
  /** 额外的自定义样式类名 */
  className?: string;
}

/**
 * 中等尺寸 (Medium) + 圆形外边框 (Circle + Outlined) + 中性色 (OutlinedNeutral) 的悬浮控制按钮
 */
export function FloatingScrollButton({
  targetRef,
  following = false,
  threshold = 85,
  onScrollToBottom,
  tooltip = t("conversation.toBottom"),
  className = "",
}: FloatingScrollButtonProps) {
  const [visible, setVisible] = useState(false);
  const rafId = useRef<number | null>(null);

  const checkScroll = useCallback(() => {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
    }

    rafId.current = requestAnimationFrame(() => {
      const el = targetRef?.current;
      if (!el) {
        // 若监听 window
        const scrollY = window.scrollY || document.documentElement.scrollTop;
        const maxScroll =
          document.documentElement.scrollHeight - window.innerHeight;
        const distanceToBottom = maxScroll - scrollY;
        const hasOverflow = maxScroll > 30;
        setVisible(hasOverflow && distanceToBottom > threshold);
        return;
      }

      const { scrollHeight, scrollTop, clientHeight } = el;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      // 只有在内容有实际溢出并向上翻看超过阈值时才显示
      const hasOverflow = scrollHeight - clientHeight > 30;
      setVisible(hasOverflow && distanceToBottom > threshold);
    });
  }, [targetRef, threshold]);

  useEffect(() => {
    const el = targetRef?.current;
    if (el) {
      el.addEventListener("scroll", checkScroll, { passive: true });
      // 初始与内容高度变化时检查
      checkScroll();
      const observer = new ResizeObserver(checkScroll);
      observer.observe(el);
      const inner = el.querySelector(".transcript-inner");
      if (inner) observer.observe(inner);
      return () => {
        observer.disconnect();
        el.removeEventListener("scroll", checkScroll);
        if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      };
    } else {
      window.addEventListener("scroll", checkScroll, { passive: true });
      checkScroll();
      return () => {
        window.removeEventListener("scroll", checkScroll);
        if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      };
    }
  }, [targetRef, checkScroll, following]);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // 滚动交给宿主回调，避免这里再 scrollTo 一次把平滑滚动打断。
    onScrollToBottom?.();
  };

  return (
    <button
      type="button"
      className={`floating-btn floating-btn--circle floating-btn--outlined-neutral floating-btn--medium ${
        visible && !following ? "is-visible" : "is-hidden"
      } ${className}`.trim()}
      onClick={handleClick}
      aria-label={tooltip}
      title={tooltip}
      tabIndex={visible && !following ? 0 : -1}
    >
      <span className="floating-btn__icon-wrapper">
        <Icon name="arrow-down" size={18} strokeWidth="2.2" />
      </span>
    </button>
  );
}
