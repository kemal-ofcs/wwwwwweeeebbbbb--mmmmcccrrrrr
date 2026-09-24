import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface FeedbackBannerProps {
  children: ReactNode;
  onDismiss?: () => void;
  tone: "error" | "success" | "warning" | "info";
}

const toneClasses = {
  error: "border-error/30 bg-error-container text-on-error-container",
  success: "border-success/30 bg-success-container text-on-success-container",
  warning: "border-tertiary-fixed-dim bg-tertiary-fixed text-on-tertiary-fixed",
  info: "border-secondary/20 bg-secondary-fixed text-on-secondary-fixed-variant",
};

const toneIcon = {
  error: "alert",
  success: "check",
  warning: "alert",
  info: "alert",
} as const;

export function FeedbackBanner({
  children,
  onDismiss,
  tone,
}: FeedbackBannerProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border p-3 text-body-md ${toneClasses[tone]}`}
    >
      <Icon name={toneIcon[tone]} className="mt-px size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-8 rounded-md px-2 text-body-sm font-semibold hover:bg-black/5"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
