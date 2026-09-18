"use client";

import { useId } from "react";
import { SetStepper } from "@/components/consensus/SetStepper";
import { Icons } from "@/components/ui/icons";
import type { BestOf } from "@/db/schema";
import { judgeMatch, judgeSet, setTarget, type MatchVerdict, type SetScore } from "@/domain/scoreline";
import { cx } from "@/lib/cx";

/**
 * One row per set, two steppers per row, and the legality of every set and
 * of the whole match judged live by `@/domain/scoreline` as the numbers
 * change (spec §11.3). The rules are the beach volleyball ones: sets to 21,
 * a deciding third set to 15, win by two, best-of-1 or best-of-3. A third
 * row appears only once the first two sets are legal and split.
 */
export interface EditorSet {
  setNumber: number;
  left: number;
  right: number;
}

export interface ScorelineEditorProps {
  bestOf: BestOf;
  leftLabel: string;
  rightLabel: string;
  value: readonly EditorSet[];
  onChange: (value: EditorSet[]) => void;
  disabled?: boolean;
  className?: string;
}

/** Rows the editor shows for the current entries: two for best-of-3, a third once the first two split. */
export function visibleRows(value: readonly EditorSet[], bestOf: BestOf): EditorSet[] {
  const rows: EditorSet[] = [];
  const count = bestOf === "3" ? 2 : 1;
  for (let n = 1; n <= count; n += 1) rows.push(value.find((s) => s.setNumber === n) ?? { setNumber: n, left: 0, right: 0 });
  if (bestOf === "3") {
    const [one, two] = rows;
    const v1 = one ? judgeSet(one.left, one.right, setTarget(1, bestOf)) : null;
    const v2 = two ? judgeSet(two.left, two.right, setTarget(2, bestOf)) : null;
    if (v1?.legal && v2?.legal && v1.winner !== v2.winner) rows.push(value.find((s) => s.setNumber === 3) ?? { setNumber: 3, left: 0, right: 0 });
  }
  return rows;
}

/** The visible rows as match-oriented sets (left = team A). */
export function toSetScores(rows: readonly EditorSet[]): SetScore[] {
  return rows.map((r) => ({ setNumber: r.setNumber, teamAPoints: r.left, teamBPoints: r.right }));
}

/** Rows the user has typed into; an untouched 0–0 third row is not part of the result yet. */
export function enteredRows(rows: readonly EditorSet[]): EditorSet[] {
  return rows.filter((r) => r.left > 0 || r.right > 0);
}

/** The legality of what has been entered so far; this is what enables submit. */
export function judgeRows(rows: readonly EditorSet[], bestOf: BestOf): MatchVerdict {
  return judgeMatch(toSetScores(enteredRows(rows)), bestOf);
}

export function ScorelineEditor({ bestOf, leftLabel, rightLabel, value, onChange, disabled = false, className }: ScorelineEditorProps) {
  const id = useId();
  const rows = visibleRows(value, bestOf);
  const verdict = judgeRows(rows, bestOf);
  const touched = rows.some((r) => r.left > 0 || r.right > 0);
  const update = (setNumber: number, patch: Partial<Pick<EditorSet, "left" | "right">>) => {
    onChange(rows.map((r) => (r.setNumber === setNumber ? { ...r, ...patch } : r)));
  };
  return (
    <div className={cx("space-y-3", className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 px-1 type-label text-text-tertiary">
        <span className="truncate text-start">{leftLabel}</span>
        <span aria-hidden="true" />
        <span className="truncate text-end">{rightLabel}</span>
      </div>
      <ol className="space-y-3">
        {rows.map((row) => {
          const target = setTarget(row.setNumber, bestOf);
          const setVerdict = judgeSet(row.left, row.right, target);
          const rowTouched = row.left > 0 || row.right > 0;
          const feedbackId = `${id}-set-${row.setNumber}`;
          return (
            <li key={row.setNumber} className="surface-raised rounded-md p-3" aria-describedby={feedbackId}>
              <div className="flex items-center justify-between gap-2">
                <span className="type-label text-text-secondary">
                  Set {row.setNumber} <span className="text-text-tertiary">· to {target}</span>
                </span>
                <span id={feedbackId} aria-live="polite" className={cx("min-w-0 text-end type-label", !rowTouched ? "text-text-tertiary" : setVerdict.legal ? "text-surf" : "text-fault")}>
                  {!rowTouched ? "Enter the set" : setVerdict.legal ? (
                    <span className="inline-flex items-center gap-1">
                      <Icons.check size={12} />
                      Legal set
                    </span>
                  ) : (
                    setVerdict.reason
                  )}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <SetStepper label={leftLabel} setNumber={row.setNumber} value={row.left} onChange={(v) => update(row.setNumber, { left: v })} disabled={disabled} leading={setVerdict.legal && setVerdict.winner === "a"} />
                <span aria-hidden="true" className="type-label text-text-tertiary">
                  –
                </span>
                <SetStepper label={rightLabel} setNumber={row.setNumber} value={row.right} onChange={(v) => update(row.setNumber, { right: v })} disabled={disabled} leading={setVerdict.legal && setVerdict.winner === "b"} />
              </div>
            </li>
          );
        })}
      </ol>
      <p data-testid="match-verdict" aria-live="polite" className={cx("px-1 text-body", !touched ? "text-text-tertiary" : verdict.legal ? "text-surf" : "text-text-secondary")}>
        {!touched
          ? `Best of ${bestOf}: ${bestOf === "3" ? "sets to 21, a third set to 15, win by two." : "one set to 21, win by two."}`
          : verdict.legal
            ? `Legal result: ${verdict.winner === "a" ? leftLabel : rightLabel} win ${verdict.winner === "a" ? `${verdict.setsWon.a}–${verdict.setsWon.b}` : `${verdict.setsWon.b}–${verdict.setsWon.a}`} in sets.`
            : verdict.reason}
      </p>
    </div>
  );
}
