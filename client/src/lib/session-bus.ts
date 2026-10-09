// ─── Session bus ─────────────────────────────────────────────────────────────
// Same shape and reasoning as toast-bus.ts: lets the axios response interceptor
// in lib/api.ts raise the "your session ended" dialog without importing
// component code. SessionEndedProvider registers its opener here on mount.
//
// A toast is not enough for this one — the old flow hard-navigated to /login, so
// the toast was destroyed before it could be read, and the user was returned to a
// sign-in screen with no idea why. This holds the page until they acknowledge it.

type OpenFn = () => void;

let handler: OpenFn | null = null;

/** Called by SessionEndedProvider — pass null on unmount. */
export function setSessionEndedHandler(fn: OpenFn | null): void {
  handler = fn;
}

/**
 * Announce that the server rejected our session (401 SESSION_REVOKED).
 * Returns true when a dialog was shown, so the caller can skip its own redirect
 * and leave the navigation to the user's click. False means no provider is
 * mounted (SSR, or a public page) and the caller should redirect as before.
 */
export function sessionEnded(): boolean {
  if (!handler) return false;
  handler();
  return true;
}
