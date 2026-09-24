import type { ReactNode } from "react";

export type StatusTone = "info" | "success" | "warning" | "danger" | "neutral";

// Pasangan warna dari DESIGN.md bagian 4; semuanya >= 7:1.
const toneClasses: Record<StatusTone, string> = {
  info: "bg-secondary-fixed text-on-secondary-fixed-variant",
  success: "bg-success-container text-on-success-container",
  warning: "bg-tertiary-fixed text-on-tertiary-fixed",
  danger: "bg-error-container text-on-error-container",
  neutral: "bg-surface-container text-on-surface-variant",
};

interface StatusBadgeProps {
  children: ReactNode;
  className?: string;
  tone?: StatusTone;
}

export function StatusBadge({
  children,
  className = "",
  tone = "neutral",
}: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-label-caps uppercase ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
