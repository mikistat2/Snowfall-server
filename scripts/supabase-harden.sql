-- Run ONCE against the Supabase database, after the restore.
--
-- Why this exists: Neon was a bare Postgres — the only way in was the
-- connection string. Supabase additionally puts PostgREST in front of the
-- `public` schema and serves it over HTTPS to anyone holding the project's
-- anon key. This app never uses that API (it talks to Postgres through Knex),
-- so the whole surface is pure downside: member names, phone numbers, payment
-- history and face descriptors reachable without touching our server.
--
-- Enabling RLS with NO policies makes PostgREST return nothing for every table.
-- It does not affect this app: the connection owns these tables, and a table's
-- owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set (it is not).
--
-- Belt and braces: also remove `public` from the exposed schemas in
-- Dashboard -> Settings -> API -> "Exposed schemas". This script is the part
-- that survives someone putting it back.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- Confirm: every table should read rls_enabled = true, policies = 0.
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY 1;
