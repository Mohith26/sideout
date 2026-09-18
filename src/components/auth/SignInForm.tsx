"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Form";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { api, errorDetailCode, fieldIssues, type ApiResult } from "@/lib/api-client";
import type { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import { maskPhone, phoneSchema } from "@/lib/phone";

/**
 * Two steps on one screen: phone → code (plus a display name the first time a
 * phone signs in). Every failure the routes can answer has a state here — a
 * rate limit shows how long to wait, a deployment with no SMS provider says so
 * rather than pretending a text went out, and a wrong code never reveals
 * whether the phone is known.
 */

const phoneForm = z.object({ phone: phoneSchema });
const codeForm = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the six digits from the text."),
  displayName: z.string().trim().min(2, "At least two characters.").max(60).optional(),
});

type RequestData = { expiresAt: number; devCode?: string };
type VerifyData = { user: { id: string; displayName: string; role: string }; created: boolean };

interface Blocker {
  tone: "error" | "attention" | "info";
  title: string;
  body?: string;
  retryAt?: number;
}

function blockerFor(result: ApiResult<unknown>): Blocker {
  const error: ApiError = result.ok ? { code: "internal", message: "Unexpected response." } : result.error;
  switch (error.code) {
    case "rate_limited":
      return {
        tone: "attention",
        title: "Too many attempts",
        body: "Wait a moment before trying again.",
        ...(result.retryAfterMs ? { retryAt: Date.now() + result.retryAfterMs } : {}),
      };
    case "unavailable":
      if (errorDetailCode(error) === "sms_unavailable") {
        return { tone: "attention", title: "Text messages are not available here yet", body: "This deployment has no SMS provider configured, so no code can be sent. Ask the organizer for another way in." };
      }
      return { tone: "error", title: "Could not reach Sideout", body: error.message };
    case "unauthorized":
      return { tone: "error", title: "That code did not work", body: "Check the digits, or request a new code if it has expired." };
    default:
      return { tone: "error", title: "Something went wrong", body: error.message };
  }
}

function RetryCountdown({ retryAt }: { retryAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  if (seconds === 0) return <span>You can try again now.</span>;
  return (
    <span className="tabular">
      Try again in {seconds} second{seconds === 1 ? "" : "s"}.
    </span>
  );
}

export function SignInForm({ next, className }: { next: string; className?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [needsName, setNeedsName] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [blocker, setBlocker] = useState<Blocker | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: SyntheticEvent) {
    e.preventDefault();
    setBlocker(null);
    const parsed = phoneForm.safeParse({ phone: phoneInput });
    if (!parsed.success) {
      setErrors({ phone: parsed.error.issues[0]?.message ?? "Enter a phone number." });
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await api<RequestData>("/api/auth/request-code", { body: { phone: parsed.data.phone } });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === "bad_request") setErrors(fieldIssues(result.error));
      else setBlocker(blockerFor(result));
      return;
    }
    setPhone(parsed.data.phone);
    setDevCode(result.data.devCode ?? null);
    setStep("code");
  }

  function backToPhone() {
    setStep("phone");
    setCode("");
    setBlocker(null);
    setErrors({});
  }

  async function verify(e: SyntheticEvent) {
    e.preventDefault();
    if (!phone) return;
    setBlocker(null);
    const parsed = codeForm.safeParse({ code, displayName: needsName ? displayName : undefined });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] = issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const body: Record<string, string> = { phone, code: parsed.data.code };
    if (parsed.data.displayName) body.displayName = parsed.data.displayName;
    const result = await api<VerifyData>("/api/auth/verify", { body });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === "bad_request" && errorDetailCode(result.error) === "display_name_required") {
        setNeedsName(true);
        setErrors({ displayName: "Pick the name other players will see." });
        return;
      }
      if (result.error.code === "bad_request") setErrors(fieldIssues(result.error));
      else setBlocker(blockerFor(result));
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <div className={cx("space-y-4", className)}>
      {blocker ? (
        <Notice tone={blocker.tone} title={blocker.title}>
          {blocker.retryAt ? <RetryCountdown retryAt={blocker.retryAt} /> : blocker.body}
        </Notice>
      ) : null}

      {step === "phone" ? (
        <form onSubmit={requestCode} noValidate className="surface-raised space-y-4 rounded-md p-4 md:p-5">
          <Field label="Phone number" error={errors.phone} hint="US numbers work as ten digits; anything else in international format.">
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                autoFocus
                placeholder="+1 555 010 0100"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={busy}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy} aria-busy={busy} iconStart={<Icons.phone size={18} />}>
            {busy ? "Sending…" : "Text me a code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} noValidate className="surface-raised space-y-4 rounded-md p-4 md:p-5">
          <p className="text-text-secondary">
            We texted a code to <span className="tabular text-text-primary">{phone ? maskPhone(phone) : ""}</span>.{" "}
            <button type="button" onClick={backToPhone} className="text-text-primary underline-offset-2 hover:underline">
              Wrong number?
            </button>
          </p>
          {devCode ? (
            <Notice tone="info" title="Development build">
              <span>
                No SMS provider is wired in, so the code is shown here: <span className="tabular font-medium text-text-primary">{devCode}</span>
              </span>
            </Notice>
          ) : null}
          <Field label="Six-digit code" error={errors.code}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={busy}
                className="tabular text-subheading tracking-[0.3em]"
              />
            )}
          </Field>
          {needsName ? (
            <Field label="Your name" error={errors.displayName} hint="First time here. This is how you appear on pool sheets and standings.">
              {({ id, describedBy, invalid }) => (
                <TextInput id={id} name="displayName" autoComplete="name" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-describedby={describedBy} invalid={invalid} disabled={busy} />
              )}
            </Field>
          ) : null}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? "Checking…" : needsName ? "Create account and sign in" : "Sign in"}
          </Button>
          <button type="button" onClick={requestCode} disabled={busy} className="target w-full type-label text-text-secondary hover:text-text-primary">
            Send a new code
          </button>
        </form>
      )}
    </div>
  );
}
