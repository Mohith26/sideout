"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icons } from "@/components/ui/icons";
import { isActivePath, type NavItem } from "@/components/shell/nav";
import { Wordmark } from "@/components/shell/Wordmark";
import { cx } from "@/lib/cx";

/** Left rail at 1280px and up. */
export function NavRail({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-navrail flex-col border-r border-border-subtle bg-bg-base xl:flex">
      <div className="flex h-16 items-center px-6">
        <Wordmark />
      </div>
      <nav aria-label="Primary" className="flex-1 px-3 py-2">
        <ul className="space-y-1">
          {items.map((item) => {
            const Icon = Icons[item.icon];
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "target flex items-center gap-3 rounded-sm px-3 font-medium transition-colors duration-(--d-micro)",
                    active ? "bg-bg-raised text-text-primary" : "text-text-secondary hover:bg-bg-raised hover:text-text-primary",
                  )}
                >
                  <Icon size={18} className={cx(active && "text-volt")} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="px-6 py-5 type-label text-text-tertiary">Charity beach volleyball</div>
    </aside>
  );
}
