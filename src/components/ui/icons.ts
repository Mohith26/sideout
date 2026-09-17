/**
 * The single icon set (lucide, 1.5px stroke). Import icons from here so the
 * stroke weight and size defaults are set once; never from lucide-react directly.
 */
import {
  Activity,
  ArrowRight,
  Ban,
  Calendar,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  ExternalLink,
  Gift,
  GitBranch,
  HandCoins,
  HeartHandshake,
  House,
  Hourglass,
  Info,
  LayoutGrid,
  MapPin,
  Medal,
  Radio,
  Table2,
  TriangleAlert,
  Trophy,
  Users,
  X,
  type LucideProps,
} from "lucide-react";
import { createElement, type ComponentType } from "react";

export type IconComponent = ComponentType<LucideProps>;

function withDefaults(Icon: IconComponent): IconComponent {
  const Wrapped: IconComponent = (props) =>
    createElement(Icon, { strokeWidth: 1.5, size: 18, "aria-hidden": true, focusable: false, ...props });
  Wrapped.displayName = `Icon(${Icon.displayName ?? "Icon"})`;
  return Wrapped;
}

export const Icons = {
  activity: withDefaults(Activity),
  arrowRight: withDefaults(ArrowRight),
  ban: withDefaults(Ban),
  calendar: withDefaults(Calendar),
  check: withDefaults(Check),
  chevronRight: withDefaults(ChevronRight),
  circleAlert: withDefaults(CircleAlert),
  circleCheck: withDefaults(CircleCheck),
  circleDashed: withDefaults(CircleDashed),
  clock: withDefaults(Clock),
  externalLink: withDefaults(ExternalLink),
  gift: withDefaults(Gift),
  bracket: withDefaults(GitBranch),
  handCoins: withDefaults(HandCoins),
  heartHandshake: withDefaults(HeartHandshake),
  home: withDefaults(House),
  hourglass: withDefaults(Hourglass),
  info: withDefaults(Info),
  grid: withDefaults(LayoutGrid),
  mapPin: withDefaults(MapPin),
  medal: withDefaults(Medal),
  radio: withDefaults(Radio),
  table: withDefaults(Table2),
  triangleAlert: withDefaults(TriangleAlert),
  trophy: withDefaults(Trophy),
  users: withDefaults(Users),
  x: withDefaults(X),
} as const satisfies Record<string, IconComponent>;

export type IconName = keyof typeof Icons;
