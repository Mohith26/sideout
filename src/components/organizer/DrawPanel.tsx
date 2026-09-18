"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { Bracket } from "@/components/bracket/Bracket";
import { nodesFromPlan } from "@/components/bracket/model";
import { PoolTable, type PoolMatchRef, type PoolTeamRef } from "@/components/bracket/PoolTable";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, Fieldset, Select, TextInput } from "@/components/ui/Form";
import { Icons } from "@/components/ui/icons";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import type { TournamentFormat, TournamentStatus } from "@/db/schema";
import type { DrawConfig, DrawPlan } from "@/domain/draw";
import type { DrawPreview } from "@/server/draw";
import { api, fieldIssues } from "@/lib/api-client";
import { formatWallClock, parseWallClock, wallClockToEpoch } from "@/lib/timezone";
import { cx } from "@/lib/cx";

/**
 * The draw section of the builder (spec §11.6, "event builder with a live draw
 * preview"). Every preview is `POST /api/admin/tournaments/:id/draw?preview=1`
 * rendered with the same `PoolTable` and `Bracket` the public tabs use; commit
 * resends the previewed `rngSeed`, so what was shown is exactly what is written.
 *
 * Two stages: pools (while registration is closed; a re-draw replaces an
 * unstarted draw) and, for pool-to-bracket events once every pool match is
 * terminal, seeding the bracket from the standings.
 */
export interface DrawPanelProps {
  tournamentId: string;
  format: TournamentFormat;
  status: TournamentStatus;
  timeZone: string;
  startsAt: number;
  teams: ReadonlyArray<{ id: string; name: string; seed: number | null }>;
  existing: {
    matchCount: number;
    /** A match has started, so the draw is locked. */
    started: boolean;
    bracketSeeded: boolean;
    poolsDone: boolean;
    unfinishedPoolMatches: number;
    config: DrawConfig | null;
  };
}

interface FormValues {
  courts: string;
  poolSize: string;
  perPool: string;
  bestRemaining: string;
  poolBestOf: "1" | "3";
  bracketBestOf: "1" | "3";
  startsAt: string;
  poolMatchMinutes: string;
  bracketMatchMinutes: string;
  restMinutes: string;
}

const int = (label: string, min: number, max: number) =>
  z.coerce
    .number()
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);

const formSchema = z.object({
  courts: int("Courts", 1, 64),
  poolSize: int("Pool size", 2, 12),
  perPool: int("Per pool", 0, 12),
  bestRemaining: int("Best remaining", 0, 64),
  poolBestOf: z.enum(["1", "3"]),
  bracketBestOf: z.enum(["1", "3"]),
  startsAt: z.string().refine((v) => parseWallClock(v) !== null, "First round needs a date and time."),
  poolMatchMinutes: int("Pool match minutes", 5, 240),
  bracketMatchMinutes: int("Bracket match minutes", 5, 240),
  restMinutes: int("Rest minutes", 0, 240),
});

function initialForm(props: DrawPanelProps): FormValues {
  const c = props.existing.config;
  return {
    courts: String(c?.courts ?? 4),
    poolSize: String(c?.poolSize ?? 4),
    perPool: String(c?.advance.perPool ?? 2),
    bestRemaining: String(c?.advance.bestRemaining ?? 0),
    poolBestOf: c?.poolBestOf ?? "1",
    bracketBestOf: c?.bracketBestOf ?? "3",
    startsAt: formatWallClock(c?.schedule.startsAt ?? props.startsAt, props.timeZone),
    poolMatchMinutes: String(c?.schedule.poolMatchMinutes ?? 30),
    bracketMatchMinutes: String(c?.schedule.bracketMatchMinutes ?? 50),
    restMinutes: String(c?.schedule.restMinutes ?? 15),
  };
}

function poolsFromPlan(plan: DrawPlan, names: DrawPreview["teams"]): Array<{ key: string; label: string; courtLabel: string; teams: PoolTeamRef[]; matches: PoolMatchRef[] }> {
  return plan.pools.map((pool) => ({
    key: pool.key,
    label: pool.label,
    courtLabel: pool.courtLabel,
    teams: pool.teamIds.map((id) => ({ id, name: names[id]?.name ?? "Team", seed: names[id]?.seed ?? null, members: [] })),
    matches: plan.matches
      .filter((m) => m.poolKey === pool.key)
      .map((m) => ({
        id: m.key,
        teamAId: m.teamAId,
        teamBId: m.teamBId,
        status: m.status,
        winnerId: m.winnerTeamId,
        sets: [],
        round: m.round,
        scheduledAt: m.scheduledAt,
        href: null,
      })),
  }));
}

export function DrawPanel(props: DrawPanelProps) {
  const { tournamentId, format, status, timeZone, teams, existing } = props;
  const router = useRouter();
  const { toast } = useToast();
  const headingId = useId();
  const [form, setForm] = useState<FormValues>(() => initialForm(props));
  const [seeds, setSeeds] = useState<Record<string, string>>(() => Object.fromEntries(teams.map((t) => [t.id, t.seed === null ? "" : String(t.seed)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [preview, setPreview] = useState<DrawPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const poolsStage = status === "registration_closed";
  const bracketStage = status === "live" && format === "pool_to_bracket" && !existing.bracketSeeded && existing.matchCount > 0;
  if (!poolsStage && !bracketStage) return null;

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setForm((f) => ({ ...f, [key]: value }));
  const usesPools = format === "pool_to_bracket" || format === "round_robin";
  const usesBracket = format === "pool_to_bracket" || format === "single_elim";

  function poolsRequest(): Record<string, unknown> | null {
    const parsed = formSchema.safeParse(form);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] = issue.message;
      setErrors(next);
      setFailure("Fix the highlighted fields.");
      return null;
    }
    const seedList: Array<{ teamId: string; seed: number | null }> = [];
    const used = new Map<number, string>();
    for (const t of teams) {
      const raw = (seeds[t.id] ?? "").trim();
      const value = raw === "" ? null : Number(raw);
      if (value !== null && (!Number.isInteger(value) || value < 1)) {
        setErrors({ [`seed.${t.id}`]: "Seeds are whole numbers from 1." });
        setFailure("Fix the highlighted fields.");
        return null;
      }
      if (value !== null) {
        const other = used.get(value);
        if (other) {
          setErrors({ [`seed.${t.id}`]: `Seed ${value} is also given to ${other}.` });
          setFailure("Fix the highlighted fields.");
          return null;
        }
        used.set(value, t.name);
      }
      if (value !== t.seed) seedList.push({ teamId: t.id, seed: value });
    }
    setErrors({});
    const v = parsed.data;
    const wall = parseWallClock(v.startsAt);
    return {
      stage: "pools",
      courts: v.courts,
      poolSize: v.poolSize,
      advance: { perPool: v.perPool, bestRemaining: v.bestRemaining },
      poolBestOf: v.poolBestOf,
      bracketBestOf: v.bracketBestOf,
      startsAt: wall ? wallClockToEpoch(wall, timeZone) : undefined,
      poolMatchMinutes: v.poolMatchMinutes,
      bracketMatchMinutes: v.bracketMatchMinutes,
      restMinutes: v.restMinutes,
      ...(seedList.length ? { seeds: seedList } : {}),
    };
  }

  async function run(mode: "preview" | "commit", e?: FormEvent) {
    e?.preventDefault();
    setFailure(null);
    let body: Record<string, unknown> | null;
    if (bracketStage) body = { stage: "bracket" };
    else {
      body = poolsRequest();
      if (!body) return;
      if (mode === "commit" && preview?.rngSeed !== null && preview?.rngSeed !== undefined) body.rngSeed = preview.rngSeed;
    }
    setBusy(mode);
    const result = await api<{ preview: DrawPreview }>(`/api/admin/tournaments/${tournamentId}/draw${mode === "preview" ? "?preview=1" : ""}`, { body });
    setBusy(null);
    setConfirming(false);
    if (!result.ok) {
      const issues = result.error.code === "bad_request" ? fieldIssues(result.error) : {};
      if (Object.keys(issues).length) setErrors(issues);
      setFailure(result.error.message);
      return;
    }
    if (mode === "preview") {
      setPreview(result.data.preview);
      return;
    }
    setPreview(null);
    toast({ tone: "success", title: bracketStage ? "Bracket seeded" : existing.matchCount > 0 ? "Draw replaced" : "Draw generated", body: "Pools, courts and the bracket are written; the public tabs show them now." });
    router.refresh();
  }

  const plan = preview?.plan ?? null;
  const previewPools = plan && preview ? poolsFromPlan(plan, preview.teams) : [];
  const previewNodes = plan && preview ? nodesFromPlan(plan, preview.teams) : [];

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={headingId} className="type-heading">
          {bracketStage ? "Seed the bracket" : existing.matchCount > 0 ? "Re-draw" : "Draw"}
        </h2>
        <span className="tabular type-label text-text-tertiary">{teams.length} teams entered</span>
      </div>

      {existing.started ? (
        <Notice tone="info" title="The draw is locked">
          A match has already started, so pools and the bracket can no longer be replaced.
        </Notice>
      ) : null}
      {poolsStage && existing.matchCount > 0 && !existing.started ? (
        <Notice tone="attention" title="A draw already exists">
          Committing a new one replaces every pool and match. Nothing has started yet, so that is still allowed.
        </Notice>
      ) : null}
      {bracketStage && !existing.poolsDone ? (
        <Notice tone="info" title="Pool play is still going">
          {`${existing.unfinishedPoolMatches} pool ${existing.unfinishedPoolMatches === 1 ? "match is" : "matches are"} unresolved. The bracket is seeded from the final standings once every pool match is final or forfeited.`}
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="error" title="Could not run the draw">
          {failure}
        </Notice>
      ) : null}

      {poolsStage && !existing.started ? (
        <form onSubmit={(e) => void run("preview", e)} noValidate className="space-y-6">
          <Fieldset legend="Courts and pools">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Courts" error={errors.courts}>
                {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={1} max={64} value={form.courts} onChange={(e) => set("courts", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
              </Field>
              {usesPools ? (
                <Field label="Pool size" error={errors.poolSize} hint="Pools differ by at most one.">
                  {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={2} max={12} value={form.poolSize} onChange={(e) => set("poolSize", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                </Field>
              ) : null}
              {format === "pool_to_bracket" ? (
                <>
                  <Field label="Advance per pool" error={errors.perPool}>
                    {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={0} max={12} value={form.perPool} onChange={(e) => set("perPool", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                  </Field>
                  <Field label="Best remaining" error={errors.bestRemaining} hint="Next-placed teams ranked across pools.">
                    {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={0} max={64} value={form.bestRemaining} onChange={(e) => set("bestRemaining", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                  </Field>
                </>
              ) : null}
              {usesPools ? (
                <Field label="Pool matches" error={errors.poolBestOf}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={form.poolBestOf} onChange={(e) => set("poolBestOf", e.target.value as "1" | "3")} aria-describedby={describedBy} invalid={invalid}>
                      <option value="1">Best of 1</option>
                      <option value="3">Best of 3</option>
                    </Select>
                  )}
                </Field>
              ) : null}
              {usesBracket ? (
                <Field label="Bracket matches" error={errors.bracketBestOf}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={form.bracketBestOf} onChange={(e) => set("bracketBestOf", e.target.value as "1" | "3")} aria-describedby={describedBy} invalid={invalid}>
                      <option value="1">Best of 1</option>
                      <option value="3">Best of 3</option>
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>
          </Fieldset>
          <Fieldset legend="Schedule" description="Court slots include changeover; rest applies between pool play and the bracket and between rounds.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="First round starts" error={errors.startsAt}>
                {({ id, describedBy, invalid }) => <TextInput id={id} type="datetime-local" value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} aria-describedby={describedBy} invalid={invalid} className="tabular" />}
              </Field>
              {usesPools ? (
                <Field label="Pool match minutes" error={errors.poolMatchMinutes}>
                  {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={5} max={240} value={form.poolMatchMinutes} onChange={(e) => set("poolMatchMinutes", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                </Field>
              ) : null}
              {usesBracket ? (
                <Field label="Bracket match minutes" error={errors.bracketMatchMinutes}>
                  {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={5} max={240} value={form.bracketMatchMinutes} onChange={(e) => set("bracketMatchMinutes", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                </Field>
              ) : null}
              <Field label="Rest minutes" error={errors.restMinutes}>
                {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={0} max={240} value={form.restMinutes} onChange={(e) => set("restMinutes", e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
              </Field>
            </div>
          </Fieldset>
          <Fieldset legend="Entry seeds" description="Seeded teams are placed first, strongest as 1; unseeded teams are shuffled. Leave blank for none.">
            {teams.length === 0 ? (
              <p className="text-text-tertiary">No registered teams yet.</p>
            ) : (
              <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {teams.map((t) => (
                  <li key={t.id} className="surface-raised flex items-center gap-3 rounded-sm px-3 py-2">
                    <label htmlFor={`seed-${t.id}`} className="min-w-0 flex-1 truncate font-medium text-text-primary">
                      {t.name}
                    </label>
                    <span className="w-20 shrink-0">
                      <TextInput
                        id={`seed-${t.id}`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={seeds[t.id] ?? ""}
                        onChange={(e) => setSeeds((s) => ({ ...s, [t.id]: e.target.value }))}
                        aria-label={`Seed for ${t.name}`}
                        invalid={Boolean(errors[`seed.${t.id}`])}
                        className="text-end"
                        placeholder="—"
                      />
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {Object.entries(errors)
              .filter(([k]) => k.startsWith("seed."))
              .map(([k, v]) => (
                <p key={k} role="alert" className="mt-2 text-fault">
                  {v}
                </p>
              ))}
          </Fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary" disabled={busy !== null || teams.length < 2} aria-busy={busy === "preview"} iconStart={<Icons.shuffle size={16} />}>
              {busy === "preview" ? "Drawing…" : "Preview draw"}
            </Button>
            {preview ? (
              <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirming(true)} iconStart={<Icons.check size={16} />}>
                Commit this draw
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {bracketStage ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy !== null || !existing.poolsDone} aria-busy={busy === "preview"} onClick={() => void run("preview")} iconStart={<Icons.bracket size={16} />}>
            {busy === "preview" ? "Ranking pools…" : "Preview seeding"}
          </Button>
          {preview ? (
            <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirming(true)} iconStart={<Icons.check size={16} />}>
              Seed the bracket
            </Button>
          ) : null}
        </div>
      ) : null}

      {preview && plan ? (
        <div className="space-y-5" aria-live="polite">
          <Notice tone="info" title="Preview only — nothing is written until you commit">
            <span className="tabular">
              {plan.pools.length ? `${plan.pools.length} pools (${plan.pools.map((p) => p.teamIds.length).join(", ")} teams)` : "No pools"} ·{" "}
              {plan.bracket ? `${plan.bracket.size}-slot bracket, ${plan.bracket.rounds} rounds, ${plan.bracket.advancing} advancing` : "No bracket"} · {plan.matches.length} matches
              {preview.rngSeed !== null ? ` · seed ${preview.rngSeed}` : ""}
            </span>
          </Notice>
          {preview.advancing ? (
            <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {preview.advancing.map((id, i) => (
                <li key={id} className="flex items-baseline gap-2">
                  <span className="tabular w-6 text-end type-label text-text-tertiary">{i + 1}</span>
                  <span className="truncate text-text-primary">{preview.teams[id]?.name ?? id}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {previewPools.length ? (
            <div className={cx("grid gap-4", previewPools.length > 1 && "xl:grid-cols-2")}>
              {previewPools.map((pool) => (
                <PoolTable key={pool.key} label={pool.label} courtLabel={pool.courtLabel} teams={pool.teams} matches={pool.matches} timeZone={timeZone} />
              ))}
            </div>
          ) : null}
          {previewNodes.length ? <Bracket nodes={previewNodes} timeZone={timeZone} label="Draw preview" /> : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={bracketStage ? "Seed the bracket from the pool standings?" : existing.matchCount > 0 ? "Replace the existing draw?" : "Commit this draw?"}
        body={bracketStage ? "Round 1 is filled from the standings you previewed; byes advance immediately." : "Pools, courts, times and the bracket skeleton are written exactly as previewed."}
        confirmLabel={bracketStage ? "Seed bracket" : "Commit draw"}
        busy={busy === "commit"}
        onConfirm={() => void run("commit")}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
