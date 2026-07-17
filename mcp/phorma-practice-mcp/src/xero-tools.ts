/**
 * Xero tools — multi-tenant Accounting + Payroll AU.
 *
 * Every tool takes an `entity` argument (organisation name or tenant id),
 * resolved through the {@link XeroBroker}. This is what lets ONE workflow
 * loop over a firm's whole client book with a single connected OAuth app.
 *
 * Payroll AU endpoints (https://api.xero.com/payroll.xro/1.0/) are absent
 * from the official Xero MCP server (it is NZ/UK-typed) — implemented here
 * from the AU Payroll REST API.
 */

import { optionalString, requireString, type Tool, type ToolContext } from './mcp.js';
import { XeroBroker, xeroRequest } from './xero-auth.js';

export function xeroTools(broker: XeroBroker): Tool[] {
  return [
    listEntitiesTool(broker),
    listPayRunsTool(broker),
    payrollActivitySummaryTool(broker),
    listAccountsTool(broker),
    createManualJournalTool(broker),
  ];
}

// ── Entity resolution ─────────────────────────────────────────────────────────

function listEntitiesTool(broker: XeroBroker): Tool {
  return {
    definition: {
      name: 'xero_list_entities',
      description:
        'Lists the Xero organisations (client entities) connected to the firm account. ' +
        'Returns tenant ids and names — use these as the `entity` argument for other Xero tools.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async (_args, ctx) => {
      const connections = await broker.listConnections(ctx);
      return JSON.stringify(
        connections.map(conn => ({ tenantId: conn.tenantId, name: conn.tenantName })),
        null,
        2,
      );
    },
  };
}

// ── Payroll AU ────────────────────────────────────────────────────────────────

const PAYROLL_BASE = 'https://api.xero.com/payroll.xro/1.0';

interface AuPayRun {
  PayRunID: string;
  PayRunStatus: string; // DRAFT | POSTED
  PayRunPeriodStartDate: string;
  PayRunPeriodEndDate: string;
  PaymentDate: string;
  Wages?: number;
  Tax?: number;
}

/** Parses Xero's legacy /Date(ms+tz)/ format into an ISO date, best effort. */
function xeroDate(value: string | undefined): string {
  if (!value) return '';
  const match = /\/Date\((\d+)/.exec(value);
  if (match) return new Date(Number(match[1])).toISOString().slice(0, 10);
  return value.slice(0, 10);
}

/** True when the ISO date falls inside [monthStart, nextMonthStart). */
function inMonth(isoDate: string, month: string): boolean {
  return isoDate.startsWith(month);
}

async function fetchMonthPayRuns(
  broker: XeroBroker,
  ctx: ToolContext,
  tenantId: string,
  month: string,
): Promise<{ payRuns: AuPayRun[]; inMonthRuns: AuPayRun[] }> {
  const json = (await xeroRequest(broker, ctx, tenantId, `${PAYROLL_BASE}/PayRuns`)) as {
    PayRuns?: AuPayRun[];
  };
  const payRuns = json.PayRuns ?? [];
  const inMonthRuns = payRuns.filter(run => inMonth(xeroDate(run.PayRunPeriodEndDate), month));
  return { payRuns, inMonthRuns };
}

function listPayRunsTool(broker: XeroBroker): Tool {
  return {
    definition: {
      name: 'xero_check_payruns_posted',
      description:
        'Checks that every pay run for an entity whose pay period ends in the given month has been POSTED. ' +
        'Returns JSON { entity, month, allPosted, payRuns: [{ id, status, periodEnd, paymentDate }] }. ' +
        'Use before extracting payroll figures — unposted (draft) pay runs mean the month is not finalised.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Organisation name or tenant id.' },
          month: { type: 'string', description: 'Month to check, YYYY-MM (e.g. 2026-06).' },
        },
        required: ['entity', 'month'],
      },
    },
    handler: async (args, ctx) => {
      const connection = await broker.resolveTenant(ctx, requireString(args, 'entity'));
      const month = requireString(args, 'month');
      const { inMonthRuns } = await fetchMonthPayRuns(broker, ctx, connection.tenantId, month);
      const runs = inMonthRuns.map(run => ({
        id: run.PayRunID,
        status: run.PayRunStatus,
        periodEnd: xeroDate(run.PayRunPeriodEndDate),
        paymentDate: xeroDate(run.PaymentDate),
      }));
      return JSON.stringify(
        {
          entity: connection.tenantName,
          tenantId: connection.tenantId,
          month,
          allPosted: runs.length > 0 && runs.every(run => run.status === 'POSTED'),
          payRunCount: runs.length,
          payRuns: runs,
        },
        null,
        2,
      );
    },
  };
}

function payrollActivitySummaryTool(broker: XeroBroker): Tool {
  return {
    definition: {
      name: 'xero_payroll_activity_summary',
      description:
        'Extracts the gross wages and total PAYG tax withheld for an entity for a month, summed from the ' +
        "month's POSTED pay runs (the figures the Payroll Activity Summary report shows). Returns JSON " +
        '{ entity, month, grossWages, taxWithheld, payRunCount }. Fails if any pay run in the month is unposted.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Organisation name or tenant id.' },
          month: { type: 'string', description: 'Month to report, YYYY-MM (e.g. 2026-06).' },
        },
        required: ['entity', 'month'],
      },
    },
    handler: async (args, ctx) => {
      const connection = await broker.resolveTenant(ctx, requireString(args, 'entity'));
      const month = requireString(args, 'month');
      const { inMonthRuns } = await fetchMonthPayRuns(broker, ctx, connection.tenantId, month);
      if (inMonthRuns.length === 0) {
        throw new Error(`No pay runs found for ${connection.tenantName} with a pay period ending in ${month}.`);
      }
      const unposted = inMonthRuns.filter(run => run.PayRunStatus !== 'POSTED');
      if (unposted.length > 0) {
        throw new Error(
          `${unposted.length} pay run(s) for ${connection.tenantName} in ${month} are not posted yet ` +
            `(${unposted.map(run => xeroDate(run.PayRunPeriodEndDate)).join(', ')}). Post them before preparing the IAS.`,
        );
      }
      // Summary fields on the list are sufficient; fall back to per-run
      // detail fetch when Wages/Tax are absent from the list payload.
      let grossWages = 0;
      let taxWithheld = 0;
      for (const run of inMonthRuns) {
        let wages = run.Wages;
        let tax = run.Tax;
        if (wages === undefined || tax === undefined) {
          // PayRunID comes from Xero's own response, but validate anyway —
          // it lands in a URL path on the authenticated session.
          if (!/^[A-Za-z0-9-]{1,60}$/.test(run.PayRunID)) {
            throw new Error(`Unexpected pay run id format: ${run.PayRunID.slice(0, 40)}`);
          }
          const detail = (await xeroRequest(
            broker,
            ctx,
            connection.tenantId,
            `${PAYROLL_BASE}/PayRuns/${run.PayRunID}`,
          )) as { PayRuns?: AuPayRun[] };
          const full = detail.PayRuns?.[0];
          wages = full?.Wages ?? 0;
          tax = full?.Tax ?? 0;
        }
        grossWages += wages ?? 0;
        taxWithheld += tax ?? 0;
      }
      return JSON.stringify(
        {
          entity: connection.tenantName,
          tenantId: connection.tenantId,
          month,
          grossWages: Math.round(grossWages * 100) / 100,
          taxWithheld: Math.round(taxWithheld * 100) / 100,
          payRunCount: inMonthRuns.length,
        },
        null,
        2,
      );
    },
  };
}

// ── Accounting ────────────────────────────────────────────────────────────────

const ACCOUNTING_BASE = 'https://api.xero.com/api.xro/2.0';

function listAccountsTool(broker: XeroBroker): Tool {
  return {
    definition: {
      name: 'xero_list_accounts',
      description:
        "Lists an entity's chart of accounts (code, name, type). Use to find the PAYG Withholding " +
        'Payable and ATO Integrated Client Account codes before journaling.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Organisation name or tenant id.' },
          filter: { type: 'string', description: 'Optional case-insensitive name filter (e.g. "PAYG").' },
        },
        required: ['entity'],
      },
    },
    handler: async (args, ctx) => {
      const connection = await broker.resolveTenant(ctx, requireString(args, 'entity'));
      const filter = optionalString(args, 'filter')?.toLowerCase();
      const json = (await xeroRequest(
        broker,
        ctx,
        connection.tenantId,
        `${ACCOUNTING_BASE}/Accounts`,
      )) as { Accounts?: { Code?: string; Name?: string; Type?: string; Status?: string }[] };
      const accounts = (json.Accounts ?? [])
        .filter(account => account.Status === 'ACTIVE')
        .filter(account => !filter || (account.Name ?? '').toLowerCase().includes(filter))
        .map(account => ({ code: account.Code, name: account.Name, type: account.Type }));
      return JSON.stringify({ entity: connection.tenantName, accounts }, null, 2);
    },
  };
}

function createManualJournalTool(broker: XeroBroker): Tool {
  return {
    definition: {
      name: 'xero_create_manual_journal',
      description:
        'Creates a POSTED manual journal in an entity. For the monthly IAS: debit the PAYG Withholding ' +
        'Payable account and credit the ATO Integrated Client Account with the tax withheld amount. ' +
        'Line amounts: debits positive, credits negative; lines must balance to zero. ' +
        'Returns JSON { journalId, narration, deepLink }.',
      inputSchema: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Organisation name or tenant id.' },
          narration: { type: 'string', description: 'Journal description, e.g. "IAS June 2026 — PAYGW".' },
          date: { type: 'string', description: 'Journal date, YYYY-MM-DD.' },
          lines: {
            type: 'array',
            description: 'At least two balanced lines.',
            items: {
              type: 'object',
              properties: {
                accountCode: { type: 'string' },
                amount: { type: 'number', description: 'Debit positive, credit negative.' },
                description: { type: 'string' },
              },
              required: ['accountCode', 'amount'],
            },
          },
        },
        required: ['entity', 'narration', 'date', 'lines'],
      },
    },
    handler: async (args, ctx) => {
      const connection = await broker.resolveTenant(ctx, requireString(args, 'entity'));
      const narration = requireString(args, 'narration');
      const date = requireString(args, 'date');
      const lines = args['lines'] as { accountCode: string; amount: number; description?: string }[];
      if (!Array.isArray(lines) || lines.length < 2) {
        throw new Error('At least two journal lines are required.');
      }
      // Strict numeric validation: a string amount would string-concatenate
      // through the balance check and post a malformed journal.
      for (const line of lines) {
        if (typeof line.amount !== 'number' || !Number.isFinite(line.amount)) {
          throw new Error(`Journal line amount for account ${line.accountCode} must be a finite number.`);
        }
        if (typeof line.accountCode !== 'string' || !/^[A-Za-z0-9._-]{1,20}$/.test(line.accountCode)) {
          throw new Error('Journal line accountCode must be a plain account code.');
        }
      }
      const total = lines.reduce((sum, line) => sum + line.amount, 0);
      if (Math.abs(total) > 0.005) {
        throw new Error(`Journal lines must balance to zero (currently ${total.toFixed(2)}).`);
      }
      const body = {
        ManualJournals: [
          {
            Narration: narration,
            Date: date,
            Status: 'POSTED',
            LineAmountTypes: 'NoTax',
            JournalLines: lines.map(line => ({
              LineAmount: line.amount,
              AccountCode: line.accountCode,
              Description: line.description,
            })),
          },
        ],
      };
      const json = (await xeroRequest(
        broker,
        ctx,
        connection.tenantId,
        `${ACCOUNTING_BASE}/ManualJournals`,
        { method: 'PUT', body: JSON.stringify(body) },
      )) as { ManualJournals?: { ManualJournalID?: string }[] };
      const journalId = json.ManualJournals?.[0]?.ManualJournalID;
      if (!journalId) throw new Error('Xero returned no journal id.');
      return JSON.stringify(
        {
          entity: connection.tenantName,
          journalId,
          narration,
          date,
          deepLink: `https://go.xero.com/Journal/View.aspx?invoiceID=${journalId}`,
        },
        null,
        2,
      );
    },
  };
}
