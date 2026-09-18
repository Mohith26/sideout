"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { DIVISION_LABEL, FORMAT_LABEL, PRIZE_KIND_LABEL, SPONSOR_TIER_LABEL } from "@/components/tournament/labels";
import { Button } from "@/components/ui/Button";
import { Field, Fieldset, Select, TextInput } from "@/components/ui/Form";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import type { Division, PrizeKind, Sponsor, SponsorTier, Tournament, TournamentFormat } from "@/db/schema";
import { api, fieldIssues } from "@/lib/api-client";
import { centsToAmountString, parseAmountToCents } from "@/lib/format";
import { formatWallClock, isValidTimeZone, parseWallClock, wallClockToEpoch } from "@/lib/timezone";
import { cx } from "@/lib/cx";

/**
 * The event builder's form (spec §11.6): every editable tournament column and
 * the sponsor list, validated with zod on the client (mirroring
 * `createTournamentSchema` / `updateTournamentSchema`, which validate again on
 * the server) and written through `POST`/`PATCH /api/admin/tournaments`.
 * Times are edited as the venue sees them and stored as epoch milliseconds.
 */

export interface EventFormOptions {
  formats: readonly TournamentFormat[];
  divisions: readonly Division[];
  prizeKinds: readonly PrizeKind[];
  tiers: readonly SponsorTier[];
  charities: ReadonlyArray<{ id: string; name: string }>;
  /** `FEATURE_REAL_MONEY`; when false the real-money option is shown disabled, never hidden. */
  realMoneyEnabled: boolean;
  defaultGameId: string;
  defaultTimeZone: string;
  defaultCurrency: string;
}

export interface EventFormLocks {
  /** Settled or cancelled: nothing may change. */
  readOnly: boolean;
  /** Donations exist: beneficiary and currency are fixed. */
  beneficiary: boolean;
  currency: boolean;
  /** A draw exists: the format is fixed. */
  format: boolean;
  /** Teams already registered: capacity cannot go below this. */
  minTeams: number;
}

export type EventFormProps =
  | { mode: "create"; options: EventFormOptions; className?: string }
  | { mode: "edit"; options: EventFormOptions; tournament: Tournament; sponsors: Sponsor[]; locks: EventFormLocks; className?: string };

interface SponsorDraft {
  key: string;
  id: string | undefined;
  name: string;
  tier: SponsorTier;
  contribution: string;
  logoUrl: string;
}

interface Values {
  slug: string;
  name: string;
  subtitle: string;
  beneficiaryId: string;
  venueName: string;
  venueCity: string;
  venueState: string;
  venueTimezone: string;
  startsAt: string;
  endsAt: string;
  format: TournamentFormat;
  division: Division;
  maxTeams: string;
  entryDonation: string;
  fundraisingGoal: string;
  currency: string;
  prizeKind: PrizeKind;
  lucraGameId: string;
  lucraLocationId: string;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initialValues(props: EventFormProps): Values {
  if (props.mode === "create") {
    return {
      slug: "",
      name: "",
      subtitle: "",
      beneficiaryId: props.options.charities[0]?.id ?? "",
      venueName: "",
      venueCity: "",
      venueState: "",
      venueTimezone: props.options.defaultTimeZone,
      startsAt: "",
      endsAt: "",
      format: "pool_to_bracket",
      division: "open",
      maxTeams: "16",
      entryDonation: "",
      fundraisingGoal: "",
      currency: props.options.defaultCurrency,
      prizeKind: "free_to_play_rewards",
      lucraGameId: props.options.defaultGameId,
      lucraLocationId: "",
    };
  }
  const t = props.tournament;
  return {
    slug: t.slug,
    name: t.name,
    subtitle: t.subtitle ?? "",
    beneficiaryId: t.beneficiaryId,
    venueName: t.venueName,
    venueCity: t.venueCity,
    venueState: t.venueState,
    venueTimezone: t.venueTimezone,
    startsAt: formatWallClock(t.startsAt, t.venueTimezone),
    endsAt: formatWallClock(t.endsAt, t.venueTimezone),
    format: t.format,
    division: t.division,
    maxTeams: String(t.maxTeams),
    entryDonation: centsToAmountString(t.entryDonationCents),
    fundraisingGoal: centsToAmountString(t.fundraisingGoalCents),
    currency: t.currency,
    prizeKind: t.prizeKind,
    lucraGameId: t.lucraGameId,
    lucraLocationId: t.lucraLocationId ?? "",
  };
}

function initialSponsors(props: EventFormProps): SponsorDraft[] {
  if (props.mode === "create") return [];
  return props.sponsors.map((s) => ({ key: s.id, id: s.id, name: s.name, tier: s.tier, contribution: centsToAmountString(s.prizeContributionCents), logoUrl: s.logoUrl ?? "" }));
}

interface SponsorPayload {
  id?: string;
  name: string;
  tier: SponsorTier;
  prizeContributionCents: number;
  logoUrl: string | null;
  currency: string;
}

/** What the server would store for a sponsor, so a list can be compared with the rows it came from. */
function sponsorKey(s: Pick<Sponsor, "name" | "tier" | "prizeContributionCents" | "logoUrl" | "currency"> & { id?: string }): string {
  return JSON.stringify([s.id ?? null, s.name, s.tier, s.prizeContributionCents, s.logoUrl, s.currency]);
}

function schemaFor(options: EventFormOptions, locks: EventFormLocks | null) {
  const amount = (label: string) => z.string().trim().refine((v) => parseAmountToCents(v) !== null, `${label} must be an amount like 75 or 75.00.`);
  const wall = (label: string) => z.string().refine((v) => parseWallClock(v) !== null, `${label} needs a date and time.`);
  return z
    .object({
      slug: z.string().trim().min(3, "At least three characters.").max(64).regex(SLUG_RE, "Lowercase letters, digits and single hyphens only."),
      name: z.string().trim().min(2, "At least two characters.").max(120),
      subtitle: z.string().trim().max(200, "Keep it under 200 characters."),
      beneficiaryId: z.string().min(1, "Choose a beneficiary."),
      venueName: z.string().trim().min(1, "Where is it played?").max(120),
      venueCity: z.string().trim().min(1, "City is required.").max(80),
      venueState: z
        .string()
        .trim()
        .min(2, "Two- or three-letter code.")
        .max(3, "Two- or three-letter code.")
        .transform((v) => v.toUpperCase()),
      venueTimezone: z.string().trim().refine(isValidTimeZone, "An IANA zone, like America/Los_Angeles."),
      startsAt: wall("Start"),
      endsAt: wall("End"),
      format: z.enum(options.formats),
      division: z.enum(options.divisions),
      maxTeams: z.coerce
        .number()
        .int("Whole teams only.")
        .min(2, "At least two teams.")
        .max(256)
        .refine((n) => !locks || n >= locks.minTeams, locks ? `${locks.minTeams} teams are already registered.` : ""),
      entryDonation: amount("Entry donation"),
      fundraisingGoal: amount("Fundraising goal"),
      currency: z
        .string()
        .trim()
        .transform((v) => v.toUpperCase())
        .pipe(z.string().regex(/^[A-Z]{3}$/, "Three-letter ISO code.")),
      prizeKind: z.enum(options.prizeKinds).refine((k) => k !== "real_money" || options.realMoneyEnabled, "Real-money events are disabled (FEATURE_REAL_MONEY=false)."),
      lucraGameId: z.string().trim().min(1, "Required.").max(80),
      lucraLocationId: z.string().trim().max(120),
      sponsors: z.array(
        z.object({
          id: z.string().optional(),
          name: z.string().trim().min(1, "Sponsor name is required.").max(80),
          tier: z.enum(options.tiers),
          contribution: amount("Contribution"),
          logoUrl: z.union([z.literal(""), z.url("Enter a full URL or leave it blank.")]),
        }),
      ),
    })
    .superRefine((v, ctx) => {
      const start = parseWallClock(v.startsAt);
      const end = parseWallClock(v.endsAt);
      if (start && end && isValidTimeZone(v.venueTimezone) && wallClockToEpoch(end, v.venueTimezone) < wallClockToEpoch(start, v.venueTimezone)) {
        ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must not be before start." });
      }
    });
}

export function EventForm(props: EventFormProps) {
  const { options } = props;
  const locks = props.mode === "edit" ? props.locks : null;
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<Values>(() => initialValues(props));
  const [sponsors, setSponsors] = useState<SponsorDraft[]>(() => initialSponsors(props));
  const [slugTouched, setSlugTouched] = useState(props.mode === "edit");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readOnly = locks?.readOnly ?? false;

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }));

  function onNameChange(name: string) {
    set("name", name);
    if (!slugTouched) set("slug", slugify(name));
  }

  function addSponsor() {
    setSponsors((list) => [...list, { key: `new-${Date.now()}-${list.length}`, id: undefined, name: "", tier: "prize", contribution: "0", logoUrl: "" }]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    const parsed = schemaFor(options, locks).safeParse({ ...values, sponsors });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        if (!(path in next)) next[path] = issue.message;
      }
      setErrors(next);
      setFailure("Fix the highlighted fields.");
      return;
    }
    setErrors({});
    const v = parsed.data;
    const start = parseWallClock(v.startsAt);
    const end = parseWallClock(v.endsAt);
    if (!start || !end) return;
    const sponsorRows: SponsorPayload[] = v.sponsors.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      name: s.name,
      tier: s.tier,
      prizeContributionCents: parseAmountToCents(s.contribution) ?? 0,
      logoUrl: s.logoUrl === "" ? null : s.logoUrl,
      currency: v.currency,
    }));
    const sponsorsChanged = props.mode === "create" || sponsorRows.map(sponsorKey).join() !== props.sponsors.map(sponsorKey).join();
    const payload = {
      slug: v.slug,
      name: v.name,
      subtitle: v.subtitle === "" ? null : v.subtitle,
      beneficiaryId: v.beneficiaryId,
      venueName: v.venueName,
      venueCity: v.venueCity,
      venueState: v.venueState,
      venueTimezone: v.venueTimezone,
      startsAt: wallClockToEpoch(start, v.venueTimezone),
      endsAt: wallClockToEpoch(end, v.venueTimezone),
      format: v.format,
      division: v.division,
      maxTeams: v.maxTeams,
      entryDonationCents: parseAmountToCents(v.entryDonation) ?? 0,
      fundraisingGoalCents: parseAmountToCents(v.fundraisingGoal) ?? 0,
      currency: v.currency,
      prizeKind: v.prizeKind,
      lucraGameId: v.lucraGameId,
      lucraLocationId: v.lucraLocationId === "" ? null : v.lucraLocationId,
      ...(sponsorsChanged ? { sponsors: sponsorRows } : {}),
    };
    setBusy(true);
    const result =
      props.mode === "create"
        ? await api<{ tournament: { id: string; name: string } }>("/api/admin/tournaments", { body: payload })
        : await api<{ tournament: { id: string; name: string } }>(`/api/admin/tournaments/${props.tournament.id}`, { method: "PATCH", body: payload });
    setBusy(false);
    if (!result.ok) {
      const issues = result.error.code === "bad_request" ? fieldIssues(result.error) : {};
      if (Object.keys(issues).length) {
        setErrors(issues);
        setFailure("The server rejected some fields.");
      } else {
        setFailure(result.error.message);
      }
      return;
    }
    if (props.mode === "create") {
      toast({ tone: "success", title: `${result.data.tournament.name} created as a draft`, body: "Open registration from the status controls when it is ready." });
      router.push(`/organizer/events/${result.data.tournament.id}`);
      router.refresh();
      return;
    }
    toast({ tone: "success", title: "Saved", body: `${result.data.tournament.name} is up to date.` });
    setSlugTouched(true);
    router.refresh();
  }

  const field = <K extends keyof Values>(key: K) => ({
    value: values[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as Values[K]),
    disabled: busy || readOnly,
  });

  return (
    <form onSubmit={submit} noValidate className={cx("space-y-8", props.className)}>
      {readOnly ? (
        <Notice tone="info" title="This event is read-only">
          A settled or cancelled event keeps its record as it was.
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="error" title={props.mode === "create" ? "Could not create the event" : "Could not save"}>
          {failure}
        </Notice>
      ) : null}

      <Fieldset legend="Event">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" error={errors.name} className="md:col-span-2">
            {({ id, describedBy, invalid }) => <TextInput id={id} name="name" {...field("name")} onChange={(e) => onNameChange(e.target.value)} aria-describedby={describedBy} invalid={invalid} autoFocus={props.mode === "create"} />}
          </Field>
          <Field label="Slug" error={errors.slug} hint={`Public address: /t/${values.slug || "…"}`}>
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                name="slug"
                {...field("slug")}
                onChange={(e) => {
                  setSlugTouched(true);
                  set("slug", e.target.value);
                }}
                aria-describedby={describedBy}
                invalid={invalid}
                className="tabular"
              />
            )}
          </Field>
          <Field label="Subtitle" meta="optional" error={errors.subtitle}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="subtitle" {...field("subtitle")} aria-describedby={describedBy} invalid={invalid} />}
          </Field>
          <Field label="Beneficiary" error={errors.beneficiaryId} hint={locks?.beneficiary ? "Fixed once donations exist." : undefined} className="md:col-span-2">
            {({ id, describedBy, invalid }) => (
              <Select id={id} name="beneficiaryId" {...field("beneficiaryId")} disabled={busy || readOnly || Boolean(locks?.beneficiary)} aria-describedby={describedBy} invalid={invalid}>
                {options.charities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Venue and schedule" description="Times are entered as the venue sees them.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Venue" error={errors.venueName} className="md:col-span-2">
            {({ id, describedBy, invalid }) => <TextInput id={id} name="venueName" {...field("venueName")} aria-describedby={describedBy} invalid={invalid} />}
          </Field>
          <Field label="City" error={errors.venueCity}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="venueCity" {...field("venueCity")} aria-describedby={describedBy} invalid={invalid} />}
          </Field>
          <Field label="State" error={errors.venueState}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="venueState" maxLength={3} {...field("venueState")} aria-describedby={describedBy} invalid={invalid} className="uppercase" />}
          </Field>
          <Field label="Time zone" error={errors.venueTimezone} hint="IANA name." className="md:col-span-2">
            {({ id, describedBy, invalid }) => <TextInput id={id} name="venueTimezone" {...field("venueTimezone")} aria-describedby={describedBy} invalid={invalid} />}
          </Field>
          <Field label="Starts" error={errors.startsAt}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="startsAt" type="datetime-local" {...field("startsAt")} aria-describedby={describedBy} invalid={invalid} className="tabular" />}
          </Field>
          <Field label="Ends" error={errors.endsAt}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="endsAt" type="datetime-local" {...field("endsAt")} aria-describedby={describedBy} invalid={invalid} className="tabular" />}
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Play">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Format" error={errors.format} hint={locks?.format ? "Fixed while a draw exists." : "Double elimination is listed but not drawable yet."}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} name="format" {...field("format")} disabled={busy || readOnly || Boolean(locks?.format)} aria-describedby={describedBy} invalid={invalid}>
                {options.formats.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Division" error={errors.division}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} name="division" {...field("division")} aria-describedby={describedBy} invalid={invalid}>
                {options.divisions.map((d) => (
                  <option key={d} value={d}>
                    {DIVISION_LABEL[d]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Max teams" error={errors.maxTeams} hint={locks && locks.minTeams > 0 ? `${locks.minTeams} registered so far.` : undefined}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="maxTeams" type="number" inputMode="numeric" min={2} max={256} {...field("maxTeams")} aria-describedby={describedBy} invalid={invalid} />}
          </Field>
          <Field label="Prizes" error={errors.prizeKind} hint={options.realMoneyEnabled ? undefined : "Real money stays behind FEATURE_REAL_MONEY, which is off."}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} name="prizeKind" {...field("prizeKind")} aria-describedby={describedBy} invalid={invalid}>
                {options.prizeKinds.map((k) => (
                  <option key={k} value={k} disabled={k === "real_money" && !options.realMoneyEnabled}>
                    {PRIZE_KIND_LABEL[k]}
                    {k === "real_money" && !options.realMoneyEnabled ? " (disabled)" : ""}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Lucra game id" error={errors.lucraGameId} hint="One constant for beach 2v2 until Lucra says otherwise.">
            {({ id, describedBy, invalid }) => <TextInput id={id} name="lucraGameId" {...field("lucraGameId")} aria-describedby={describedBy} invalid={invalid} className="tabular" />}
          </Field>
          <Field label="Lucra location id" meta="optional" error={errors.lucraLocationId} hint="Open question: how a travelling venue is modelled.">
            {({ id, describedBy, invalid }) => <TextInput id={id} name="lucraLocationId" {...field("lucraLocationId")} aria-describedby={describedBy} invalid={invalid} className="tabular" />}
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Donations" description="Entry fees are charitable donations to the beneficiary; they never fund prizes.">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Currency" error={errors.currency} hint={locks?.currency ? "Fixed once donations exist." : undefined}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="currency" maxLength={3} {...field("currency")} disabled={busy || readOnly || Boolean(locks?.currency)} aria-describedby={describedBy} invalid={invalid} className="uppercase tabular" />}
          </Field>
          <Field label="Entry donation per team" error={errors.entryDonation}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="entryDonation" inputMode="decimal" {...field("entryDonation")} aria-describedby={describedBy} invalid={invalid} className="tabular" placeholder="75" />}
          </Field>
          <Field label="Fundraising goal" error={errors.fundraisingGoal}>
            {({ id, describedBy, invalid }) => <TextInput id={id} name="fundraisingGoal" inputMode="decimal" {...field("fundraisingGoal")} aria-describedby={describedBy} invalid={invalid} className="tabular" placeholder="7500" />}
          </Field>
        </div>
      </Fieldset>

      <Fieldset legend="Sponsors" description="Sponsor contributions fund the prize pool, a separate ledger from donations.">
        <div className="space-y-3">
          {sponsors.length === 0 ? <p className="text-text-tertiary">No sponsors yet.</p> : null}
          {sponsors.map((s, i) => (
            <div key={s.key} className="surface-raised grid gap-3 rounded-md p-3 md:grid-cols-[1fr_10rem_8rem_1fr_auto] md:items-end">
              <Field label="Sponsor" error={errors[`sponsors.${i}.name`]}>
                {({ id, describedBy, invalid }) => (
                  <TextInput id={id} value={s.name} disabled={busy || readOnly} onChange={(e) => setSponsors((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-describedby={describedBy} invalid={invalid} />
                )}
              </Field>
              <Field label="Tier" error={errors[`sponsors.${i}.tier`]}>
                {({ id, describedBy, invalid }) => (
                  <Select id={id} value={s.tier} disabled={busy || readOnly} onChange={(e) => setSponsors((list) => list.map((x, j) => (j === i ? { ...x, tier: e.target.value as SponsorTier } : x)))} aria-describedby={describedBy} invalid={invalid}>
                    {options.tiers.map((tier) => (
                      <option key={tier} value={tier}>
                        {SPONSOR_TIER_LABEL[tier]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Prize contribution" error={errors[`sponsors.${i}.contribution`]}>
                {({ id, describedBy, invalid }) => (
                  <TextInput id={id} inputMode="decimal" value={s.contribution} disabled={busy || readOnly} onChange={(e) => setSponsors((list) => list.map((x, j) => (j === i ? { ...x, contribution: e.target.value } : x)))} aria-describedby={describedBy} invalid={invalid} className="tabular" />
                )}
              </Field>
              <Field label="Logo URL" meta="optional" error={errors[`sponsors.${i}.logoUrl`]}>
                {({ id, describedBy, invalid }) => (
                  <TextInput id={id} type="url" value={s.logoUrl} disabled={busy || readOnly} onChange={(e) => setSponsors((list) => list.map((x, j) => (j === i ? { ...x, logoUrl: e.target.value } : x)))} aria-describedby={describedBy} invalid={invalid} />
                )}
              </Field>
              <Button variant="ghost" aria-label={`Remove ${s.name || "sponsor"}`} disabled={busy || readOnly} onClick={() => setSponsors((list) => list.filter((_, j) => j !== i))} iconStart={<Icons.trash size={16} />}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={addSponsor} disabled={busy || readOnly} iconStart={<Icons.plus size={16} />}>
            Add sponsor
          </Button>
        </div>
      </Fieldset>

      {readOnly ? null : (
        <div className="flex flex-col-reverse gap-3 border-t border-border-subtle pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-text-tertiary">{props.mode === "create" ? "The event is created as a draft; nothing is public until registration opens." : "Status changes are separate, below."}</p>
          <Button type="submit" variant="primary" size="lg" disabled={busy} aria-busy={busy}>
            {busy ? "Saving…" : props.mode === "create" ? "Create draft" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  );
}
