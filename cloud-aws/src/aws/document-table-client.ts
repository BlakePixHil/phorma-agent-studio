/**
 * The production `DocumentTableClient`: Run_Table access over DynamoDB.
 *
 * This is the owning module for seven of the ten Runtime_Host_Contract
 * capabilities (spec, journal, runHistory, runEvents, usageLedger,
 * workflowState and the Execution_Lease), as `./capability-map.json` declares.
 * Every one of them reaches AWS through the document client built here.
 *
 * Thin translation only. Each port method forwards its command input to the
 * matching `@aws-sdk/lib-dynamodb` command and returns the command output
 * unchanged - no retry policy, no shape rewriting, no decision of any kind.
 * Every decision lives in `src/core/` and is compiled into a command input by
 * `./table-ops-compile.ts` before it arrives here.
 *
 * Two deliberate omissions:
 *
 * - There is no whole-table read operation, in value, type-only or dynamic
 *   form. Every read addresses one partition key through `get` or `query`
 *   (Req 8.6), and the Check_Pipeline guard asserts the absence.
 * - No client is constructed at module load. The Check_Pipeline runs with no
 *   AWS credentials present, so credential resolution must not happen at import
 *   time - it happens inside `createDocumentTableClient`, which the
 *   Server_Entry calls after `readServerEnv` succeeds.
 *
 * Marshalling stays on the SDK defaults, so an item carrying an `undefined`
 * attribute value rejects loudly instead of being silently written without that
 * attribute. Callers build items with conditional spreads for exactly that
 * reason.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.3, 8.6
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import type { DocumentTableClient } from './ports.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DocumentTableClientOptions {
  /** The region the Run_Table lives in - `AWS_REGION` on the task definition. */
  region: string;
  /** The Run_Table name - `PHORMA_RUN_TABLE` on the task definition. */
  tableName: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the production `DocumentTableClient` for one Run_Table.
 *
 * Credentials come from the default provider chain, which resolves the
 * Runtime_Identity task role on Fargate. Calling this function is the first
 * point at which a client exists.
 *
 * `tableName` fills in `TableName` for any command input that omits it,
 * including each item of a `TransactWriteItems`. An input that names a table
 * explicitly is forwarded verbatim.
 */
export function createDocumentTableClient(
  options: DocumentTableClientOptions,
): DocumentTableClient {
  const { region, tableName } = options;
  const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  /** Default `TableName` on an input that left it unset. */
  const named = <T extends { TableName?: string }>(input: T): T =>
    input.TableName === undefined ? { ...input, TableName: tableName } : input;

  /** Default `TableName` on whichever single action a transact item carries. */
  const namedItem = (
    element: NonNullable<TransactWriteCommandInput['TransactItems']>[number],
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number] => {
    const item = { ...element };
    if (item.ConditionCheck) item.ConditionCheck = named(item.ConditionCheck);
    if (item.Put) item.Put = named(item.Put);
    if (item.Delete) item.Delete = named(item.Delete);
    if (item.Update) item.Update = named(item.Update);
    return item;
  };

  return {
    get: (input) => document.send(new GetCommand(named(input))),
    put: (input) => document.send(new PutCommand(named(input))),
    update: (input) => document.send(new UpdateCommand(named(input))),
    delete: (input) => document.send(new DeleteCommand(named(input))),
    query: (input) => document.send(new QueryCommand(named(input))),
    // `RequestItems` is already keyed by table name, so there is nothing to
    // default here.
    batchWrite: (input) => document.send(new BatchWriteCommand(input)),
    transactWrite: (input) =>
      document.send(
        new TransactWriteCommand({
          ...input,
          ...(input.TransactItems === undefined
            ? {}
            : { TransactItems: input.TransactItems.map(namedItem) }),
        }),
      ),
  };
}
