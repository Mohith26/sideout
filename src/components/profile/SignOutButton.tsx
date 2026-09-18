"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api-client";

export function SignOutButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      disabled={busy}
      aria-busy={busy}
      iconStart={<Icons.logOut size={16} />}
      onClick={async () => {
        setBusy(true);
        const result = await api<{ signedOut: boolean }>("/api/auth/logout", { method: "POST", body: {} });
        setBusy(false);
        if (!result.ok) {
          toast({ tone: "error", title: "Could not sign out", body: result.error.message });
          return;
        }
        router.replace("/");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
