-- Every statement must return zero rows. Assertions raise on loss of a former
-- SQL-catalog check, partial unique index, FK, or authority/generation trigger.
SELECT 'owner/head/generation lost' WHERE NOT EXISTS
 (SELECT FROM knowledge_base k JOIN index_generation g ON g.id=k."activeGenerationId"
  WHERE k.id='fx_kb' AND k."ownerId"='fx_owner' AND k."headSha"=repeat('a',40)
    AND g.state='COMPLETE' AND g."documentCount"=1 AND g."chunkCount"=1);
SELECT 'lineage lost' WHERE NOT EXISTS (SELECT FROM kb_asset_lineage WHERE "kbId"='fx_kb' AND hash='sha256:'||repeat('a',64));
SELECT 'operation lost' WHERE NOT EXISTS (SELECT FROM operation_intent WHERE "idempotencyKey"='fixture' AND operation='KB_CREATE');
SELECT 'OAuth lost' WHERE NOT EXISTS (SELECT FROM oauth_access_token a JOIN oauth_refresh_token r ON a."refreshId"=r.id WHERE a.id='fx_access' AND r.id='fx_refresh');
DO $$ DECLARE before_version int; BEGIN
  BEGIN UPDATE knowledge_base SET "ownerId"=NULL WHERE id='fx_kb'; RAISE EXCEPTION 'missing owner check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE knowledge_base SET "headSha"=NULL WHERE id='fx_kb'; RAISE EXCEPTION 'missing head check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO knowledge_base (id,"ownerId",name,slug,description,state,"headSha") VALUES ('fx_duplicate','fx_owner','duplicate','fixture','','ACTIVE',repeat('a',40)); RAISE EXCEPTION 'missing owner slug uniqueness'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE quota_account SET committed=-1 WHERE id='fx_quota'; RAISE EXCEPTION 'missing quota nonnegative'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE quota_reservation SET amount=0 WHERE id='fx_reservation'; RAISE EXCEPTION 'missing positive reservation'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO operation_intent ("opId","updatedAt","actorKey","actorUserIdSnapshot",operation,"idempotencyKey","requestHash","publishNonce") VALUES ('00000000-0000-4000-8000-000000000099',now(),'user:fx_owner','fx_owner','KB_CREATE','fixture','other','other'); RAISE EXCEPTION 'missing create idempotency'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE pull_request SET status='OPEN',"isAutoPr"=false WHERE "kbId"='fx_kb' AND number=2; RAISE EXCEPTION 'missing active source uniqueness'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE pull_request SET status='CONFLICT',"sourceBranch"='different' WHERE "kbId"='fx_kb' AND number=2; RAISE EXCEPTION 'missing auto PR uniqueness'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE asset_blob SET hash='bad' WHERE hash='sha256:'||repeat('a',64); RAISE EXCEPTION 'missing asset hash check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE asset_blob SET size=26214401 WHERE hash='sha256:'||repeat('a',64); RAISE EXCEPTION 'missing asset size check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE staged_upload SET "declaredHash"='bad' WHERE id='00000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'missing staged hash check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE staged_upload SET "declaredSize"=0 WHERE id='00000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'missing staged size check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE staged_upload SET "offset"=2 WHERE id='00000000-0000-4000-8000-000000000002'; RAISE EXCEPTION 'missing staged offset check'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO kb_asset_lineage ("kbId",hash,"actorKey","actorUserIdSnapshot",source) VALUES ('fx_kb','sha256:'||repeat('f',64),'fixture','fx_owner','UPLOAD'); RAISE EXCEPTION 'missing lineage asset FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN UPDATE asset_cache_state SET "chargedBytes"=26214401 WHERE id='fx_cache'; RAISE EXCEPTION 'missing cache bound'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE asset_retained_object SET size=0 WHERE locator='fixture'; RAISE EXCEPTION 'missing retained bound'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE index_generation SET "commitSha"=repeat('c',40) WHERE id=repeat('a',24); RAISE EXCEPTION 'missing immutable snapshot trigger'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE index_generation SET state='BUILDING' WHERE id=repeat('a',24); RAISE EXCEPTION 'missing transition trigger'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE generation_document SET "retainedWindowCount"=0 WHERE "generationId"=repeat('a',24); RAISE EXCEPTION 'missing immutable document trigger'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM generation_document WHERE "generationId"=repeat('a',24); RAISE EXCEPTION 'missing leased document guard'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE index_generation SET state='SUPERSEDED' WHERE id=repeat('a',24); RAISE EXCEPTION 'missing active generation guard'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE generation_lease SET "generationId"=repeat('f',24) WHERE "requestId"='fx_lease'; RAISE EXCEPTION 'missing lease guard'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE knowledge_base SET "activeGenerationId"=repeat('b',24) WHERE id='fx_kb'; RAISE EXCEPTION 'missing active pointer guard'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO generation_document ("generationId",path,"blobSha","contentHash","originalWindowCount","retainedWindowCount",state) VALUES (repeat('b',24),'bad.md',repeat('b',40),'sha256:'||repeat('b',64),0,1,'INDEXED'); RAISE EXCEPTION 'missing document bounds'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE index_generation SET "chunkCount"=-1 WHERE id=repeat('b',24); RAISE EXCEPTION 'missing generation bounds'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO generation_lease ("requestId","generationId","expiresAt") VALUES ('fx_bad_lease',repeat('b',24),now()); RAISE EXCEPTION 'missing nonqueryable lease guard'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE durable_job SET state='CANCELLED' WHERE id='fx_job_reserved'; RAISE EXCEPTION 'missing reservation cancellation guard'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO asset_cache_entry ("cacheId",hash,incarnation,size,state,"fillOwner","tempName") VALUES ('fx_cache','sha256:'||repeat('a',64),'00000000-0000-4000-8000-000000000004',1,'READY','00000000-0000-4000-8000-000000000005','cache-00000000-0000-4000-8000-000000000004'); RAISE EXCEPTION 'missing cache entry bounds'; EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT "authorityVersion" INTO before_version FROM "user" WHERE id='fx_owner';
  UPDATE "user" SET "emailVerified"=NOT "emailVerified" WHERE id='fx_owner';
  IF (SELECT "authorityVersion" FROM "user" WHERE id='fx_owner') <> before_version+1 THEN RAISE EXCEPTION 'missing user authority trigger'; END IF;
  UPDATE account SET password='fixture-changed' WHERE id='fx_account';
  IF (SELECT "authorityVersion" FROM "user" WHERE id='fx_owner') <> before_version+2 THEN RAISE EXCEPTION 'missing credential authority trigger'; END IF;
  UPDATE "user" SET "authorityVersion"=0 WHERE id='fx_owner';
  IF (SELECT "authorityVersion" FROM "user" WHERE id='fx_owner') <> before_version+2 THEN RAISE EXCEPTION 'authority version can be lowered'; END IF;
  BEGIN INSERT INTO oauth_access_token (id,token,"clientId","expiresAt") VALUES ('fx_bad_oauth','fixture-bad','missing-client',now()); RAISE EXCEPTION 'missing OAuth client FK'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  -- Roll back the probe updates too; this is an assertion, not a data migration.
  RAISE EXCEPTION USING ERRCODE='P9999';
EXCEPTION WHEN SQLSTATE 'P9999' THEN NULL;
END $$;
