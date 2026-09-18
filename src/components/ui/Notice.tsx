import type { ReactNode } from "react";
import { Icons, type IconComponent } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

/**
 * An inline notice for a state the user should read before acting: a form
 * error, a rate limit, a step that is not available yet. Tone pairs a color
 * with an icon and a role, never color alone.
 */
export type NoticeTone = "info" | "attention" | "error" | "success";

const TONE: Record<NoticeTone, { className: string; icon: IconComponent; role: "status" | "alert" }> = {
  info: { className: "surface-inset text-text-secondary", icon: Icons.info, role: "status" },
  success: { className: "border border-surf/40 bg-surf/10 text-text-primary", icon: Icons.circleCheck, role: "status" },
  attention: { className: "border border-fault/40 bg-fault/10 text-text-primary", icon: Icons.triangleAlert, role: "alert" },
  error: { className: "border border-fault/40 bg-fault/10 text-text-primary", icon: Icons.circleAlert, role: "alert" },
};

export interface NoticeProps {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  className?: string;
}

export function Notice({ tone = "info", title, children, className }: NoticeProps) {
  const spec = TONE[tone];
  const Icon = spec.icon;
  return (
    <div role={spec.role} className={cx("flex items-start gap-3 rounded-md p-3 md:p-4", spec.className, className)}>
      <span className={cx("mt-0.5 shrink-0", tone === "success" ? "text-surf" : tone === "info" ? "text-text-tertiary" : "text-fault")}>
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium text-text-primary">{title}</p> : null}
        {children ? <div className={cx(title && "mt-0.5")}>{children}</div> : null}
      </div>
    </div>
  );
}
