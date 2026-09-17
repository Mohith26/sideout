import type { ReactNode } from "react";
import { Icons, type IconName } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** An honest empty or not-yet state. Left-aligned text; no marketing voice. */
export function EmptyState({ icon = "info", title, body, action, className }: EmptyStateProps) {
  const Icon = Icons[icon];
  return (
    <div className={cx("surface-inset rounded-md p-5 md:p-6", className)}>
      <div className="flex items-start gap-4">
        <span className="surface-raised flex size-11 shrink-0 items-center justify-center rounded-sm text-text-secondary">
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="type-subheading text-text-primary">{title}</h3>
          {body ? <div className="mt-1 text-text-secondary">{body}</div> : null}
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
