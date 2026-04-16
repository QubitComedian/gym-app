// Garmin support has been removed from the app.
// This file is kept as a stub that returns 410 Gone for any lingering
// callers. Delete it locally with `git rm` when convenient.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(
    { error: 'garmin_disabled', message: 'Garmin support has been removed.' },
    { status: 410 },
  );
}
