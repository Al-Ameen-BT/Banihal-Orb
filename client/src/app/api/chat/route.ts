import type { NextRequest } from 'next/server';

// ─── Chat SSE proxy (Route Handler) ──────────────────────────────────────────
// The assistant replies over Server-Sent Events. Routing that stream through the
// next.config `rewrites()` proxy buffers/drops the long-lived connection (replies
// run on a CPU-only model and take 25–40s), which surfaced in the UI as
// "I hit an error reaching the assistant". This Route Handler serves `/api/chat`
// directly — it stays first-party (so the httpOnly auth cookie is sent) and pipes
// the backend SSE straight through without buffering. App-Router Route Handlers
// take precedence over `afterFiles` rewrites, so ONLY `POST /api/chat` is handled
// here; `/api/chat/sessions*` and every other `/api/*` still use the rewrite.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// Loopback, NOT NEXT_PUBLIC_API_URL. That variable is this server's own public
// https:// origin, whose certificate is self-signed — Node's fetch rejects it
// (DEPTH_ZERO_SELF_SIGNED_CERT), so every request through this handler fell into
// the catch below and answered "The assistant is unavailable". The API listens on
// 127.0.0.1:3001 (systemd unit), which is the same hop nginx makes for
// `location = /api/chat`, and staying off the public origin also keeps the
// nginx -> :3000 -> nginx proxy loop impossible.
const API_ORIGIN = 'http://127.0.0.1:3001';

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function sseError(message: string): Response {
  return new Response(
    `data: ${JSON.stringify({ error: message })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: SSE_HEADERS },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${API_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forward the session cookie so the backend authenticates the user.
        cookie: req.headers.get('cookie') ?? '',
      },
      body,
      cache: 'no-store',
    });
  } catch {
    // Backend unreachable — surface a well-formed SSE error the client understands.
    return sseError('The assistant is unavailable. Please try again.');
  }

  // Non-OK (401 / 403 / 429 / 5xx): pass the status + JSON body straight back so
  // the client's existing `!response.ok` handling behaves exactly as before.
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  }

  // Pipe the SSE stream straight through. Route Handlers stream a ReadableStream
  // to the client without the buffering the rewrite proxy imposes.
  return new Response(upstream.body, { status: 200, headers: SSE_HEADERS });
}
