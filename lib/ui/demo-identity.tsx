"use client";

/**
 * The Demo Commerce UI's demo identity mechanism (Phase 10B).
 *
 * This is deliberately NOT authentication. There is no login, no session,
 * no password, no server-side check of any kind tied to this value -- it is
 * a client-side "who am I pretending to be" picker, entirely for demo
 * narration purposes (e.g. "watch what ABC Textiles sees"). Every API call
 * the UI makes still goes through the same unauthenticated `/api/*` routes
 * regardless of what is selected here; nothing in `lib/*` or the API layer
 * even knows this selector exists. See AGENTS.md section 10 ("Real buyer
 * authentication ... the MVP uses a seeded demo buyer selector/session").
 *
 * Buyer identity is a real choice (5 seeded buyers, supabase/seed.sql) --
 * the buyer picker below lets a presenter switch which one is "acting" so
 * RFQ creation has a real buyerId to submit. Merchant identity is NOT a
 * choice: the seed data creates exactly one merchant (ACME Packaging), so
 * there is nothing to pick between -- DEMO_MERCHANT is a fixed constant,
 * not a selector, which keeps this mechanism as small as the seeded data
 * actually supports rather than adding a one-option dropdown for its own
 * sake. "Which side you're on" (buyer vs. merchant) is expressed by which
 * dashboard you're using (/buyer vs. /merchant), not by a separate role
 * toggle layered on top of that.
 *
 * Easy to replace later with real auth: every consumer of this module goes
 * through useDemoIdentity()/DEMO_MERCHANT, never `localStorage` or
 * `DEMO_BUYERS` directly (component files don't reach into either) -- so
 * swapping this file's internals for a real session lookup later changes
 * nothing at the call sites.
 */

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";

/** The one seeded merchant (supabase/seed.sql section 1). Fixed, not selectable. */
export const DEMO_MERCHANT = {
  id: "11111111-1111-1111-1111-111111111111",
  businessName: "ACME Packaging",
} as const;

export interface DemoBuyer {
  id: string;
  businessName: string;
}

/** The 5 seeded buyers (supabase/seed.sql section 2), all under DEMO_MERCHANT. */
export const DEMO_BUYERS: readonly DemoBuyer[] = [
  { id: "22222222-2222-2222-2222-222222222201", businessName: "ABC Textiles" },
  { id: "22222222-2222-2222-2222-222222222202", businessName: "FreshBox Retail" },
  { id: "22222222-2222-2222-2222-222222222203", businessName: "UrbanCart" },
  { id: "22222222-2222-2222-2222-222222222204", businessName: "Chennai Electronics" },
  { id: "22222222-2222-2222-2222-222222222205", businessName: "South India Distributors" },
];

const STORAGE_KEY = "demo-commerce:buyer-id";

/**
 * Minimal external-store plumbing for useSyncExternalStore below, so that
 * reading the persisted buyer id from localStorage never needs a `setState`
 * call inside a `useEffect` body (a cascading-render pattern this project's
 * lint config flags -- react-hooks/set-state-in-effect). This is the
 * pattern React itself recommends for subscribing to state that lives
 * outside React (https://react.dev/reference/react/useSyncExternalStore).
 *
 * localStorage only fires "storage" events for writes made from OTHER tabs,
 * never the tab that made the write -- so writeStoredBuyerId() also notifies
 * same-tab listeners directly, which is what keeps this tab's own
 * setBuyerId() calls reflected immediately.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStoredBuyerId(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && DEMO_BUYERS.some((b) => b.id === stored) ? stored : DEMO_BUYERS[0].id;
  } catch {
    // localStorage unavailable (e.g. disabled in this browser) -- fall back
    // to the default buyer silently, this is a demo convenience only, never
    // something a real feature depends on.
    return DEMO_BUYERS[0].id;
  }
}

function writeStoredBuyerId(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Same as above -- persistence is a nicety, not a requirement.
  }
  listeners.forEach((listener) => listener());
}

/** Used for both the server render and React's first client hydration pass, so the two always match. */
function getServerSnapshot(): string {
  return DEMO_BUYERS[0].id;
}

interface DemoIdentityContextValue {
  /** The currently-selected demo buyer. Always one of DEMO_BUYERS. */
  buyer: DemoBuyer;
  /** Switch which demo buyer is "acting" -- persisted for this browser only. */
  setBuyerId: (buyerId: string) => void;
}

const DemoIdentityContext = createContext<DemoIdentityContextValue | null>(null);

export function DemoIdentityProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const buyerId = useSyncExternalStore(subscribe, readStoredBuyerId, getServerSnapshot);
  const setBuyerId = useCallback((id: string) => writeStoredBuyerId(id), []);
  const buyer = DEMO_BUYERS.find((b) => b.id === buyerId) ?? DEMO_BUYERS[0];

  return (
    <DemoIdentityContext.Provider value={{ buyer, setBuyerId }}>{children}</DemoIdentityContext.Provider>
  );
}

/** Read/switch the current demo buyer. Must be used under DemoIdentityProvider (mounted once in app/layout.tsx). */
export function useDemoIdentity(): DemoIdentityContextValue {
  const ctx = useContext(DemoIdentityContext);
  if (!ctx) {
    throw new Error("useDemoIdentity() must be used within a DemoIdentityProvider.");
  }
  return ctx;
}
