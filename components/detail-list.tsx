import type { ReactNode } from "react";

/**
 * Renders a set of label/value pairs (an entity's fields) in a compact
 * two-column layout. Purely presentational -- callers decide which fields to
 * pass and how to format each value; this component has no knowledge of
 * Rfq/Quote/Order/Payment/Approval shapes itself, so it never becomes a
 * place where a field could be silently invented or renamed.
 */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(({ label, value }) => (
        <div key={label} className="contents">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-medium break-all">{value}</span>
        </div>
      ))}
    </div>
  );
}
