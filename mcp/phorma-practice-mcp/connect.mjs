// One-time Xero consent -> prints XERO_REFRESH_TOKEN. Run with:
//   XERO_CLIENT_ID=... XERO_CLIENT_SECRET=... node connect.mjs
//
// TROUBLESHOOTING "Sorry, something went wrong":
//   1. The redirect URI in your Xero app (developer.xero.com → your app →
//      Configuration) MUST be EXACTLY http://localhost:8844/callback — no
//      trailing slash, https, or different port. Re-check it.
//   2. The scopes below must all be enabled on the app. If you created the
//      app as a "Custom Connection" instead of a "Web app", the flow won't
//      work — recreate it as a Web app integration.
//   3. Apps created after Apr 29, 2026 REJECT the deprecated bundled scopes
//      (accounting.transactions, accounting.reports.read) with this exact
//      generic error page. The V2 granular scopes below are required.
//   4. If payroll scopes fail on a non-AU/UK org, drop the payroll.* lines.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';

const PORT = 8844;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
// V2 granular scopes (required for apps created after 2026-04-29). The old
// bundled `accounting.transactions` / `accounting.reports.read` scopes are
// rejected by new apps with a generic "Sorry, something went wrong" page.
const SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'email',
  // Accounting — granular replacements for the deprecated accounting.transactions
  'accounting.invoices',
  'accounting.invoices.read',
  'accounting.payments',
  'accounting.payments.read',
  'accounting.banktransactions',
  'accounting.banktransactions.read',
  'accounting.manualjournals',
  'accounting.manualjournals.read',
  'accounting.contacts',
  'accounting.settings',
  // Reports — granular replacements for accounting.reports.read
  'accounting.reports.aged.read',
  'accounting.reports.balancesheet.read',
  'accounting.reports.profitandloss.read',
  'accounting.reports.trialbalance.read',
  // Payroll AU/UK
  'payroll.payruns',
  'payroll.settings',
  'payroll.employees',
  'payroll.timesheets',
].join(' ');
const id = process.env.XERO_CLIENT_ID, secret = process.env.XERO_CLIENT_SECRET;
if (!id || !secret) { console.error('Set XERO_CLIENT_ID and XERO_CLIENT_SECRET.'); process.exit(1); }

const state = randomBytes(16).toString('hex');
const authUrl = 'https://login.xero.com/identity/connect/authorize'
  + `?response_type=code&client_id=${encodeURIComponent(id)}`
  + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
  + `&scope=${encodeURIComponent(SCOPES)}&state=${state}`;

createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  // Xero bounces OAuth errors back as ?error=...&error_description=...
  const errorCode = url.searchParams.get('error');
  if (errorCode) {
    const desc = url.searchParams.get('error_description') ?? '(no description)';
    console.error(`\nXero rejected the consent:\n  error: ${errorCode}\n  description: ${desc}\n`);
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Xero rejected the consent</h2><pre>error: ${errorCode}\n${desc}</pre>`);
    return;
  }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) return res.writeHead(400).end('State mismatch - retry.');
  const tokenRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  const token = await tokenRes.json();
  if (!token.refresh_token) { console.error('Exchange failed:', token); res.writeHead(500).end('Failed - see terminal.'); process.exit(1); }
  const conns = await (await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })).json();
  console.log('\nXERO_REFRESH_TOKEN:\n\n  ' + token.refresh_token + '\n');
  console.log('Connected organisations:');
  for (const c of conns) console.log(`  - ${c.tenantName} (${c.tenantType}) tenantId=${c.tenantId}`);
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>Connected - close this tab.</h2>');
  setTimeout(() => process.exit(0), 200);
}).listen(PORT, '127.0.0.1', () => {
  console.log('\n────────────────────────────────────────────────────────');
  console.log('  Redirect URI registered in your Xero app MUST be:');
  console.log(`    ${REDIRECT_URI}`);
  console.log('  (exactly — no trailing slash, no https, no other port)');
  console.log('────────────────────────────────────────────────────────');
  console.log('\nOpening consent page. If Xero shows "Sorry, something went');
  console.log('wrong", copy the URL below and check the redirect URI + scopes');
  console.log('against your app at developer.xero.com:\n');
  console.log(authUrl + '\n');
  exec(`open "${authUrl}"`, () => undefined);
});