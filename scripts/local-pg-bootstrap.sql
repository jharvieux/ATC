-- Local Postgres bootstrap — stubs the Supabase-managed `auth` schema.
--
-- Supabase Cloud provisions the `auth` schema (GoTrue + helper functions)
-- automatically. A vanilla local Postgres has no `auth.*`, so migrations
-- that reference auth.users / auth.uid() / auth.role() fail on first apply.
--
-- This file creates the minimum needed for migrations to run + RLS
-- policies to evaluate. It is RUN ONCE per fresh test DB BEFORE migrations.
--
-- Apply with:
--   psql -h localhost -d atc_main_test -f scripts/local-pg-bootstrap.sql

CREATE SCHEMA IF NOT EXISTS auth;

-- auth.users — only the columns Supabase exposes that migrations reference.
-- GoTrue also adds email, encrypted_password, email_confirmed_at, etc., but
-- migrations only reference id; tests can insert rows with just id.
CREATE TABLE IF NOT EXISTS auth.users (
  id          UUID PRIMARY KEY,
  email       TEXT,
  role        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- auth.uid() — returns the current authenticated user UUID.
-- In Supabase this is derived from the JWT claim 'sub'. Locally we read it
-- from a SET session var `request.jwt.claim.sub` that the test setup writes.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- auth.role() — returns the current role claim. Tests usually leave this
-- unset; routes that need 'authenticated' / 'service_role' can SET it
-- per-request via SET LOCAL request.jwt.claim.role = '...'.
CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

-- Supabase also seeds 'authenticated' and 'anon' roles; create them if
-- migrations grant against them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    CREATE ROLE service_role;
  END IF;
END $$;
