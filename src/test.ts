import { Client } from 'pg';
import { checkConnectivity, checkDataEquivalency, connectAll, DBClients, getConnections, getSequenceLast } from './db';
import { shutdown } from './utils';

let clients: DBClients;

const TEST_GET_CONNECTIONS = true;
const TEST_SEQUENCE_STATEMENTS = true;
const TEST_DATA_EQUIVALENCE = true;

async function main(): Promise<void> {
  clients = await connectAll();

  const checkResults = await checkConnectivity({
    blueClient: clients.blue,
    greenClient: clients.green,
    pgbouncerClient: clients.pgbouncer,
  });
  console.log('Check results:', checkResults);

  if (TEST_GET_CONNECTIONS) {
    await testGetConnections(clients.blue);
  }
  if (TEST_SEQUENCE_STATEMENTS) {
    await testSequenceStatements(clients.blue);
  }

  if (TEST_DATA_EQUIVALENCE) {
    const startTimestamp = '2024-10-21 15:00:00'; // adjust to be 30 minutes before clone created; in UTC
    await checkDataEquivalency({
      tableName: 'AuditEvent',
      startTimestamp,
      blueClient: clients.blue,
      greenClient: clients.green,
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
