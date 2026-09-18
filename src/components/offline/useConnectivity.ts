"use client";

import { useOffline } from "next/offline";
import { useEffect, useState } from "react";

/**
 * Whether this phone can reach Sideout right now. Next's `useOffline` flips
 * on the browser's `offline` event or a failed framework fetch (a captive
 * portal or dead upstream while WiFi still says on); `navigator.onLine`
 * covers a page that opened from the service worker's cache while already
 * offline, where no event will fire. Both read false on the server and during
 * hydration, so the first render never claims a state it cannot know.
 */
export function useConnectivity(): { offline: boolean } {
  const frameworkOffline = useOffline();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const read = () => setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    read();
    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    return () => {
      window.removeEventListener("online", read);
      window.removeEventListener("offline", read);
    };
  }, []);
  return { offline: frameworkOffline || !online };
}
