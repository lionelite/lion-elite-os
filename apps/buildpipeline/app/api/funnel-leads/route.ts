import { NextRequest } from 'next/server';
import { forward } from '../../../lib/proxy';

// Application → CRM prospect (gtm_prospects + gtm_evidence + gtm_funnel_leads).
export async function POST(req: NextRequest) {
  return forward(req, 'leads');
}
