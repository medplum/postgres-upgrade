import blessed from 'blessed';
import {
  BlueConnection,
  connect,
  ConnectionColumns,
  getConnections,
  getPgBouncerDatabases,
  getPgBouncerPools,
  getReplicationLag,
  GreenConnection,
  PgbouncerConnection,
  PgBouncerDatabasesColumns,
  PgBouncerPoolsColumns,
  ReplicationLagColumns,
} from './db';
import { Client, QueryResultRow } from 'pg';

const screen = blessed.screen({
  smartCSR: true,
  debug: true,
});

const CONNECTION_HEIGHT = 60;
const REPLICATION_LAG_Y = CONNECTION_HEIGHT + 1;
const REPLICATION_LAG_HEIGHT = 4;
const PGBOUNCER_DBS_Y = REPLICATION_LAG_Y + REPLICATION_LAG_HEIGHT + 1;
const PGBOUNCER_DBS_HEIGHT = 10;
const PGBOUNCER_POOLS_Y = PGBOUNCER_DBS_Y + PGBOUNCER_DBS_HEIGHT + 1;

function makeConnectionListTable(options?: blessed.Widgets.ListTableOptions): blessed.Widgets.ListTableElement {
  return blessed.listtable({
    parent: screen,
    align: 'left',
    tags: true,
    border: 'line',
    width: '49%',
    height: CONNECTION_HEIGHT,
    ...options,
    columnWidth: [5, 10, 10, 15, 10, 20, 20, 20, 20, 10, 10, 10, 40],
  });
}
const blue = makeConnectionListTable({
  label: 'Blue connections',
  top: 0,
  left: 0,
});
const green = makeConnectionListTable({
  label: 'Green connections',
  top: 0,
  right: 0,
});

const replicationLag = blessed.listtable({
  parent: screen,
  label: 'Replication lag',
  align: 'left',
  border: 'line',
  top: REPLICATION_LAG_Y,
  left: 0,
  width: 100,
  height: REPLICATION_LAG_HEIGHT,
});

const pgbouncerDbs = blessed.listtable({
  parent: screen,
  label: 'PgBouncer databases',
  align: 'left',
  border: 'line',
  top: PGBOUNCER_DBS_Y,
  left: 0,
  width: 100,
  height: PGBOUNCER_DBS_HEIGHT,
});

const pgbouncerPools = blessed.listtable({
  parent: screen,
  label: 'PgBouncer pools',
  align: 'left',
  border: 'line',
  top: PGBOUNCER_POOLS_Y,
  left: 0,
  width: 100,
  height: 10,
});

const debug = blessed.box({
  parent: screen,
  focusable: false,
  bottom: 0,
  right: 0,
  label: 'DEBUG',
  width: '100%',
  height: 10,
  tags: true,
  border: {
    type: 'line',
  },
});

// const input = blessed.textbox({
//   parent: screen,
//   bottom: 11,
//   left: 0,
//   width: 20,
//   height: 3,
//   label: 'Command',
//   border: {
//     type: 'line',
//   },
//   inputOnFocus: true,
// });

screen.key(['escape', 'C-c'], function (_ch, _key) {
  return process.exit(0);
});
// input.key(['escape', 'C-c'], function (_ch, _key) {
//   return process.exit(0);
// });

// input.on('submit', function (data) {
//   debug.setContent('INPUT: ' + data);
//   input.clearValue();
//   input.focus();

//   debug.render();
//   input.render();
// });

// input.on('mouse', function (data) {
//   debug.setContent(JSON.stringify(data));
//   screen.render();
// });
// input.enableInput();

// input.focus();

screen.render();

function stringifyRows<R extends QueryResultRow = any>(rows: R[]): string[][] {
  return rows.map((row) => {
    return Object.values(row).map((v: unknown): string => {
      // screen.debug(`${v} ${typeof v}`);
      if (v === undefined || v === null) {
        return 'null';
      }
      if (typeof v === 'string') {
        return v;
      }
      return (v as any).toString();
      // return JSON.stringify(v);
    });
  });
}

function startInterval(fn: () => Promise<any>, interval: number): void {
  fn().catch((err) => {
    debug.setContent(err.toString());
    debug.render();
  });
  setInterval(async () => {
    fn().catch((err) => {
      debug.setContent(err.toString());
      debug.render();
    });
  }, interval);
}

async function pollConnections(databases: Database[]): Promise<PromiseSettledResult<void>[]> {
  const promises = databases.map(async ({ client, listTable }) => {
    const result = await getConnections(client);
    listTable.setData([ConnectionColumns as unknown as string[], ...stringifyRows(result.rows)]);
    listTable.render();
  });

  const result = await Promise.allSettled(promises);

  return result;
}

async function pollReplicationLag(blueClient: Client): Promise<void> {
  const results = await getReplicationLag(blueClient);
  replicationLag.setData([ReplicationLagColumns, ...stringifyRows(results.rows)]);
  replicationLag.render();
}

async function pollPgbouncerDbs(pgbouncerClient: Client): Promise<void> {
  const results = await getPgBouncerDatabases(pgbouncerClient);
  pgbouncerDbs.setData([PgBouncerDatabasesColumns, ...stringifyRows(results.rows)]);
  pgbouncerDbs.render();
}

async function pollPgbouncerPools(pgbouncerClient: Client): Promise<void> {
  const results = await getPgBouncerPools(pgbouncerClient);
  pgbouncerPools.setData([PgBouncerPoolsColumns, ...stringifyRows(results.rows)]);
  pgbouncerPools.render();
}

type Database = { client: Client; listTable: blessed.Widgets.ListTableElement };
async function main(): Promise<void> {
  const blueClient = await connect(BlueConnection);
  const greenClient = await connect(GreenConnection);
  const pgbouncerClient = await connect(PgbouncerConnection);
  // const proxySql = connect(ProxyConnection);

  const databases: Database[] = [
    { client: blueClient, listTable: blue },
    { client: greenClient, listTable: green },
  ];

  startInterval(async () => {
    pollReplicationLag(blueClient).catch(console.error);
  }, 1300);
  startInterval(async () => {
    pollPgbouncerDbs(pgbouncerClient).catch(console.error);
    pollPgbouncerPools(pgbouncerClient).catch(console.error);
  }, 1100);
  startInterval(async () => {
    pollConnections(databases).catch(console.error);
  }, 1500);
}

if (require.main === module) {
  main().catch(console.error);
}
