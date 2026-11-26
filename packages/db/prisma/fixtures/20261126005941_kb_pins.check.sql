-- Every statement must return zero rows.
SELECT 'kb_pin one pin per user and base lost' WHERE NOT EXISTS
 (SELECT FROM pg_indexes WHERE tablename='kb_pin' AND indexname='kb_pin_user_kb_unique'
   AND indexdef LIKE 'CREATE UNIQUE INDEX%');
SELECT 'kb_pin user cascade lost' WHERE NOT EXISTS
 (SELECT FROM pg_constraint WHERE conname='kb_pin_userId_fkey' AND confdeltype='c');
SELECT 'kb_pin base cascade lost' WHERE NOT EXISTS
 (SELECT FROM pg_constraint WHERE conname='kb_pin_kbId_fkey' AND confdeltype='c');
SELECT 'kb_pin row without a position' FROM kb_pin WHERE position IS NULL OR position < 0;
