"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SandEdge } from "@/components/art";
import { Icons } from "@/components/ui/icons";
import { isActivePath, type NavItem } from "@/components/shell/nav";
import { cx } from "@/lib/cx";

/** Mobile bottom navigation with safe-area insets and a sand-grain top edge. Hidden at the rail breakpoint. */
export function TabBar({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-bg-raised pb-safe xl:hidden"
    >
      <SandEdge height={10} className="pointer-events-none absolute inset-x-0 -top-[10px]" />
      <ul className="mx-auto flex h-tabbar max-w-content items-stretch">
        {items.map((item) => {
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
