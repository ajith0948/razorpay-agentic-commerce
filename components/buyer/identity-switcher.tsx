"use client";

import { useId } from "react";
import { DEMO_BUYERS, useDemoIdentity } from "@/lib/ui/demo-identity";
import { Label } from "@/components/ui/label";

/**
 * Lets a presenter switch which seeded buyer the Buyer dashboard is "acting
 * as". This is the entire demo identity mechanism for the buyer side -- see
 * lib/ui/demo-identity.tsx for why it is deliberately not authentication.
 *
 * A plain native <select> rather than a new shadcn/base-ui primitive: this
 * project has no Select component installed, and Phase 10B should prefer
 * existing installed UI primitives over adding new ones for a single
 * five-option dropdown.
 */
export function BuyerIdentitySwitcher() {
  const { buyer, setBuyerId } = useDemoIdentity();
  const selectId = useId();

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <Label htmlFor={selectId} className="text-muted-foreground">
        Acting as buyer
      </Label>
      <select
        id={selectId}
        value={buyer.id}
        onChange={(event) => setBuyerId(event.target.value)}
        className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        {DEMO_BUYERS.map((b) => (
          <option key={b.id} value={b.id}>
            {b.businessName}
          </option>
        ))}
      </select>
      <span className="font-mono text-xs text-muted-foreground select-all">{buyer.id}</span>
    </div>
  );
}
