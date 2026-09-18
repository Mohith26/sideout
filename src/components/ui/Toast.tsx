"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icons, type IconComponent } from "@/components/ui/icons";
import { cx } from "@/lib/cx";

/**
 * Transient notices. Announced politely to assistive tech, dismissible, and
 * never used for anything the user must act on — that is ConfirmDialog's job.
 */
export type ToastTone = "neutral" | "success" | "error";

export interface ToastInput {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. */
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastInput, "title" | "tone" | "durationMs">> {
  id: number;
  body: string | undefined;
}

interface ToastContextValue {
  toast: (input: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE: Record<ToastTone, { className: string; icon: IconComponent }> = {
  neutral: { className: "text-text-primary", icon: Icons.info },
  success: { className: "text-surf", icon: Icons.circleCheck },
  error: { className: "text-fault", icon: Icons.circleAlert },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const item: ToastItem = {
        id,
        title: input.title,
        body: input.body,
        tone: input.tone ?? "neutral",
        durationMs: input.durationMs ?? 5000,
      };
      setItems((list) => [...list, item]);
      if (item.durationMs > 0) timers.current.set(id, setTimeout(() => dismiss(id), item.durationMs));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport items={items} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

function ToastViewport({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px)+12px)] z-50 flex flex-col items-center gap-2 px-gutter xl:bottom-6 xl:items-end"
    >
      {items.map((item) => {
        const tone = TONE[item.tone];
        const Icon = tone.icon;
        return (
          <div
            key={item.id}
            role="status"
            className="pointer-events-auto surface-overlay flex w-full max-w-sm items-start gap-3 rounded-md p-3"
          >
            <span className={cx("mt-0.5 shrink-0", tone.className)}>
              <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-text-primary">{item.title}</p>
              {item.body ? <p className="mt-0.5 text-text-secondary">{item.body}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(item.id)}
              aria-label="Dismiss"
              className="target -m-2 flex shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:text-text-primary"
            >
              <Icons.x size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
