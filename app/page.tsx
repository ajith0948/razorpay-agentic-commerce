import Link from "next/link";
import { ArrowRight, ShoppingCart, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";

const FLOW_STEPS = ["RFQ", "Quote", "Accept", "Order", "Payment"];

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Demo Commerce</h1>
        <p className="text-sm text-muted-foreground">
          A minimal demo UI over the existing RFQ → Quote → Order → Payment API. Pick a side to get started.
        </p>
      </header>

      <div
        aria-hidden
        className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs font-medium text-muted-foreground"
      >
        {FLOW_STEPS.map((step, i) => (
          <span key={step} className="flex items-center gap-2">
            <span className="rounded-md border border-border bg-card px-2 py-1 text-foreground">{step}</span>
            {i < FLOW_STEPS.length - 1 ? <ArrowRight className="size-3.5" /> : null}
          </span>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <ShoppingCart className="size-5 text-muted-foreground" />
            <CardTitle className="mt-2 text-lg">Buyer</CardTitle>
            <CardDescription>
              Submit an RFQ, look up the quote you get back, accept it, place an order, and create a demo payment.
            </CardDescription>
          </CardHeader>
          <CardContent />
          <CardFooter className="justify-end bg-transparent px-4 pt-0">
            <Button render={<Link href="/buyer" />}>
              Open Buyer dashboard
              <ArrowRight />
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <Store className="size-5 text-muted-foreground" />
            <CardTitle className="mt-2 text-lg">Merchant</CardTitle>
            <CardDescription>
              Create an approval request for a quote, then approve or reject it, and look up orders and payments.
            </CardDescription>
          </CardHeader>
          <CardContent />
          <CardFooter className="justify-end bg-transparent px-4 pt-0">
            <Button render={<Link href="/merchant" />}>
              Open Merchant dashboard
              <ArrowRight />
            </Button>
          </CardFooter>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        The buyer/merchant identity used here is a demo selector only, not authentication -- see each dashboard.
        No real Razorpay payment is processed anywhere in this UI.
      </p>
    </div>
  );
}
