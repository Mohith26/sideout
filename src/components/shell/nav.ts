import type { IconName } from "@/components/ui/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Primary navigation. Player and organizer surfaces join this list in later phases. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/events", label: "Events", icon: "calendar" },
  { href: "/impact", label: "Impact", icon: "heartHandshake" },
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/t/");
  return pathname === href || pathname.startsWith(`${href}/`);
}
