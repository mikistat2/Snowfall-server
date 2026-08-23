-- Tables ordered so every parent loads before its children (FK-safe).
-- Self-referencing FKs are ignored: they resolve within a single table's load.
-- knex_migrations* are excluded — the migrations themselves populate those.
WITH RECURSIVE fk AS (
  SELECT DISTINCT c.conrelid AS child, c.confrelid AS parent
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    AND c.conrelid <> c.confrelid
), tabs AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname NOT LIKE 'knex_migrations%'
), depth AS (
  SELECT t.oid, 0 AS d FROM tabs t WHERE NOT EXISTS (SELECT 1 FROM fk WHERE fk.child = t.oid)
  UNION ALL
  SELECT fk.child, d.d + 1 FROM depth d JOIN fk ON fk.parent = d.oid
)
SELECT c.relname FROM depth JOIN pg_class c ON c.oid = depth.oid
GROUP BY c.relname ORDER BY max(depth.d), c.relname;
