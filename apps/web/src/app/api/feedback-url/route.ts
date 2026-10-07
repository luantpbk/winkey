import { NextResponse } from 'next/server';
import { sanitizeFeedbackUrl } from '../../../lib/feedback';

export const dynamic = 'force-dynamic';

export async function GET() {
  const feedbackUrl = sanitizeFeedbackUrl(process.env.FEEDBACK_URL);
  return NextResponse.json({ feedbackUrl });
}
