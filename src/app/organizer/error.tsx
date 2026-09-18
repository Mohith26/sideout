"use client";

import { RouteError } from "@/components/shell/RouteError";

/** A console page that fails keeps the console navigation. */
export default function ConsoleRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} where="the console" />;
}
