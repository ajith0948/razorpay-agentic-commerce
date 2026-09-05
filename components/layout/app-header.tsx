"use client";

import { usePathname } from "next/navigation";
import { BuyerIdentitySwitcher } from "@/components/buyer/identity-switcher";
import { DEMO_MERCHANT } from "@/lib/ui/demo-identity";

export function AppHeader() {
  const pathname = usePathname();
  const isBuyer = pathname.startsWith("/buyer");
  const isMerchant = pathname.startsWith("/merchant");

  // Determine title based on pathname
  let title = "Overview";
  if (pathname.includes("/rfqs")) title = "RFQs";
  else if (pathname.includes("/quotes")) title = "Quotes";
  else if (pathname.includes("/orders")) title = "Orders";
  else if (pathname.includes("/payments")) title = "Payments";
  else if (pathname.includes("/assistant")) title = "AI Assistant";
  else if (isMerchant) title = "Approvals";

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-border bg-background px-4 sm:px-6">
      <div className="flex flex-1 items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      </div>
      
      <div className="flex items-center gap-4">
        {isBuyer ? (
          <BuyerIdentitySwitcher />
        ) : isMerchant ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm">
            <span className="text-muted-foreground">Merchant:</span>
            <span className="font-medium">{DEMO_MERCHANT.businessName}</span>
          </div>
        ) : null}
      </div>
    </header>
  );
}
