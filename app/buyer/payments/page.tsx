"use client";

import { PaymentPanel } from "@/components/buyer/payment-panel";
import { AlertCircle } from "lucide-react";

export default function PaymentsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold tracking-tight">Payments</h2>
        <p className="text-muted-foreground">
          View your payment records and initialize payments for orders.
        </p>
      </div>

      <div className="relative w-full rounded-lg border p-4 [&>svg]:absolute [&>svg]:text-foreground [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&>:not(svg)]:pl-7">
        <AlertCircle className="h-4 w-4" />
        <h5 className="mb-1 font-medium leading-none tracking-tight">API Limitation</h5>
        <div className="text-sm [&_p]:leading-relaxed">
          The backend does not currently provide a list endpoint for Payments. 
          Please look up a payment by its exact ID below.
        </div>
      </div>

      <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50">
              <tr className="text-left font-medium text-muted-foreground">
                <th className="px-4 py-3">Payment ID</th>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No Payments to display. Use the lookup tool below.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4">
        <PaymentPanel />
      </div>
    </div>
  );
}
