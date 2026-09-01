-- Phase 1: Database Foundation
--
-- Enable pgcrypto so gen_random_uuid() is available for primary key
-- defaults. Modern Postgres ships gen_random_uuid() in core, but enabling
-- pgcrypto explicitly keeps this portable across Postgres versions and
-- matches Supabase's own project template.
create extension if not exists pgcrypto with schema extensions;
