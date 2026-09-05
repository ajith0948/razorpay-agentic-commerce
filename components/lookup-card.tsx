"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiErrorAlert } from "@/components/api-error-alert";

/**
 * "Enter an ID, click Load, see the result" -- the shared shape behind every
 * lookup-by-id control in this UI (RFQ, Order, Payment views; the Quote
 * panel implements the same idea itself since it also needs an Accept
 * action). This exists because none of these resources have a list
 * endpoint, so "browse and pick one" is not an option this phase can offer
 * -- see lib/ui/api-client.ts's doc comments for why that endpoint doesn't
 * exist and isn't being added here.
 *
 * This component only orchestrates request state (idle/loading/error/
 * success) around a caller-supplied `onLookup`; it has no idea what kind of
 * resource it's fetching or what a "valid" id looks like.
 */
export function LookupCard<T>({
  title,
  description,
  idLabel = "ID",
  idPlaceholder,
  onLookup,
  renderResult,
}: {
  title: string;
  description: string;
  idLabel?: string;
  idPlaceholder?: string;
  onLookup: (id: string) => Promise<T>;
  renderResult: (data: T) => ReactNode;
}) {
  const inputId = useId();
  const [id, setId] = useState("");
  const [state, setState] = useState<
    { status: "idle" } | { status: "loading" } | { status: "error"; error: unknown } | { status: "success"; data: T }
  >({ status: "idle" });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    setState({ status: "loading" });
    try {
      const data = await onLookup(trimmed);
      setState({ status: "success", data });
    } catch (error) {
      setState({ status: "error", error });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor={inputId}>{idLabel}</Label>
            <Input
              id={inputId}
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder={idPlaceholder}
              autoComplete="off"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={state.status === "loading" || id.trim().length === 0}
          >
            {state.status === "loading" ? "Loading…" : "Load"}
          </Button>
        </form>
        {state.status === "error" ? <ApiErrorAlert error={state.error} /> : null}
        {state.status === "success" ? renderResult(state.data) : null}
      </CardContent>
    </Card>
  );
}
