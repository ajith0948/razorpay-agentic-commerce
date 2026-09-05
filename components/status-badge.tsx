import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Renders a server-provided status string (Rfq/Quote/Order/Payment/Approval
 * status) as a colored badge. Presentational only: this mapping picks a
 * color so a human can tell at a glance whether something looks fine, in
 * progress, or concerning -- it never decides which actions are allowed
 * from a given status, never gates a button, and never drives control flow.
 * The status text itself is always the exact string the API returned,
 * rendered verbatim -- this component does not relabel or invent any
 * status, it only colors the real one.
 *
 * An unrecognized string (should not happen, given api-client.ts's status
 * unions are tested against the real state machine -- see
 * lib/ui/api-client.test.ts) still renders, just in the neutral color,
 * rather than being hidden or throwing.
 */

type Bucket = "neutral" | "progress" | "positive" | "negative";

const STATUS_BUCKETS: Record<string, Bucket> = {
  // Neutral / just created, nothing has happened yet
  CREATED: "neutral",
  DRAFT: "neutral",
  // In progress / awaiting a decision
  PROCESSING: "progress",
  QUOTED: "progress",
  SENT: "progress",
  NEGOTIATING: "progress",
  PENDING: "progress",
  PAYMENT_PENDING: "progress",
  // Positive / succeeded
  ACCEPTED: "positive",
  CONFIRMED: "positive",
  PAID: "positive",
  APPROVED: "positive",
  // Negative / terminal, did not succeed
  REJECTED: "negative",
  EXPIRED: "negative",
  CANCELLED: "negative",
  FAILED: "negative",
  PAYMENT_FAILED: "negative",
};

const BUCKET_CLASSES: Record<Bucket, string> = {
  neutral: "border-border bg-muted text-foreground",
  progress: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  positive: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  negative: "border-transparent bg-red-500/15 text-red-700 dark:text-red-400",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const bucket = STATUS_BUCKETS[status] ?? "neutral";
  return (
    <Badge variant="outline" className={cn(BUCKET_CLASSES[bucket], "font-semibold tracking-wide", className)}>
      {status}
    </Badge>
  );
}
