/**
 * Timezone helpers for the reconciler.
 *
 * We compute the user's "today" in their local timezone so that age-out
 * and the rolling-window generator use a day boundary the user actually
 * experiences. Without this, a Tokyo user at 11pm UTC Monday would see
 * Tuesday's plan flipped to `missed` at what is, for them, still Monday
 * evening.
 *
 * Kept tiny and dep-free: uses `Intl.DateTimeFormat` with a `timeZone`
 * option, which every modern Node runtime and every browser ships with.
 * If we outgrow this (e.g. need full format strings), swap in date-fns-tz.
 */

/**
 * Return the wall-clock date at `tz` in `yyyy-MM-dd` form.
 *
 *   formatInTimeZone(new Date('2026-04-15T22:00:00Z'), 'America/Los_Angeles', 'yyyy-MM-dd')
 *   // => '2026-04-15'
 *   formatInTimeZone(new Date('2026-04-15T22:00:00Z'), 'Asia/Tokyo', 'yyyy-MM-dd')
 *   // => '2026-04-16'
 *
 * The `pattern` argument is there so call sites read well and so we can
 * reject unsupported patterns loudly instead of silently returning the
 * wrong thing. For now only `yyyy-MM-dd` is supported.
 */
export function formatInTimeZone(
  date: Date,
  tz: string,
  pattern: 'yyyy-MM-dd'
): string {
  if (pattern !== 'yyyy-MM-dd') {
    throw new Error(`formatInTimeZone: unsupported pattern ${pattern}`);
  }

  // `en-CA` happens to render as YYYY-MM-DD, which saves us from having
  // to reassemble parts manually in every call. formatToParts still
  // works if we ever need to tweak this.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;

  if (!y || !m || !d) {
    // Shouldn't happen with the options above, but guard anyway.
    throw new Error(`formatInTimeZone: failed to format date for tz=${tz}`);
  }

  return `${y}-${m}-${d}`;
}
