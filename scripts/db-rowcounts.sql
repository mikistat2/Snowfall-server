-- Exact row counts for every base table in `public`, one round trip.
--
-- `pg_stat_user_tables.n_live_tup` would be cheaper but it is an ESTIMATE
-- maintained by autovacuum, and an estimate cannot answer "did the migration
-- lose a row". query_to_xml runs a real count(*) per table.
SELECT table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text::bigint AS rows
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
