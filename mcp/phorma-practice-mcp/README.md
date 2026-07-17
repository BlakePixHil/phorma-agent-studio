# @phorma/practice-mcp

MCP server for accounting-practice workflows (built for the monthly IAS/PAYGW
automation). Framework-free TypeScript, two transports:

- **stdio** - `npx -y tsx src/stdio.ts` (desktop debug; spawned by the studio's Rust MCP host)
- **streamable HTTP** - `npx -y tsx src/http.ts` (deployed workflows via the engine's `HttpMcpClient`; `PORT`, optional `PRACTICE_MCP_TOKEN` bearer)

## Tools

| Tool | Purpose |
|---|---|
| `xero_list_entities` | Firm's connected Xero organisations (tenant ids) |
| `xero_check_payruns_posted` | All pay runs POSTED for an entity+month? |
| `xero_payroll_activity_summary` | Gross wages + PAYG withheld for entity+month (Payroll AU) |
| `xero_list_accounts` | Chart of accounts (find PAYG Payable / ATO ICA codes) |
| `xero_create_manual_journal` | Posted, balanced manual journal (Dr/Cr) |
| `xpm_list_open_jobs` | Open XPM jobs, filterable ("IAS") |
| `xpm_get_client` | XPM client contacts (responsible person / signer) |
| `xpm_update_job_state` | Mark a job Completed after lodgement |
| `esign_send` / `esign_status` / `esign_download` | Annature envelopes; correlation key metadata resumes the workflow's Wait-for-Event node |
| `ias_generate_pdf` | Dependency-free IAS summary PDF (W1/W2, declaration) for signing |
| `ias_lodgement_pack` | Markdown pack for the manual XPM/ATO checkpoint |

## Secrets (env vars)

`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REFRESH_TOKEN` (one firm OAuth
app, offline_access; the broker mints per-entity tokens and lists tenants via
`/connections` - Xero rotates refresh tokens, watch `onRefreshTokenRotated`),
`XPM_PRACTICE_TENANT_ID`, `ANNATURE_ID`, `ANNATURE_KEY`,
`ESIGN_PROVIDER` (default `annature`), `ESIGN_WEBHOOK_URL`.

## Known limits (SPIKE-FINDINGS.md has the full analysis)

- XPM tax/Activity Statement lodgement is **not** in the public XPM API - the
  workflow uses `ias_lodgement_pack` + an Approval Gate for the manual XPM steps.
- XPM scopes require Xero App Partner registration; >25 connected orgs
  requires app certification.
- The studio preset currently spawns via a **repo-relative tsx path** (dev
  only). Publish to npm (`npx -y @phorma/practice-mcp`) before shipping to firms.

## Security posture (reviewed 2026-07-17)

Threat model: the LLM is an untrusted caller wielding trusted credentials.
Every tool argument is treated as attacker-controlled.

- **Path injection**: all ids interpolated into API URL paths go through
  `requireId` (`[A-Za-z0-9._-]{1,80}`) - `clientId`, `jobId`, `envelopeId`;
  Xero-returned `PayRunID` is re-validated before path use.
- **SSRF / credential leak**: `esign_download` follows only HTTPS links and
  sends the Annature keys only to `*.annature.com.au` hosts.
- **XML injection**: XPM job-state XML escapes all interpolated values.
- **Journal integrity**: line amounts must be finite numbers (string
  concatenation through the balance check is rejected); account codes are
  format-validated; lines must balance to zero.
- **HTTP transport**: binds 127.0.0.1 by default; refuses non-loopback
  binding without `PRACTICE_MCP_TOKEN`; timing-safe bearer comparison; 4MB
  request-body cap.
- **Token race**: Xero refresh is single-flight (rotation-safe under
  concurrent tool calls).
- **Secrets**: only read via `ToolContext.env`; never echoed in tool output
  or error messages; error bodies truncated to 400 chars.

## Verify

```sh
./node_modules/.bin/tsc --noEmit          # type-check
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | npx -y tsx src/stdio.ts
```
