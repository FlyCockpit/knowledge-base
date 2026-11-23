-- Every statement must return zero rows. Write grants (live or revoked) became BOTH; read grants stay NULL.
SELECT 'write grant not backfilled to BOTH' FROM mcp_grant WHERE 'mcp:write' = ANY(scopes) AND "authoringMode" IS DISTINCT FROM 'BOTH' AND id IN ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000a2');
SELECT 'read grant has a write mode' FROM mcp_grant WHERE id='00000000-0000-4000-8000-0000000000a3' AND "authoringMode" IS NOT NULL;
SELECT 'fixture grants lost' WHERE (SELECT count(*) FROM mcp_grant WHERE id::text LIKE '00000000-0000-4000-8000-0000000000a_') <> 4;
SELECT 'oauth write grant not backfilled' FROM mcp_grant WHERE id='00000000-0000-4000-8000-0000000000a4' AND "authoringMode" IS DISTINCT FROM 'BOTH';
DO $$ BEGIN
  BEGIN UPDATE mcp_grant SET "authoringMode"=NULL WHERE id='00000000-0000-4000-8000-0000000000a1'; RAISE EXCEPTION 'missing write-mode check (write without mode)'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE mcp_grant SET "authoringMode"='DREAM' WHERE id='00000000-0000-4000-8000-0000000000a3'; RAISE EXCEPTION 'missing write-mode check (read with mode)'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
