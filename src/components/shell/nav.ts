import type { IconName } from "@/components/ui/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** Primary navigation for everyone. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/events", label: "Events", icon: "calendar" },
  { href: "/impact", label: "Impact", icon: "heartHandshake" },
  { href: "/me", label: "Me", icon: "user" },
];

/** Added for an organizer session: the console is role-gated on the server, so the link is only shown to those who can open it. */
export const ORGANIZER_NAV_ITEM: NavItem = { href: "/organizer", label: "Console", icon: "console" };

export function navItemsFor(role: "player" | "organizer" | null): NavItem[] {
  return role === "organizer" ? [...NAV_ITEMS, ORGANIZER_NAV_ITEM] : [...NAV_ITEMS];
}

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/t/");
  if (href === "/me") return pathname === href || pathname.startsWith(`${href}/`) || pathname.startsWith("/teams/") || pathname === "/sign-in";
  return pathname === href || pathname.startsWith(`${href}/`);
}
