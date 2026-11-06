// Funnel config model. Funnels live in Lion Elite OS (gtm_funnels, served by
// GET /api/gtm-funnels/public/:slug — see lib/platform/vsl-funnel.js there), not
// in this app. `demoFunnel` is only used for /funnel/demo when no backend is
// configured, so a local `next dev` still renders something.

export type VideoEmbed = { kind: 'none' | 'iframe' | 'file'; src: string };

export type FunnelConfig = {
  slug: string;
  headline: string;
  subheadline: string;
  videoUrl: string;
  video: VideoEmbed;
  ctaRevealSeconds: number;
  ctaLabel: string;
  calendarUrl: string;
  proof: string[];
  qualificationQuestions: string[];
};

export type FunnelSource = 'backend' | 'demo';

export const demoFunnel: FunnelConfig = {
  slug: 'demo',
  headline: 'Turn More Qualified Prospects Into Booked Sales Calls',
  subheadline:
    'Watch the short presentation to see how BuildPipeline finds, qualifies, nurtures, and books prospects automatically.',
  videoUrl: '',
  video: { kind: 'none', src: '' },
  ctaRevealSeconds: 8,
  ctaLabel: 'See If You Qualify',
  // Deliberately empty: the prototype shipped https://calendly.com/, which sent
  // every qualified lead to Calendly's homepage. The demo shows the booking step
  // as unavailable instead; the backend refuses to publish a funnel without a
  // real scheduling page.
  calendarUrl: '',
  proof: ['Automated lead capture', 'Qualification before booking', 'Email + SMS follow-up ready', 'End-to-end conversion tracking'],
  qualificationQuestions: [
    'What is your company name?',
    'What is your biggest growth bottleneck?',
    'How many qualified sales calls do you book per month?',
    'What is your target monthly revenue?',
  ],
};

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Lion Elite OS origin, e.g. https://lion-elite-os.onrender.com. Server-side only. */
export function backendUrl(): string | null {
  const raw = (process.env.BUILDPIPELINE_API_URL || '').trim().replace(/\/+$/, '');
  return raw || null;
}

export async function getFunnel(slug: string): Promise<{ config: FunnelConfig; source: FunnelSource } | null> {
  if (!SLUG_RE.test(slug)) return null;
  const api = backendUrl();
  if (!api) return slug === 'demo' ? { config: demoFunnel, source: 'demo' } : null;
  const res = await fetch(`${api}/api/gtm-funnels/public/${encodeURIComponent(slug)}`, { next: { revalidate: 60 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`funnel backend returned ${res.status}`);
  const body = (await res.json()) as { funnel: FunnelConfig };
  return { config: body.funnel, source: 'backend' };
}

/** Calendar link carrying the session so a Calendly webhook can match the booking. */
export function calendarHref(config: FunnelConfig, sessionId: string): string {
  if (!config.calendarUrl) return '';
  const url = new URL(config.calendarUrl);
  url.searchParams.set('utm_source', 'buildpipeline');
  url.searchParams.set('utm_campaign', config.slug);
  url.searchParams.set('utm_content', sessionId);
  return url.toString();
}
