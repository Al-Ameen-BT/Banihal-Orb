import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/terms', '/privacy', '/403', '/server-error', '/health'];

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

  const hasAccessToken = req.cookies.has('accessToken');
  if (!hasAccessToken) {
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
