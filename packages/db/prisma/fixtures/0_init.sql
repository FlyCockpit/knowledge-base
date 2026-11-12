-- Synthetic data pinned to 0_init. Loaded immediately after this migration;
-- later migrations must preserve it. Negative checks live in 0_init.check.sql.
INSERT INTO "user" (id,name,email,"emailVerified",role,"twoFactorEnabled") VALUES
 ('fx_owner','Fixture Owner','owner@example.test',true,'admin',true),
 ('fx_reader','Zoë Reader 😀','reader@example.test',false,'user',false);
INSERT INTO account (id,"accountId","providerId","userId",issuer,password) VALUES
 ('fx_account','fx_owner','credential','fx_owner','local:credential','fixture-only');
INSERT INTO app_setting (key,value) VALUES ('fx.boundary','0');
INSERT INTO knowledge_base (id,"ownerId",name,slug,description,state,"headSha") VALUES
 ('fx_kb','fx_owner','Fixture KB','fixture','Unicode 😀 and ''quotes''','ACTIVE',repeat('a',40));
INSERT INTO branch_owner ("kbId","refName","ownerActorKey",purpose) VALUES
 ('fx_kb','refs/heads/fixture','user:fx_owner','USER');
INSERT INTO quota_account (id,dimension,"subjectId",committed,reserved,"updatedAt") VALUES
 ('fx_quota','DISK_VOLUME','fixture',0,1,now());
INSERT INTO quota_reservation (id,"accountId",amount,"opId","expiresAt") VALUES
 ('fx_reservation','fx_quota',1,'fx_op',now()+interval '1 day');
INSERT INTO operation_intent ("opId","updatedAt","actorKey","actorUserIdSnapshot","actorUserId",operation,"idempotencyKey","requestHash","publishNonce","kbId") VALUES
 ('00000000-0000-4000-8000-000000000001',now(),'user:fx_owner','fx_owner','fx_owner','KB_CREATE','fixture','fixture-request','fixture-nonce','fx_kb');
INSERT INTO pull_request ("kbId",number,title,"sourceBranch","baseSha","headSha","targetSha",status,"authorActorKey","isAutoPr","updatedAt") VALUES
 ('fx_kb',1,'Fixture PR','refs/heads/fixture',repeat('a',40),repeat('b',40),repeat('a',40),'OPEN','user:fx_owner',true,now()),
 ('fx_kb',2,'Historical PR','refs/heads/fixture',repeat('a',40),repeat('b',40),repeat('a',40),'CLOSED','user:fx_owner',true,now());
INSERT INTO asset_blob (hash,size,mime) VALUES ('sha256:'||repeat('a',64),1,'image/png');
INSERT INTO kb_asset_lineage ("kbId",hash,"actorKey","actorUserIdSnapshot","actorUserId",source) VALUES
 ('fx_kb','sha256:'||repeat('a',64),'user:fx_owner','fx_owner','fx_owner','UPLOAD');
INSERT INTO staged_upload (id,"kbId","actorKey","actorUserIdSnapshot",kind,"declaredSize","declaredHash","declaredMime","expiresAt","updatedAt") VALUES
 ('00000000-0000-4000-8000-000000000002','fx_kb','user:fx_owner','fx_owner','ASSET',1,'sha256:'||repeat('a',64),'image/png',now()+interval '1 day',now());
INSERT INTO asset_cache_state (id,"storageGeneration",configuration,"effectiveLimit") VALUES
 ('fx_cache','00000000-0000-4000-8000-000000000003','fixture',26214400);
INSERT INTO asset_retained_object ("storageGeneration",locator,hash,size) VALUES
 ('00000000-0000-4000-8000-000000000003','fixture','sha256:'||repeat('a',64),1);
INSERT INTO durable_job (id,"dedupKey",kind,desired,state,"leaseUntil") VALUES
 ('fx_job','fixture','INDEX_KB','{}','RUNNING',now()+interval '1 day');
INSERT INTO index_generation (id,"kbId","jobId",epoch,"commitSha","documentCount","chunkCount") VALUES
 (repeat('a',24),'fx_kb','fx_job',0,repeat('a',40),0,0);
UPDATE index_generation SET state='BUILDING' WHERE id=repeat('a',24);
INSERT INTO generation_document ("generationId",path,"blobSha","contentHash","originalWindowCount","retainedWindowCount",state) VALUES
 (repeat('a',24),'fixture.md',repeat('b',40),'sha256:'||repeat('b',64),1,1,'INDEXED');
UPDATE index_generation SET "documentCount"=1,"chunkCount"=1 WHERE id=repeat('a',24);
UPDATE index_generation SET state='INDEXING' WHERE id=repeat('a',24);
UPDATE index_generation SET state='COMPLETE' WHERE id=repeat('a',24);
UPDATE knowledge_base SET "activeGenerationId"=repeat('a',24) WHERE id='fx_kb';
-- A lease belongs to a live query-embedding request (its durable job).
INSERT INTO durable_job (id,"dedupKey",kind,desired,state) VALUES
 ('fx_lease','fixture-query','QUERY_EMBEDDING','{}','PENDING');
INSERT INTO query_embedding_request (id,"kbId","generationId","actorKey","userId",principal,snapshot,deadline,"scrubAt") VALUES
 ('fx_lease','fx_kb',repeat('a',24),'user:fx_owner','fx_owner','{}','{}',now()+interval '1 hour',now()+interval '1 day');
INSERT INTO generation_lease ("requestId","generationId","expiresAt") VALUES
 ('fx_lease',repeat('a',24),now()+interval '1 day');
INSERT INTO oauth_client (id,"clientId","userId","redirectUris","grantTypes") VALUES
 ('fx_oauth','fixture-client','fx_owner',ARRAY['https://example.test/callback'],ARRAY['authorization_code']);
INSERT INTO oauth_refresh_token (id,token,"clientId","userId","expiresAt") VALUES
 ('fx_refresh','fixture-refresh','fixture-client','fx_owner',now()+interval '1 day');
INSERT INTO oauth_access_token (id,token,"clientId","userId","refreshId","expiresAt") VALUES
 ('fx_access','fixture-access','fixture-client','fx_owner','fx_refresh',now()+interval '1 day');

-- A live build retains a reservation; cancellation must release it first.
INSERT INTO durable_job (id,"dedupKey",kind,desired,state,"leaseUntil") VALUES
 ('fx_job_reserved','fixture-reserved','INDEX_KB','{}','RUNNING',now()+interval '1 day');
INSERT INTO index_generation (id,"kbId","jobId",epoch,"commitSha","documentCount","chunkCount") VALUES
 (repeat('b',24),'fx_kb','fx_job_reserved',1,repeat('b',40),0,0);
UPDATE index_generation SET state='BUILDING',"quotaReservationIds"=ARRAY['fx_reservation'] WHERE id=repeat('b',24);
