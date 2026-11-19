/**
 * Whether `createdAt` (an ISO timestamp from the DB) falls within the
 * inclusive [from, to] range, where `from`/`to` come straight out of a
 * date `<input>` as "YYYY-MM-DD" strings (or are empty/undefined,
 * meaning that side is unbounded). Used by the Facturación page
 * (src/app/(dashboard)/billing/page.tsx) to let Jose narrow ventas /
 * agendados / cancelados down to a date range before totaling them.
 *
 * Compared in the viewer's local time zone — the same zone
 * `formatDistanceToNow` already renders the "Fecha" column in — so a
 * deal placed at 11pm local time on the "from" day is correctly
 * included, not pushed a day earlier/later by a UTC comparison.
 */
export function isWithinDateRange(
  createdAt: string,
  from?: string | null,
  to?: string | null,
): boolean {
  if (!from && !to) return true;
  const created = new Date(createdAt);
  if (from) {
    const fromDate = new Date(`${from}T00:00:00`);
    if (created < fromDate) return false;
  }
  if (to) {
    const toDate = new Date(`${to}T23:59:59.999`);
    if (created > toDate) return false;
  }
  return true;
}
