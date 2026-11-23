import { NextRequest, NextResponse } from 'next/server';
import { backendUrl, SLUG_RE } from './funnel';

/**
 * Forward a browser POST to Lion Elite OS. The browser never talks to the
 * backend directly, so no CORS is opened there and the backend origin stays a
 * server-side setting.
 *
 * Without a backend configured nothing is stored, and the response says so
 * (`persisted: false`) — the prototype answered `{ok: true}` after a
 * console.log, which reported persistence that never happened.
 */
export async function forward(req: NextRequest, kind: 'events' | 'leads') {
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const slug = String(payload.slug || '');
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: 'invalid funnel slug' }, { status: 400 });

  const api = backendUrl();
  if (!api) {
    return NextResponse.json({ persisted: false, reason: 'BUILDPIPELINE_API_URL is not configured' }, { status: 202 });
  }
  const { slug: _slug, ...body } = payload;
  // Lets the backend rate-limit per visitor rather than per funnel server. Only
  // honoured there when the shared secret matches (routes/gtm-funnels.js).
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = process.env.BUILDPIPELINE_PROXY_SECRET || '';
  const clientIp = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (secret && clientIp) {
    headers['x-buildpipeline-proxy-secret'] = secret;
    headers['x-buildpipeline-client-ip'] = clientIp;
  }
  const res = await fetch(`${api}/api/gtm-funnels/public/${encodeURIComponent(slug)}/${kind}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: 'funnel backend returned a non-JSON response' };
  }
  return NextResponse.json(json, { status: res.status });
}
