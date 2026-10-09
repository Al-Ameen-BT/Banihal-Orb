// ─── Toast bus ────────────────────────────────────────────────────────────────
// Lets NON-React code (e.g. the axios response interceptor in lib/api.ts) raise a
// toast without importing the component or threading props. ToastProvider registers
// its dispatch function here on mount and clears it on unmount; until then `notify`
// is a no-op, so calling it during SSR or before the provider mounts is safe.
//
// Deliberately React-free so lib/api.ts doesn't pull component code into scope.

export type ToastType = 'success' | 'error' | 'info';
type ToastFn = (message: string, type?: ToastType) => void;

let handler: ToastFn | null = null;

/** Called by ToastProvider — pass null on unmount. */
export function setToastHandler(fn: ToastFn | null): void {
  handler = fn;
}

/** Raise a toast from anywhere. No-op when no provider is mounted. */
export function notify(message: string, type: ToastType = 'info'): void {
  handler?.(message, type);
}
