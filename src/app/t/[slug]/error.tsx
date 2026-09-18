"use client";

import { RouteError } from "@/components/shell/RouteError";

/** A tab that fails keeps the event header above it. */
export default function TournamentRouteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} where="this event" />;
}
