import type { ReactNode } from "react";
import { Scene, type SceneName } from "@/components/art";
import { Icons, type IconName } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

export interface EmptyStateProps {
  icon?: IconName;
  /** An illustrated scene in place of the icon: the empty court, the folded net, the shoreline, the blown-over umbrella. */
  scene?: SceneName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** The heading level the title takes, so the outline stays in order: 1 for a whole page, 2 directly under a page title, 3 (default) under a section heading. */
  level?: 1 | 2 | 3;
}

/** An honest empty or not-yet state. Left-aligned text; no marketing voice. The scene decorates beside the words, never under them. */
export function EmptyState({ icon = "info", scene, title, body, action, className, level = 3 }: EmptyStateProps) {
  const Icon = Icons[icon];
  const Heading = `h${level}` as const;
  return (
    <div className={cx("surface-inset rounded-md p-5 md:p-6", className)}>
      <div className={cx("flex gap-4", scene ? "flex-col sm:flex-row sm:items-start" : "items-start")}>
        {scene ? (
          <Scene name={scene} width={144} className="rounded-md sm:mt-0.5" />
        ) : (
          <span className="surface-raised flex size-11 shrink-0 items-center justify-center rounded-sm text-text-secondary">
            <Icon size={20} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <Heading className="type-subheading text-text-primary">{title}</Heading>
          {body ? <div className="mt-1 text-text-secondary">{body}</div> : null}
          {action ? <div className="mt-4">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
