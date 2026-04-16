// Garmin support has been removed from the app.
// Stub kept to return 410 Gone for any lingering callers.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST() {
  return NextResponse.json(
    { error: 'garmin_disabled', message: 'Garmin support has been removed.' },
    { status: 410 },
  );
}
