import { ApiError } from "@/lib/ui/api-client";

/**
 * Uniform display for a failed API call. Renders nothing when `error` is
 * null/undefined, so call sites can pass their error state directly.
 *
 * Always shows a safe, server-provided (or safely-generic) message -- never
 * a stack trace, since ApiError itself never carries one (every `/api/*`
 * route's 500 response body is always the same fixed safe string; see e.g.
 * app/api/rfqs/error-mapping.ts).
 */
export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) {
    return null;
  }

  const message = error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
  const code = error instanceof ApiError ? error.code : undefined;

  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {code ? <span className="font-semibold">{code}: </span> : null}
      {message}
    </div>
  );
}
