import { NextRequest } from 'next/server';
import { forward } from '../../../lib/proxy';

// Analytics events → gtm_funnel_events (PII-free; identity goes via /api/funnel-leads).
export async function POST(req: NextRequest) {
  return forward(req, 'events');
}
