"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icons } from "@/components/ui/icons";
import { isActivePath, NAV_ITEMS } from "@/components/shell/nav";
import { cx } from "@/lib/cx";

/** Mobile bottom navigation with safe-area insets. Hidden at the rail breakpoint. */
export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-bg-base pb-safe xl:hidden"
    >
      <ul className="mx-auto flex h-tabbar max-w-content items-stretch">
        {NAV_ITEMS.map((item) => {
          const Icon = Icons[item.icon];
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href} className="flex flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "target flex flex-1 flex-col items-center justify-center gap-1 type-label transition-colors duration-(--d-micro)",
                  active ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary",
                )}
              >
                <Icon size={20} className={cx(active && "text-volt")} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
