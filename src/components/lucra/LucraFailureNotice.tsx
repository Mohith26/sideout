"use client";

import { useLucra, type LucraFlow } from "@/components/lucra/LucraGate";
import { Button } from "@/components/ui/Button";
import { Icons } from "@/components/ui/icons";
import { Notice, type NoticeTone } from "@/components/ui/Notice";
import type { LucraUiFailure } from "@/lucra/sdk-surface";

/**
 * One rendering of the §7.5 table's right-hand column: what the person sees
 * for each sealed failure, and the one thing they can do about it. Copy is
 * Sideout's; nothing Lucra said verbatim is shown, because wording changes
 * between releases and the message is never what was branched on.
 *
 * `NotAllowed` is the terminal row (§11.5): a plain explanation, a support
 * path, and no retry.
 */
export interface LucraFailureNoticeProps {
  failure: LucraUiFailure;
  /** The action that failed, for the retry rows. */
  onRetry?: (() => void) | undefined;
  supportHref: string;
  className?: string;
}

interface Row {
  tone: NoticeTone;
  title: string;
  body: string;
  /** A flow to launch, or `retry`, or nothing. */
  action: { kind: "launch"; flow: LucraFlow; label: string } | { kind: "retry"; label: string } | null;
}

function rowFor(failure: LucraUiFailure): Row {
  switch (failure.kind) {
    case "not_initialized":
      return failure.signedIn
        ? { tone: "info", title: "Lucra is still connecting", body: "The Lucra service is not ready yet. Try again in a moment.", action: { kind: "retry", label: "Try again" } }
        : { tone: "info", title: "Sign in to Lucra first", body: "This step runs in Lucra's own sign-in. Nothing about it is stored by Sideout.", action: { kind: "launch", flow: "auth", label: "Sign in with Lucra" } };
    case "unverified":
      return { tone: "info", title: "Lucra needs to verify you first", body: "Lucra's identity form checks age and location. Sideout never sees the details, only the outcome.", action: { kind: "launch", flow: "identity", label: "Verify with Lucra" } };
    case "not_allowed":
      return { tone: "attention", title: "Lucra can't offer this to your account", body: "Lucra has restricted this account under its own rules, which Sideout cannot see or change. There is nothing to retry here; Lucra support can explain and help.", action: null };
    case "insufficient_funds":
      return { tone: "info", title: "Your Lucra balance doesn't cover this", body: "Add funds in Lucra's wallet and try again.", action: { kind: "launch", flow: "addFunds", label: "Add funds in Lucra" } };
    case "demographics_missing":
      return { tone: "info", title: "Lucra needs a few details first", body: "Free-to-play tournaments need a short demographic form, collected by Lucra, not Sideout.", action: { kind: "launch", flow: "demographics", label: "Complete Lucra's form" } };
    case "location":
      return failure.grant
        ? { tone: "info", title: "Lucra needs your location", body: "Lucra checks that you are somewhere it operates. Allow location access in Lucra's own prompt, then try again.", action: { kind: "launch", flow: "location", label: "Allow location in Lucra" } }
        : { tone: "attention", title: "Lucra couldn't confirm your location", body: "Check that location services are on for this browser, that no VPN is moving you elsewhere, and that you are where Lucra is available. Then try again.", action: { kind: "retry", label: "Try again" } };
    case "api_error":
      return { tone: "error", title: "Lucra didn't answer", body: "The request was retried and still failed. Check your connection and try again; if it keeps happening, Lucra may be having trouble.", action: { kind: "retry", label: "Try again" } };
  }
}

export function LucraFailureNotice({ failure, onRetry, supportHref, className }: LucraFailureNoticeProps) {
  const lucra = useLucra();
  const row = rowFor(failure);
  return (
    <Notice tone={row.tone} title={row.title} {...(className === undefined ? {} : { className })}>
      <p>{row.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid={`lucra-failure-${failure.kind}`}>
        {row.action?.kind === "launch" ? (
          <Button variant="secondary" disabled={lucra.busy} onClick={() => void lucra.launch(row.action?.kind === "launch" ? row.action.flow : "auth").then((out) => (out.ok && onRetry ? onRetry() : undefined))}>
            {row.action.label}
          </Button>
        ) : null}
        {row.action?.kind === "retry" && onRetry ? (
          <Button variant="secondary" disabled={lucra.busy} onClick={onRetry}>
            {row.action.label}
          </Button>
        ) : null}
        {failure.kind === "not_allowed" ? (
          <a href={supportHref} className="target inline-flex items-center gap-1.5 font-medium text-text-primary hover:text-volt" target="_blank" rel="noreferrer noopener">
            <Icons.externalLink size={14} />
            Contact Lucra support
          </a>
        ) : null}
      </div>
    </Notice>
  );
}
