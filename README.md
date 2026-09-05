This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Local Database / Demo Seed Data

The local database runs on the Supabase CLI (Postgres in Docker). Schema
migrations live in `supabase/migrations/`; synthetic demo data (one
merchant, buyers, packaging products, inventory, and a merchant policy —
see `IMPLEMENTATION_PLAN.md` section 6, "Phase 3 — Seed Demo Data") lives
in `supabase/seed.sql`.

```bash
# Start the local Supabase stack (requires Docker Desktop running)
npx supabase start

# Apply all migrations + seed.sql to a fresh local database
npx supabase db reset

# Or, to (re-)apply just the seed data against a running local database
# without resetting it:
npx supabase db execute -f supabase/seed.sql
# equivalent, if you prefer psql directly:
# psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/seed.sql
```

`supabase/seed.sql` is safe to run any number of times: every row uses a
fixed id and is upserted with `ON CONFLICT ... DO UPDATE`, so re-running
it updates the same demo records in place instead of creating duplicates.

All seeded data is synthetic (invented business names, `.example` emails,
placeholder phone numbers) — no real people or real customer data.
