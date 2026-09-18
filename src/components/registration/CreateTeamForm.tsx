"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Form";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import { api, fieldIssues } from "@/lib/api-client";
import { phoneSchema } from "@/lib/phone";

/** Mirrors `createTeamSchema` on the server; the route validates again. */
const form = z.object({
  name: z.string().trim().min(2, "Give the team a name of at least two characters.").max(40, "Keep it under 40 characters."),
  partnerPhone: phoneSchema,
});

export function CreateTeamForm({ slug, tournamentName }: { slug: string; tournamentName: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [partnerPhone, setPartnerPhone] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const parsed = form.safeParse({ name, partnerPhone });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] = issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await api<{ id: string; name: string }>("/api/teams", { body: { tournamentSlug: slug, ...parsed.data } });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === "bad_request") {
        const issues = fieldIssues(result.error);
        if (Object.keys(issues).length) setErrors(issues);
        else setFailure(result.error.message);
      } else {
        setFailure(result.error.message);
      }
      return;
    }
    toast({ tone: "success", title: `${result.data.name} created`, body: "Your partner gets a text; the invite also waits on their profile." });
    router.push(`/t/${slug}/register`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="surface-raised space-y-4 rounded-md p-4 md:p-5">
        {failure ? (
          <Notice tone="error" title="Could not create the team">
            {failure}
          </Notice>
        ) : null}
        <Field label="Team name" error={errors.name} hint="How you will be announced on the sand. Surnames work: Delgado / Okafor.">
          {({ id, describedBy, invalid }) => (
            <TextInput id={id} name="name" autoComplete="off" maxLength={40} autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} placeholder="Delgado / Okafor" />
          )}
        </Field>
        <Field label="Partner's phone" error={errors.partnerPhone} hint="They sign in with this number to accept. If they do not have an account yet, one is created when they do.">
          {({ id, describedBy, invalid }) => (
            <TextInput id={id} name="partnerPhone" type="tel" inputMode="tel" autoComplete="off" value={partnerPhone} onChange={(e) => setPartnerPhone(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} placeholder="+1 555 010 0100" />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy} aria-busy={busy}>
          {busy ? "Creating…" : `Create team for ${tournamentName}`}
        </Button>
      </div>
    </form>
  );
}
