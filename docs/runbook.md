## Medplum Postgres Upgrade Runbook

This is intended to be a living document/checklist to aid you through your database upgrade
process. Copy it to somewhere that allows you to easily check-off the checklist items, write
values, edit as necessary, and share with your team to follow along in realtime. We used Notion.

For more information on this runbook, see our [blog post](TODO).

_Use this table as a centralized place to write down various values that will be needed throughout the upgrade process._

| Item | Value |
| --- | --- |
| Jumpbox host |  |
| PgBouncer host |  |
| Added SG rules |  |
| green cluster writer host | e.g. medplumstack-backenddatabase-pg16-cluster.cluster-xxxxxxxxxxxx.us-east-1.rds.amazonaws.com |
| green subnet group name |  |
| green security group ID |  |
| blue create replication slot output | e.g. (my_replication_slot,0/F0407060)  |
| green initial LSN | e.g. 0/F09A41E0 |
| extensions upgraded | e.g. pg_trgm 1.4 --> 1.6 |
| ReaderDatabaseSecret value | e.g. arn:aws:secretsmanager:us-east-1:123412341234:secret:MedplumProdDatabaseReaderInstance-xxxxxx |
| DB secret w/ blue |  |
| DB secret w/ pgbouncer |  |
| DB secret w/ green |  |
| reader DB secret w/ blue |  |
| reader DB secret w/ green |  |


### 48+ hours ahead of maintenance window

- [ ]  Update cluster parameter group to enable logical replication
    - [ ]  Enable RDS Proxy
    
    ```json
    "rds.logical_replication": "1",
    "max_replication_slots": "25",
    "max_wal_senders": "25",
    "max_logical_replication_workers": "25",
    "max_worker_processes": "50",
    ```
    
    - [ ]  Restart database to apply
    - [ ]  Disable RDS Proxy
- [ ]  Provision PgBouncer server based on`medplum-ee/packages/pg-upgrade/README.md`
- [ ]  Provision jumpbox server
    - [ ]  Install psql, Makefile, .pgpass, etc.
    - [ ]  Sync pg-upgrade package
    - [ ]  Test cutover script with expected failures since green does not exist
        - [ ]  Ensure SSH connectivity to PgBouncer
        - [ ]  Ensure Postgres connectivity to PgBouncer
- [ ]  Update Security Groups to allow connectivity
    - [ ]  Copy PgBouncer SG URL above
    - [ ]  Copy Jumpbox SG URL above
    - [ ]  Copy rules added to `Medplum<Name>-BackEndDatabaseClusterSecurityGroup` above

## 24 hours ahead of maintenance window

- [ ]  On blue, ensure all tables have PKEY or REPLICA IDENTITY FULL
    - [ ]  Run all `ALTER TABLE` statements output by the query below
    - [ ]  Verify no rows are returned by the query below
    
    ```sql
    SELECT
      'ALTER TABLE "' || tablename || '" REPLICA IDENTITY FULL;'
    FROM pg_tables t
    WHERE t.schemaname IN ('public')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_constraint c ON i.indexrelid = c.conindid
        WHERE i.indrelid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass
        AND c.contype = 'p'  -- 'p' for primary key
      )
      AND EXISTS (
        SELECT 1
        FROM pg_class c
        WHERE c.oid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass
        AND c.relreplident = 'd'  -- 'd' stands for default replica identity
      )
    ORDER BY schemaname, tablename;
    ```
    
- [ ]  On blue, create publication and replication slot:
    
    ```sql
    SELECT * FROM pg_publication;
    CREATE PUBLICATION my_publication FOR ALL TABLES;
    
    SELECT * FROM pg_replication_slots;
    SELECT pg_create_logical_replication_slot('my_replication_slot', 'pgoutput');
    ```
    
- [ ]  Write output from `pg_create_logical_replication_slot` query into `blue create replication slot output` in table above
- [ ]  Create Subnets Group named like `medplum<name>-backenddatabaseclusterpg16subnets`
    - [ ]  Supply a description
    - [ ]  Use correct VPC
    - [ ]  Match AZs and Subnets from previous subnets group
    - [ ]  Copy subnet group name in table above
- [ ]  Create Security Group named like `Medplum<Name>-BackEndDatabaseCluterPG16SecurityGroup`
    - [ ]  Inbound from MedplumSecurityGroup
    - [ ]  Use correct VPC
    - [ ]  Copy security group ID in table above
- [ ]  Create green cluster via Actions -> Create clone
    - [ ]  DB Instance Identifier `medplum<stackname>-backenddatabase-pg16`
    - [ ]  Choose subnet group created above
    - [ ]  Choose security group created above
    - [ ]  Specify Initial database name as `medplum`
    - [ ]  Log exports > check PostgreSQL log
    - [ ]  Enable deletion protection
    - [ ]  Write green cluster host into `green cluster writer host` in table above
- [ ]  On green, obtain initial LSN of green writer BEFORE starting version upgrade
    - [ ]  Sanity check it is larger than value in `blue create replication slot output` from table above

    
    ```bash
    # if on postgres <=12.9
    ./get-start-lsn.sh <writer-db-instance-id>
    
    # if on postgres >=12.10
    SELECT aurora_volume_logical_start_lsn();
    ```
    
    - [ ]  Write LSN into `green initial LSN` in table above
- [ ]  On green, delete replication slot and publication
    
    ```sql
    SELECT * FROM pg_replication_slots;
    SELECT pg_drop_replication_slot('my_replication_slot');
    
    SELECT * FROM pg_publication;
    DROP PUBLICATION my_publication;
    ```
    
- [ ]  On green, upgrade to desired Major version, e.g. 16.4
- [ ]  On green, upgrade extensions to newest versions
    
    ```sql
    SELECT extname, extversion FROM pg_extension ORDER BY extname;
    SELECT name, max(version) FROM pg_available_extension_versions WHERE name IN (SELECT extname FROM pg_extension) GROUP BY name ORDER BY name;
    
    ALTER EXTENSION extension_name UPDATE TO 'new_version';
    ```
    
- [ ]  On green, create subscription. transaction and SET LOCALs to prevent password being logged
    
    ```sql
    BEGIN;
    SET LOCAL log_statement='none';
    SET LOCAL log_min_duration_statement=-1;
    CREATE SUBSCRIPTION my_subscription 
    CONNECTION 'postgres://admin_user_name:admin_user_password@blue-host/database' PUBLICATION my_publication 
    WITH (copy_data = false, create_slot = false, enabled = false, connect = true, slot_name = 'my_replication_slot');
    COMMIT;
    ```
    
- [ ]  On green, advance replication origin
    
    ```sql
    SELECT * FROM pg_replication_origin;
    
    -- replace <roname> with roname from pg_replication_origin query
    -- replace <initial LSN> with initial LSN value obtained above
    SELECT pg_replication_origin_advance('<roname>', '<initial LSN>');
    ```
    
- [ ]  On green, enable logical replication
    
    ```sql
    ALTER SUBSCRIPTION my_subscription ENABLE;
    ```
    
- [ ]  On blue, monitor replication lag
    
    ```sql
    SELECT now() AS CURRENT_TIME, slot_name, active, active_pid, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),
    confirmed_flush_lsn)) AS diff_size, pg_wal_lsn_diff(pg_current_wal_lsn(),
    confirmed_flush_lsn) AS diff_bytes FROM pg_replication_slots WHERE slot_type = 'logical';
    ```
    
    - [ ]  Wait for `diff_size` and `diff_bytes` reach 0, replication has caught up.
- [ ]  On green, analyze the database after replication has caught up. (staging took 20 minutes)
    
    ```sql
    -- ANALYZE can take a while depending on the size of your database and server, so set a high timeout
    SET statement_timeout = '999min';
    SELECT now();
    ANALYZE VERBOSE;
    SELECT now();
    
    -- 2024-10-22 01:56:00.307045+00
    -- 2024-10-22 04:11:06.133202+00
    
    SELECT now(), count(1), min(relname), max(relname) FROM pg_stat_all_tables WHERE schemaname = 'public' AND greatest(coalesce(last_autoanalyze, '2024-01-01'), coalesce(last_analyze, '2024-01-01')) < '2024-10-22 01:56:00.307045+00';
    SELECT schemaname, relname, last_autoanalyze, last_analyze FROM pg_stat_all_tables WHERE schemaname = 'public' ORDER BY relname;
    SELECT count(1), min(relname), max(relname), string_agg(relname, '", "') FROM pg_stat_all_tables WHERE schemaname = 'public' AND COALESCE(last_autoanalyze, last_analyze) IS NULL;
    ```
    

## 1 hour before maintenance window

- [ ]  Add readers to green cluster
- [ ]  Remove RDS Proxy, `/medplum/${name}/databaseProxyEndpoint`, from server config if present
- [ ]  Remove usage of readers from server config
    - [ ]  Copy arn stored in value of `/medplum/prod/ReaderDatabaseSecrets` to table above
    - [ ]  delete `/medplum/prod/ReaderDatabaseSecrets`
    - [ ]  delete `/medplum/prod/readonlyDatabase.disableConnectionConfiguration` if present
    - [ ]  Redeploy
- [ ]  Add PgBouncer to server config secret, NOT using `/medplum/${name}/databaseProxyEndpoint` since we need `ssl.rejectUnauthorized = false`
    - [ ]  Update `DatabaseSecrets` secret with value from `DB secret w/ pgbouncer` in table above
    - [ ]  Redeploy

## Cutover during maintenance window

- [ ]  Query CloudWatch logs for 500s
- [ ]  Run `npx tsx src/cli.ts`
- [ ]  Run `npx tsx src/cutover.ts --dry-run`
    - [ ]  Review output
- [ ]  Start k6 constant.js script
- [ ]  Wait for no elevated load, batch jobs, etc. before continuing
- [ ]  Run `npx tsx src/cutover.ts --no-dry-run`
    - [ ]  Review output
- [ ]  Ensure server working as expected
- [ ]  Review Cloudwatch logs for 500s
- [ ]  On green, disable and drop subscription (w/o the ALTER statement, the replication slot on blue is also dropped)
    
    ```sql
    -- ALTER SUBSCRIPTION my_subscription SET (slot_name = NONE);
    DROP SUBSCRIPTION my_subscription;
    ```
    
- [ ]  On blue, drop publication and verify replication slot is dropped
    
    ```sql
    DROP PUBLICATION my_publication;
    SELECT * FROM pg_publication;
    
    SELECT * FROM pg_replication_slots;
    ```
    
- [ ]  On green, drop all REPLICA IDENTITY FULL
    - [ ]  Run all `ALTER TABLE` statements output by the query below
    - [ ]  Verify no rows are returned by the query below
    
    ```sql
    SELECT
      'ALTER TABLE "' || tablename || '" REPLICA IDENTITY DEFAULT;'
    FROM pg_tables t
    WHERE t.schemaname IN ('public')
      AND EXISTS (
        SELECT 1
        FROM pg_class c
        WHERE c.oid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass
        AND c.relreplident = 'f'  -- 'f' means REPLICA IDENTITY FULL
      )
    ORDER BY schemaname, tablename;
    ```
    
- [ ]  Remove PgBouncer from server config
    - [ ]  Update Secret pointed to by `/medplum/prod/DatabaseSecrets` with value from `DB secret w/ green` in table above
    - [ ]  Redeploy
- [ ]  Add usage of GREEN readers to server config
    - [ ]  Update ReaderDatabaseSecrets with value from `reader DB secret w/ green` in table above
    - [ ]  Create `/medplum/prod/ReaderDatabaseSecrets` with value of `ReaderDatabaseSecret value` in table above
    - [ ]  Create `/medplum/prod/readonlyDatabase.disableConnectionConfiguration` with value `true`
    - [ ]  Redeploy

## Next day

- [ ]  Rectify CDK config with new RDS cluster (w/o any shutdowns/replacements)
- [ ]  Shutdown/terminate blue database
- [ ]  Shutdown/terminate PgBouncer server
- [ ]  Shutdown/terminate jumpbox
- [ ]  Clean up security groups
    - [ ]  Delete PgBouncer security group
    - [ ]  Delete Jumpbox security group
    - [ ]  Remove rules
- [ ]  Update dashboards
- [ ]  (optional) Disable logical replication on new cluster (requires reboot)
    - [ ]  Is there actually a performance implication of leaving it enabled?

### Helpful debugging queries

```sql
WITH inactive_connections AS (
SELECT
  pid,
  datname,
  usename,
  application_name,
  (current_timestamp - state_change) as idle_time,
  rank() over (order by current_timestamp - state_change ASC) as rank
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()    
-- AND application_name ~ '(medplum-server)|(^$)'
AND datname = 'medplum'
AND usename = 'clusteradmin'
AND state in ('idle', 'idle in transaction', 'idle in transaction (aborted)', 'disabled') 
AND current_timestamp - state_change >= interval '1 seconds'
ORDER BY idle_time
) SELECT pg_terminate_backend(pid) FROM inactive_connections WHERE rank >= 1;
```

```sql
SELECT pid,datname,usename,query FROM pg_stat_activity where state <> 'idle' AND pid<>pg_backend_pid();
```

### References

- [Prevent logging password](https://postgrespro.com/list/thread-id/2367767)
- [Import resources into CDK stack](https://aws.amazon.com/blogs/devops/how-to-import-existing-resources-into-aws-cdk-stacks/)
- [PgBouncer config](https://www.pgbouncer.org/config.html)
- PgBouncer SSL setup [percona](https://www.percona.com/blog/enabling-ssl-tls-sessions-in-pgbouncer/) [crunchydata](https://www.crunchydata.com/blog/improving-pgbouncer-security-with-tlsssl)
