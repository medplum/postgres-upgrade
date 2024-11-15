import { Client } from 'pg';
import { cutover } from './switchover';
import {
  BlueConnection,
  checkConnectivity,
  checkDataEquivalency,
  connect,
  getConnections,
  getSequenceLast,
  GreenConnection,
  PgbouncerConnection,
  ProxyConnection,
} from './db';
import { shutdown } from './utils';

let blueClient: Client;
let greenClient: Client;
let proxyClient: Client;
let pgbouncerClient: Client;

const TEST_CUTOVER = false;
const TEST_GET_CONNECTIONS = false;
const TEST_SEQUENCE_STATEMENTS = false;
const TEST_DATA_EQUIVALENCE = true;

async function main(): Promise<void> {
  blueClient = await connect(BlueConnection);
  greenClient = await connect(GreenConnection);
  proxyClient = await connect(ProxyConnection);
  pgbouncerClient = await connect(PgbouncerConnection);

  const checkResults = await checkConnectivity({ blueClient, greenClient, pgbouncerClient });
  console.log('Check results:', checkResults);

  if (TEST_GET_CONNECTIONS) {
    await testGetConnections(blueClient);
  }
  if (TEST_SEQUENCE_STATEMENTS) {
    await testSequenceStatements(blueClient);
  }

  if (TEST_CUTOVER) {
    const result = await cutover({
      dbName: 'medplum',
      replicationSlotName: 'my_replication_slot',
      pgbouncerClient,
      proxyClient,
      blueClient,
      greenClient,
      dryRun: true,
      resourceMinimums: {
        Patient: 1,
      },
    });
    console.log('Cutover result:', result);
  }

  if (TEST_DATA_EQUIVALENCE) {
    const startTimestamp = '2024-10-21 15:00:00'; // 30 minutes before clone created
    await checkDataEquivalency({
      tableName: 'Task',
      startTimestamp,
      blueClient,
      greenClient,
    });
    await checkDataEquivalency({
      tableName: 'AuditEvent',
      startTimestamp,
      blueClient,
      greenClient,
    });
  }
}

async function testGetConnections(client: Client): Promise<void> {
  const results = await getConnections(client);
  console.log(JSON.stringify(results.rows, null, 2));
  const row = results.rows[0];
  for (const col of Object.values(row)) {
    console.log(col, typeof col);
  }
}

async function testSequenceStatements(client: Client): Promise<void> {
  const results = await getSequenceLast(client);
  for (const r of results.rows) {
    console.log(r.sequencename, r.last_value, typeof r.last_value);
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Error', err);
      process.exit(1);
    })
    .finally(shutdown);
}
