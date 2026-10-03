import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { execFileSync } from 'node:child_process';

/**
 * DynamoDB Local for tests that depend on conditions, transactions and GSIs. Uses
 * $DYNAMODB_ENDPOINT when set (CI service container), otherwise starts a Docker container.
 */
export async function startDynamoLocal(): Promise<{ endpoint: string; stop: () => void }> {
  if (process.env.DYNAMODB_ENDPOINT) return { endpoint: process.env.DYNAMODB_ENDPOINT, stop: () => {} };
  const id = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::8000', 'amazon/dynamodb-local:latest', '-jar', 'DynamoDBLocal.jar', '-inMemory'], {
    encoding: 'utf8',
  }).trim();
  const port = execFileSync('docker', ['port', id, '8000/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
  const endpoint = `http://127.0.0.1:${port}`;
  // Wait until it answers.
  const client = rawClient(endpoint);
  for (let i = 0; ; i++) {
    try {
      await client.send(new CreateTableCommand(tableDefinition('__probe')));
      break;
    } catch (e) {
      if (i > 60) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { endpoint, stop: () => execFileSync('docker', ['stop', id]) };
}

function rawClient(endpoint: string) {
  return new DynamoDBClient({ endpoint, region: 'ap-northeast-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
}

/** The DM-001 table, as infra/lib/console-stack.ts creates it. */
function tableDefinition(TableName: string) {
  const gsi = (n: 1 | 2) => ({
    IndexName: `GSI${n}`,
    KeySchema: [
      { AttributeName: `GSI${n}PK`, KeyType: 'HASH' as const },
      { AttributeName: `GSI${n}SK`, KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  });
  return {
    TableName,
    BillingMode: 'PAY_PER_REQUEST' as const,
    AttributeDefinitions: ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK'].map((AttributeName) => ({ AttributeName, AttributeType: 'S' as const })),
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' as const },
      { AttributeName: 'SK', KeyType: 'RANGE' as const },
    ],
    GlobalSecondaryIndexes: [gsi(1), gsi(2)],
  };
}

let tables = 0;

/** A fresh table per test, so tests don't see each other's items. */
export async function freshTable(endpoint: string): Promise<{ table: string; raw: DynamoDBClient; db: DynamoDBDocumentClient }> {
  const raw = rawClient(endpoint);
  const table = `t${Date.now()}${tables++}`;
  await raw.send(new CreateTableCommand(tableDefinition(table)));
  return { table, raw, db: DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } }) };
}
