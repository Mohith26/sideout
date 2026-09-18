"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icons, type IconName } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

export interface ConsoleNavItem {
  href: string;
  label: string;
  icon: IconName;
  /** A figure to show beside the label, e.g. the dispute count. */
  badge?: number;
}

/** The console's own navigation: denser than the app tabs, one row, scrolls sideways on a phone. */
export function ConsoleNav({ items }: { items: readonly ConsoleNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Console" className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
      {items.map((item) => {
        const Icon = Icons[item.icon];
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "target inline-flex items-center gap-2 border-b-2 px-3 type-label whitespace-nowrap transition-colors duration-(--d-micro)",
              active ? "border-volt text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary",
            )}
          >
            <Icon size={16} />
            {item.label}
            {item.badge ? <span className="tabular rounded-full bg-fault/15 px-1.5 type-label text-fault">{item.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
