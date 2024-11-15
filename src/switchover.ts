import { program } from 'commander';
import { NodeSSH } from 'node-ssh';
import { Client } from 'pg';
import {
  BlueConnection,
  checkDataEquivalency,
  connect,
  getReplicationLagForSlot,
  getSequenceLast,
  GreenConnection,
  pauseDatabase,
  PgbouncerConnection,
  ProxyConnection,
  resumeDatabase,
  sleep,
} from './db';
import { DRY_RUN_PREFIX, prefix, shutdown, yesOrNo } from './utils';

type CutoverParams = {
  dbName: 'medplum';
  replicationSlotName: 'my_replication_slot';
  pgbouncerClient: Client;
  proxyClient: Client;
  blueClient: Client;
  greenClient: Client;
  dryRun: boolean;
  resourceMinimums: { Patient: number };
};

let ssh: NodeSSH | undefined;

export async function cutover({
  dbName,
  replicationSlotName,
  pgbouncerClient,
  proxyClient,
  blueClient,
  greenClient,
  dryRun,
  resourceMinimums,
}: CutoverParams): Promise<boolean> {
  ssh = new NodeSSH();

  console.log('\nSSHing onto PgBouncer server...');
  await ssh.connect({
    host: PgbouncerConnection.host,
    username: 'ubuntu',
    privateKeyPath: '/home/ubuntu/.ssh/pgbouncer_key',
  });
  console.log('SSH connected');

  console.log('\nChecking preconditions...\n');
  let isPrecheck = true;

  const medplumDB = await getMedplumDatabase({ pgbouncerClient });
  console.log();
  if (medplumDB.host !== blueClient.host) {
    throw new Error('medplum database host is not blue: ' + medplumDB.host);
  } else {
    console.log(`PgBouncer medplum database is connected to blue: ${blueClient.host}`);
  }

  if (medplumDB.paused !== 0) {
    throw new Error('medplum database is already paused: ' + medplumDB.paused);
  } else {
    console.log('PgBouncer medplum database is not paused');
  }

  if (medplumDB.pool_mode !== 'transaction') {
    throw new Error('medplum database pool_mode is not "transaction": ' + medplumDB.pool_mode);
  } else {
    console.log('PgBouncer medplum database pool_mode is "transaction"');
  }

  await checkServerVersions({ blueClient, greenClient, proxyClient, proxying: 'blue' });

  console.log();
  for (const [label, client] of [
    ['blue', blueClient],
    ['green', greenClient],
  ] as [string, Client][]) {
    const patientCount = await client.query('SELECT COUNT(*) FROM "Patient"');
    if (patientCount.rows[0].count < resourceMinimums.Patient) {
      throw new Error(`${label} database does NOT have enough Patient resources: ${JSON.stringify(patientCount.rows)}`);
    } else {
      console.log(`${label} database has enough Patient resources: ${patientCount.rows[0].count}`);
    }
  }

  console.log();
  const startTimestamp = '2024-10-21 15:00:00'; // 30 minutes before clone created
  await checkDataEquivalency({
    tableName: 'AuditEvent',
    startTimestamp,
    blueClient,
    greenClient,
  });

  const diffBytes = await getReplicationLagForSlot(blueClient, replicationSlotName);
  if (diffBytes > 1024) {
    throw new Error(`Replication lag is too high: ${diffBytes} bytes`);
  }
  console.log(`\nReplication lag is low enough to proceed: ${diffBytes} bytes`);

  const precheckSequnceInfo = await synchronizeSequences({ blueClient, greenClient, isPrecheck, dryRun });
  console.log('\ngreen column largest values are lower than or equal to their blue sequence last values');
  console.table(precheckSequnceInfo);

  console.log('\nChecking PgBouncer process status and accessibility...');
  await updatePgBouncerConfigAndReload({
    ssh,
    pgbouncerClient,
    newTarget: 'green',
    isPrecheck,
    dryRun,
  });
  console.log('PgBouncer server and process is running and accessible');

  if (!(await yesOrNo(`\ndryRun=${dryRun}\nPrecondition checks passed. Begin cutover?`))) {
    process.exit(0);
  }

  isPrecheck = false;
  console.log('\nBeginning cutover...\n');

  await checkServerVersions({ blueClient, greenClient, proxyClient, proxying: 'blue' });

  await pauseDatabase({ pgbouncerClient, dbName, dryRun });

  const promises: Promise<any>[] = [];
  try {
    promises.push(waitForReplication({ client: blueClient, replicationSlotName }));
  } catch (err) {
    console.error('Error initializing waitForReplication:', err);
    await resumeDatabase({ pgbouncerClient, dbName, dryRun });
    return false;
  }

  try {
    promises.push(synchronizeSequences({ blueClient, greenClient, isPrecheck, dryRun }));
  } catch (err) {
    console.error('Error initializing synchronizeSequences:', err);
    await resumeDatabase({ pgbouncerClient, dbName, dryRun });
    return false;
  }

  try {
    await Promise.all(promises);
  } catch (err) {
    console.error('Error waiting for replication and sequence synchronization:', err);
    await resumeDatabase({ pgbouncerClient, dbName, dryRun });
    return false;
  }

  try {
    await updatePgBouncerConfigAndReload({
      ssh,
      pgbouncerClient,
      newTarget: 'green',
      isPrecheck,
      dryRun,
    });
  } catch (err) {
    console.error('Error updating PgBouncer config:', err);
    await resumeDatabase({ pgbouncerClient, dbName, dryRun });
    return false;
  }

  await resumeDatabase({ pgbouncerClient, dbName, dryRun });

  await checkServerVersions({ blueClient, greenClient, proxyClient, proxying: dryRun ? 'blue' : 'green' });

  return true;
}

type SequenceInfo = {
  table: string;
  column: string;
  blueSequenceLastValue: number;
  largestBlue: number;
  largestGreen: number;
};
type SynchronizeSequencesParams = { blueClient: Client; greenClient: Client; isPrecheck: boolean; dryRun: boolean };
async function synchronizeSequences({
  blueClient,
  greenClient,
  isPrecheck,
  dryRun,
}: SynchronizeSequencesParams): Promise<SequenceInfo[]> {
  const blueLastValues = await getSequenceLast(blueClient);

  const sequenceColumns = await Promise.all(
    blueLastValues.rows.map((row) => {
      return blueClient.query(
        `SELECT d.refobjid::regclass as tablename, a.attname as columnname
         FROM   pg_depend d
         JOIN   pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
         WHERE  d.objid = $1::regclass
         AND    d.refobjsubid > 0
         AND    d.classid = 'pg_class'::regclass`,
        [`"${row.schemaname}"."${row.sequencename}"`]
      );
    })
  );

  const [greenLargestValues, blueLargestValues] = await Promise.all(
    [greenClient, blueClient].map((client) => {
      return Promise.all(
        sequenceColumns.map(async (column, idx) => {
          const { schemaname, sequencename } = blueLastValues.rows[idx];
          if (column.rows.length !== 1) {
            throw new Error(`Expect one column using sequence ${sequencename} but got ` + JSON.stringify(column.rows));
          }
          const { tablename, columnname } = column.rows[0];
          const results = await client.query(
            `SELECT ${columnname} FROM "${schemaname}".${tablename} ORDER BY ${columnname} DESC LIMIT 1`
          );
          for (const row of results.rows) {
            row[columnname] = parseInt(row[columnname].toString(), 10);
          }
          return results;
        })
      );
    })
  );

  const sequenceInfo: SequenceInfo[] = [];
  const errors: string[] = [];
  for (let i = 0; i < greenLargestValues.length; i++) {
    const greenLargestValue = greenLargestValues[i];
    const blueLargestValue = blueLargestValues[i];
    if (greenLargestValue.rows.length !== 1) {
      errors.push('Expected one row for green largest value: ' + JSON.stringify(greenLargestValue.rows));
    }
    const { tablename, columnname } = sequenceColumns[i].rows[0];
    const largestGreen = greenLargestValue.rows[0][columnname];
    const largestBlue = blueLargestValue.rows[0][columnname];
    const blueSequenceLastValue = blueLastValues.rows[i].last_value;
    sequenceInfo.push({ table: tablename, column: columnname, blueSequenceLastValue, largestBlue, largestGreen });
    if (largestGreen > blueSequenceLastValue) {
      errors.push(
        `Green ${tablename}.${columnname} has larger sequence value than blue: ` + JSON.stringify(greenLargestValue)
      );
    }
  }

  if (errors.length) {
    throw new Error('Sequence synchronization errors: ' + errors.join('\n'));
  }

  if (isPrecheck) {
    return sequenceInfo;
  }

  console.log('Synchronizing sequences...');
  const updates = await Promise.all(
    blueLastValues.rows.map((row) => {
      const lastValueStr = row.last_value.toString();

      const query = `SELECT setval($1, $2)`;
      const values = [`"${row.schemaname}"."${row.sequencename}"`, lastValueStr];

      if (dryRun) {
        console.log(DRY_RUN_PREFIX + `Would execute query on green: ${query} with values ${values}`);
        return Promise.resolve({ rows: [{ setval: lastValueStr }] });
      } else {
        return greenClient.query(query, values);
      }
    })
  );

  for (const update of updates) {
    console.log(prefix(dryRun) + 'Updated sequence:', JSON.stringify(update.rows));
  }
  return sequenceInfo;
}

type WaitForReplicationLabParams = { client: Client; replicationSlotName: string };
async function waitForReplication({ client, replicationSlotName }: WaitForReplicationLabParams): Promise<void> {
  console.log('Waiting for replication...');
  const MAX_DIFF_BYTES = 1;
  let diffBytes: number;
  let attempts = 0;
  do {
    attempts++;
    diffBytes = await getReplicationLagForSlot(client, replicationSlotName);

    if (diffBytes < MAX_DIFF_BYTES) {
      console.log(`Replication lag converged: ${diffBytes} bytes`);
      return;
    }

    console.log(`Replication lag: ${diffBytes} bytes`);

    if (attempts > 40) {
      throw new Error(`Replication lag did not converge. Last diff_bytes: ${diffBytes}`);
    }

    await sleep(50);
  } while (diffBytes >= MAX_DIFF_BYTES);
}

const configPath = '/etc/pgbouncer/pgbouncer.ini';
const PgBouncerConfigPaths = {
  green: '/etc/pgbouncer/green.pgbouncer.ini',
  blue: '/etc/pgbouncer/blue.pgbouncer.ini',
};

type UpdatePgbouncerParams = {
  ssh: NodeSSH;
  pgbouncerClient: Client;
  newTarget: 'green' | 'blue';
  isPrecheck: boolean;
  dryRun: boolean;
};
async function updatePgBouncerConfigAndReload({
  ssh,
  pgbouncerClient,
  newTarget,
  isPrecheck,
  dryRun,
}: UpdatePgbouncerParams): Promise<void> {
  const medplumDB = await getMedplumDatabase({ pgbouncerClient, disableLogging: true });

  if (!isPrecheck && !dryRun && medplumDB.paused !== 1) {
    throw new Error('medplum database must be paused: ' + JSON.stringify(medplumDB));
  }

  if (medplumDB.disabled !== 0) {
    throw new Error('medplum database must not be disabled: ' + JSON.stringify(medplumDB));
  }

  const newConfigPath = PgBouncerConfigPaths[newTarget];
  if (!newConfigPath) {
    throw new Error('Invalid new PgBouncer target: ' + newTarget);
  }

  if (isPrecheck) {
    const { stdout, stderr, code } = await ssh.execCommand('sudo cat ' + newConfigPath);
    if (stdout) {
      console.log('Show new PgBouncer config stdout:\n', stdout);
    }
    if (code !== 0) {
      console.log('Show new PgBouncer config stderr:', stderr);
      throw new Error('Error reading new PgBouncer config: ' + stderr);
    }
  }

  if (isPrecheck) {
    const { stdout, stderr, code } = await ssh.execCommand('sudo service pgbouncer status');
    if (stdout) {
      console.log('PgBouncer status stdout:\n', stdout);
    }
    if (code !== 0) {
      console.log('PgBouncer status stderr:\n', stderr);
      throw new Error('PgBouncer status returned non-zero exit code: ' + code);
    }
    return;
  }

  const updateConfigFileCmd = `sudo ln -sf ${newConfigPath} ${configPath}`;
  if (dryRun) {
    console.log(DRY_RUN_PREFIX + 'Would execute:', updateConfigFileCmd);
  } else {
    console.log(updateConfigFileCmd);
    await ssh.execCommand(updateConfigFileCmd);
  }

  // Reload PgBouncer
  const reloadCmd = 'sudo service pgbouncer reload'; // 'sudo pkill --echo --exact -HUP pgbouncer';
  if (dryRun) {
    console.log(DRY_RUN_PREFIX + 'Would execute:', reloadCmd);
  } else {
    console.log(reloadCmd);
    const { stdout, stderr, code } = await ssh.execCommand(reloadCmd);
    if (stdout) {
      console.log('\nPgBouncer reload stdout:\n', stdout);
    }
    if (code !== 0) {
      console.log('\nPgBouncer reload stderr:\n', stderr);
      throw new Error('PgBouncer reload returned non-zero exit code: ' + code);
    }
  }
}

type PgBouncerDatabase = {
  name: string;
  host: string | null;
  port: number;
  database: string;
  pool_mode: 'session' | 'transaction' | 'statement';
  paused: 0 | 1;
  disabled: 0 | 1;
};
async function getMedplumDatabase({
  pgbouncerClient,
  disableLogging,
}: {
  pgbouncerClient: Client;
  disableLogging?: boolean;
}): Promise<PgBouncerDatabase> {
  const dbResults = await pgbouncerClient.query('show databases');
  if (!disableLogging) {
    console.log('PgBouncer databases:');
    console.table(dbResults.rows);
  }
  const result = dbResults.rows.find((row: any) => row.name === 'medplum');

  if (!result) {
    throw new Error('medplum database not found in PgBouncer: ' + JSON.stringify(dbResults.rows));
  }

  return result;
}

type CheckServerVersionsProps = {
  blueClient: Client;
  greenClient: Client;
  proxyClient: Client;
  proxying: 'blue' | 'green';
};
async function checkServerVersions({
  blueClient,
  greenClient,
  proxyClient,
  proxying,
}: CheckServerVersionsProps): Promise<void> {
  const blue = (await blueClient.query('SELECT version()')).rows[0].version;
  const green = (await greenClient.query('SELECT version()')).rows[0].version;
  const proxy = (await proxyClient.query('SELECT version()')).rows[0].version;

  const results = { blue, green, proxy };

  if (proxying === 'blue') {
    if (blue !== proxy || proxy === green) {
      console.table(Object.entries(results));
      throw new Error(
        'Expected proxy to match blue server version and NOT match green server version' + JSON.stringify(results)
      );
    }
  } else if (proxying === 'green' || proxy === blue) {
    if (green !== proxy) {
      console.table(Object.entries(results));
      throw new Error(
        'Expected proxy to match green server version and NOT match blue server version' + JSON.stringify(results)
      );
    }
  } else {
    proxying satisfies never;
    throw new Error('Invalid proxying: ' + proxying);
  }

  console.log(`\nPgbouncer is proxying to ${proxying} server: ${results.proxy}`);
}

function exit(err: Error): void {
  console.error(err);
  process.exit(1);
}

let blueClient: Client;
let greenClient: Client;
let pgbouncerClient: Client;
let proxyClient: Client;
function logClientStatus(): void {
  function getStatus(client: Client | undefined): string {
    return client ? 'YES' : ' - ';
  }
  console.log(
    `blue=${getStatus(blueClient)} green=${getStatus(greenClient)} proxy=${getStatus(
      proxyClient
    )} pgbouncer=${getStatus(pgbouncerClient)}`
  );
}
if (require.main === module) {
  program.option('--dry-run', 'Runs in Dry Run mode', true);
  program.option('--no-dry-run', 'Does NOT run in Dry Run mode');
  program.parse(process.argv);

  const { dryRun } = program.opts<{ dryRun: boolean }>();
  console.log(`dryRun=${dryRun}\n`);

  console.log('Connecting postgres clients...');
  Promise.all([
    connect(BlueConnection).then((client) => {
      blueClient = client;
      logClientStatus();
    }),
    connect(GreenConnection).then((client) => {
      greenClient = client;
      logClientStatus();
    }),
    connect(ProxyConnection).then((client) => {
      proxyClient = client;
      logClientStatus();
    }),
    connect(PgbouncerConnection).then((client) => {
      pgbouncerClient = client;
      logClientStatus();
    }),
  ])
    .then(() => {
      cutover({
        blueClient,
        greenClient,
        pgbouncerClient,
        proxyClient,
        dbName: 'medplum',
        replicationSlotName: 'my_replication_slot',
        dryRun: dryRun ?? true,
        resourceMinimums: { Patient: 100000 },
      })
        .catch(exit)
        .finally(() => {
          if (ssh) {
            try {
              ssh.dispose();
            } catch (err) {
              console.error('Error disposing ssh:', err);
            }
          }
          shutdown();
        });
    })
    .catch((err) => {
      if (ssh) {
        try {
          ssh.dispose();
        } catch (err) {
          console.error('Error disposing ssh:', err);
        }
      }
      shutdown();
      exit(err);
    });
}
