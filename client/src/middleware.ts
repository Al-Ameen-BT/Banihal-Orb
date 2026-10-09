import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/terms', '/privacy', '/403', '/server-error', '/health'];

// Files that must be reachable without a session. The Web Push service worker is
// fetched by the browser with no cookies and MUST be served from the origin root.
const PUBLIC_FILES = ['/sw.js'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_FILES.includes(pathname) ||
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.match(/\.(png|jpg|jpeg|gif|svg|ico)$/i)
  ) {
    return NextResponse.next();
  }

  // accessToken lives 15 minutes; the session behind it lives 7 days and the axios
  // interceptor renews it transparently on the first 401. Gating on accessToken ALONE
  // therefore bounced anyone idle for a quarter of an hour to /login mid-session — and
  // because refreshToken is path-scoped to /api/auth, browsers never send it here, so
  // there is nothing else for this to see. `hasSession` (server/src/modules/auth/
  // auth.controller.ts) is a value-less marker set at path '/' for exactly that reason:
  // it says a refreshable session should exist, and nothing more.
  //
  // This is a UX gate, never the security boundary. Every /api route is independently
  // gated by authMiddleware, and RoleGuard redirects client-side once /users/me
  // resolves — so the worst a stale marker buys is an app shell that bounces itself.
  if (!req.cookies.has('accessToken') && !req.cookies.has('hasSession')) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  // Exclude /api/* — those are proxied to the backend (next.config rewrites) and
  // authenticate via their own httpOnly cookie / 401s. If the page-auth middleware
  // ran on them it would 307-redirect the login POST itself to /login, breaking
  // sign-in (the client then shows a bogus "undefined" verification screen).
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
