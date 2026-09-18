import "server-only";
import { DatabaseNotReadyError } from "@/db/connection";

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Run a synchronous read model and turn "no database yet" into a renderable
 * state rather than a crashed route. Any other error still throws so the
 * route error boundary sees it.
 */
export function load<T>(fn: () => T): Loaded<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) return { ok: false, message: err.message };
    throw err;
  }
}

export async function loadAsync<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof DatabaseNotReadyError) return { ok: false, message: err.message };
    throw err;
  }
}
