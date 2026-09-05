"use client";

import { ApprovalPanel, RequestApprovalPanel } from "@/components/merchant/approval-panel";
import { OrderDetails } from "@/components/buyer/order-panel";
import { PaymentDetails } from "@/components/buyer/payment-panel";
import { getOrder, getPayment } from "@/lib/ui/api-client";
import { LookupCard } from "@/components/lookup-card";

export default function MerchantPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Approvals Dashboard</h2>
        <p className="text-muted-foreground">
          Review and process purchase requests requiring merchant approval.
        </p>
      </div>

      <ApprovalPanel />

      <div className="flex flex-col gap-1 mt-4">
        <h3 className="text-xl font-bold tracking-tight">Manual & Lookup Tools</h3>
        <p className="text-sm text-muted-foreground">
          Use these tools to manually request approvals or view specific orders and payments.
        </p>
      </div>

      <div className="grid gap-6">
        <RequestApprovalPanel />

        <div className="grid gap-4 lg:grid-cols-2">
          <LookupCard
            title="View order"
            description="Look up any order by ID."
            idLabel="Order ID"
            onLookup={async (id) => (await getOrder(id)).order}
            renderResult={(order) => (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <OrderDetails order={order} />
              </div>
            )}
          />

          <LookupCard
            title="View payment"
            description="Look up any payment by ID."
            idLabel="Payment ID"
            onLookup={async (id) => (await getPayment(id)).payment}
            renderResult={(payment) => (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <PaymentDetails payment={payment} />
              </div>
            )}
          />
        </div>
      </div>
    </div>
  );
}
