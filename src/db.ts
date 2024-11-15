import format from 'pg-format';
import { Client, ClientConfig, QueryResult, types } from 'pg';
import { DRY_RUN_PREFIX } from './utils';
import { readFileSync } from 'fs';

type ConnectionInfo = ClientConfig & Required<Pick<ClientConfig, 'host' | 'port' | 'database' | 'user'>>;

type ConnectionConfig = {
  blue: ConnectionInfo;
  green: ConnectionInfo;
  proxy: ConnectionInfo;
  pgbouncer: ConnectionInfo;
};

let configLoaded = false;
let connectionConfigs: ConnectionConfig;

export function getDatabaseConfig(db: keyof ConnectionConfig): ConnectionInfo {
  if (configLoaded) {
    return connectionConfigs[db];
  }

  const configRaw = readFileSync('db.config.json', 'utf8');
  connectionConfigs = JSON.parse(configRaw) as ConnectionConfig;

  configLoaded = true;
  return connectionConfigs[db];
}

export const BlueConnection: ConnectionInfo = getDatabaseConfig('blue');
export const GreenConnection: ConnectionInfo = getDatabaseConfig('green');
export const ProxyConnection: ConnectionInfo = getDatabaseConfig('proxy');
export const PgbouncerConnection: ConnectionInfo = getDatabaseConfig('pgbouncer');

const connectedClients: Client[] = [];

let typesSet = false;

export async function connect(config: ConnectionInfo): Promise<Client> {
  if (!typesSet) {
    // the default interval parser is really verbose
    types.setTypeParser(types.builtins.INTERVAL, (v) => {
      const dotIdx = v.indexOf('.');
      if (dotIdx > -1) {
        return v.slice(0, dotIdx + 4);
      }
      return v;
    });
    types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => {
      const dateStr = new Date(v).toISOString();
      const dotIdx = dateStr.indexOf('.');
      if (dotIdx > -1) {
        return dateStr.slice(0, dotIdx);
      }
      return dateStr;
    });
    typesSet = true;
  }

  const client = new Client({ ...config, connectionTimeoutMillis: 5000 });
  await client.connect();
  connectedClients.push(client);

  client.on('error', (err) => {
    console.error('pg error:', err);
  });
  client.on('notice', (msg) => {
    console.log('pg notice', msg);
  });
  client.on('notification', (msg) => {
    console.log('pg notification', msg);
  });

  return client;
}

type CheckConnectivityResults = {
  blue?: Error | string;
  green?: Error | string;
  proxy?: Error | string;
  pgbouncer?: Error | string;
};

export async function checkConnectivity({
  blueClient,
  greenClient,
  proxyClient,
  pgbouncerClient,
}: {
  blueClient?: Client;
  greenClient?: Client;
  proxyClient?: Client;
  pgbouncerClient?: Client;
}): Promise<CheckConnectivityResults> {
  const settlements = await Promise.allSettled([
    blueClient?.query('select version()'),
    greenClient?.query('select version()'),
    proxyClient?.query('select version()'),
    pgbouncerClient?.query('show databases;'),
  ]);

  const intermediate = {
    blue: settlements[0],
    green: settlements[1],
    proxy: settlements[2],
    pgbouncer: settlements[3],
  };

  const results = Object.fromEntries(
    Object.entries(intermediate).map(([key, value]) => {
      if (value.status === 'rejected') {
        // throw new Error(value.reason);
        return [key, value.reason instanceof Error ? value.reason : new Error(value.reason)];
      }

      if (!value.value) {
        return [key, 'not checked'];
      }

      return [key, JSON.stringify(value.value.rows[0])];
    })
  );

  return results;
}

export const PgBouncerPoolsColumns = [
  'database',
  'user',
  'cl_active',
  'cl_waiting',
  'cl_active_cancel_req',
  'cl_waiting_cancel_req',
  'sv_active',
  'sv_active_cancel',
  'sv_being_canceled',
  'sv_idle',
  'sv_used',
  'sv_tested',
  'sv_login',
  'maxwait',
  'maxwait_us',
  'pool_mode',
];

type PgBouncerPool = { database: string; name: string };

export async function getPgBouncerPools(client: Client): Promise<QueryResult<PgBouncerPool>> {
  return client.query<PgBouncerPool>('show pools;');
}

export const PgBouncerDatabasesColumns = [
  'name',
  'host',
  'port',
  'database',
  'force_user',
  'pool_size',
  'min_pool_size',
  'reserve_pool',
  'pool_mode',
  'max_connections',
  'current_connections',
  'paused',
  'disabled',
];

type PgBouncerDatabase = { name: string; host: string; database: string; paused: string; disabled: string };

export async function getPgBouncerDatabases(client: Client): Promise<QueryResult<PgBouncerDatabase>> {
  return client.query<PgBouncerDatabase>('show databases;');
}

export async function disconnectAll(): Promise<void> {
  for (const client of connectedClients) {
    await client.end();
  }
}

export const ConnectionColumns = [
  'pid',
  'datname',
  'usename',
  'appname',
  'state',
  'backend_start',
  'xact_start',
  'query_start',
  'state_change',
  'time',
  'wait_event_type',
  'wait_event',
  'query',
] as const;

type ConnectionRow = {
  pid: number;
  datname: string;
  usename: string;
  appname: string;
  state: string;
  backend_start: Date;
  xact_start: Date;
  query_start: Date;
  state_change: Date;
  time: string;
  wait_event_type: string;
  wait_event: string;
  query: string;
};
export async function getConnections(client: Client): Promise<QueryResult<ConnectionRow>> {
  return client.query<ConnectionRow>(`select RPAD(pid::text, 6, ' ') as pid, datname, usename, left(application_name, 15) as appname, RPAD(state, 10, ' ') as state,
  backend_start, COALESCE(xact_start, '1970-01-01') as xact_start, query_start, state_change, GREATEST(current_timestamp - state_change, INTERVAL '0m') as time, wait_event_type,
  wait_event, left(regexp_replace(query,E'[\\n\\r]+',' ','g'), 40)
  FROM pg_stat_activity
  WHERE pid<>pg_backend_pid()
  AND datname = 'medplum'
  AND application_name <> 'my_subscription'
  ORDER BY datname, state, usename, current_timestamp - state_change`);
}

export const ReplicationLagColumns = ['slot_name', 'active', 'pid', 'diff_size', 'diff_bytes'];

export type ReplicationLagRow = {
  slot_name: string;
  active: boolean;
  pid: number;
  diff_size: string;
  diff_bytes: number;
};
export async function getReplicationLag(client: Client): Promise<QueryResult<ReplicationLagRow>> {
  const results =
    await client.query<ReplicationLagRow>(`SELECT slot_name, active, active_pid, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(),
confirmed_flush_lsn)) AS diff_size, pg_wal_lsn_diff(pg_current_wal_lsn(),
confirmed_flush_lsn) AS diff_bytes FROM pg_replication_slots WHERE slot_type = 'logical'`);
  for (const row of results.rows) {
    row.diff_bytes = parseInt(row.diff_bytes.toString(), 10);
  }

  return results;
}

export async function getReplicationLagForSlot(client: Client, slotName: string): Promise<number> {
  const results = await getReplicationLag(client);
  const slotRow = results.rows.find((row) => row.slot_name === slotName);

  if (!slotRow) {
    throw new Error(`Replication slot not found: ${slotName}`);
  }

  if (slotRow.diff_bytes === undefined || Number.isNaN(slotRow.diff_bytes)) {
    throw new Error(`Invalid diff_bytes: ${slotRow.diff_bytes}`);
  }

  return slotRow.diff_bytes;
}

type SequenceLastValueRow = { schemaname: string; sequencename: string; last_value: number };
export async function getSequenceLast(client: Client): Promise<QueryResult<SequenceLastValueRow>> {
  const results = await client.query<SequenceLastValueRow>(
    `SELECT schemaname, sequencename, last_value FROM pg_sequences where schemaname = 'public'`
  );

  for (const row of results.rows) {
    row.last_value = parseInt(row.last_value.toString(), 10);
  }

  return results;
}

type PauseDBParams = { pgbouncerClient: Client; dbName: string; dryRun: boolean };
export async function pauseDatabase({ pgbouncerClient, dbName, dryRun }: PauseDBParams): Promise<void> {
  if (dryRun) {
    console.log(DRY_RUN_PREFIX + 'Simulating pausing database...');
    await sleep(1000);
    console.log(DRY_RUN_PREFIX + 'Paused');
    return undefined;
  }

  console.log('Pausing database...');
  const result = await pgbouncerClient.query(`PAUSE ${dbName}`);
  console.log('Paused', result.command);
  return undefined;
}

type ResumeDBParams = { pgbouncerClient: Client; dbName: string; dryRun: boolean };
export async function resumeDatabase({ pgbouncerClient, dbName, dryRun }: ResumeDBParams): Promise<void> {
  if (dryRun) {
    console.log(DRY_RUN_PREFIX + 'Simulating resuming database...');
    await sleep(100);
    console.log(DRY_RUN_PREFIX + 'Resumed');
    return undefined;
  }

  console.log('Resuming database...');
  const result = await pgbouncerClient.query(`RESUME ${dbName}`);
  console.log('Resumed', result.command);
  return undefined;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type DataEquivalencyParams = {
  tableName: string;
  startTimestamp: string;
  endTimestamp?: string;
  blueClient: Client;
  greenClient: Client;
};
export async function checkDataEquivalency({
  tableName,
  startTimestamp,
  endTimestamp,
  blueClient,
  greenClient,
}: DataEquivalencyParams): Promise<void> {
  if (!endTimestamp) {
    const endDate = new Date();
    endDate.setMinutes(endDate.getMinutes() - 5);
    endTimestamp = endDate.toISOString().replace('T', ' ');
  }

  const query = `SELECT id, content FROM %I WHERE "lastUpdated" BETWEEN %L AND %L ORDER BY "lastUpdated", id`;
  const formattedQuery = format(query, tableName, startTimestamp, endTimestamp);
  const blueResults = await blueClient.query<{ id: string; content: string }>(formattedQuery);
  const greenResults = await greenClient.query(formattedQuery);

  const prefix = `Table ${tableName}:`;
  if (blueResults.rows.length !== greenResults.rows.length) {
    throw new Error(`${prefix} mismatch row count blue: ${blueResults.rows.length} green: ${greenResults.rows.length}`);
  }

  type Mismatch = { n: number; blue: string; green: string };
  const mismatchedRows: Mismatch[] = [];
  for (let i = 0; i < blueResults.rows.length; i++) {
    const blueRow = blueResults.rows[i];
    const greenRow = greenResults.rows[i];
    if (blueRow.id !== greenRow.id || blueRow.content !== greenRow.content) {
      mismatchedRows.push({ n: i, blue: JSON.stringify(blueRow), green: JSON.stringify(greenRow) });
    }
  }

  if (mismatchedRows.length > 0) {
    console.error(`${prefix} data mismatch in ${mismatchedRows.length} rows`);
    console.table(mismatchedRows);
    throw new Error(`Data mismatch: ${tableName}`);
  }

  console.log(
    `Table ${tableName}: id and content equivalent over ${blueResults.rows.length} rows with lastUpdated between ${startTimestamp} and ${endTimestamp}`
  );
}
