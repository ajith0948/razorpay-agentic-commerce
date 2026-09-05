/**
 * Presentational formatting helpers shared by the Demo Commerce UI. These
 * only format values the API already returned -- they never compute a
 * price, decide a status, or otherwise duplicate logic that belongs in
 * `lib/*`.
 */

/** Formats an amount + ISO currency code (e.g. 2400, "INR") as "₹2,400.00". */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amount);
  } catch {
    // Intl throws for an unrecognized currency code -- fall back to a plain
    // number rather than letting a bad/unknown currency string crash render.
    return `${amount} ${currency}`;
  }
}

/** Formats an ISO timestamp for display, or a placeholder when absent. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return "--";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
