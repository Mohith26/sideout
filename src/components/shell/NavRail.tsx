"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Palm, SkyBand, WaveDivider } from "@/components/art";
import { Icons } from "@/components/ui/icons";
import { isActivePath, type NavItem } from "@/components/shell/nav";
import { Wordmark } from "@/components/shell/Wordmark";
import { cx } from "@/lib/cx";

/** Left rail at 1280px and up: the sky band over the wordmark, the links, a palm at the foot. */
export function NavRail({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-navrail flex-col border-r border-border-subtle bg-bg-base xl:flex">
      <div className="relative">
        <SkyBand variant="rail" />
        <div className="relative flex h-16 items-center px-6">
          <Wordmark />
        </div>
        <WaveDivider fill="base" height={12} className="relative" />
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
                    "target flex items-center gap-3 rounded-full px-4 font-semibold transition-colors duration-(--d-micro)",
                    active ? "bg-bg-raised text-text-primary shadow-[0_2px_0_0_var(--border-subtle)]" : "text-text-secondary hover:bg-bg-raised hover:text-text-primary",
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
      <div className="mt-auto">
        <div className="relative h-24">
          <Palm height={92} lean={-1} className="absolute right-5 bottom-0" />
        </div>
        <WaveDivider fill="foam" height={12} line drift={false} />
        <div className="bg-bg-inset px-6 pt-2 pb-5 type-label text-text-tertiary">Charity beach volleyball</div>
      </div>
    </aside>
  );
}
