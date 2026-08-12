/**
 * E2E for the connectors compiled into the app (P1-14) - validates the BUILT-IN
 * registry against the same rules a stranger's connector file goes through, and
 * checks each bundle is actually runnable on a real host.
 *
 * Lives here rather than in `engine/src/*.spec.ts` because it imports the
 * frontend's registry module: `engine/` must not depend on `frontend/`, and the
 * repo's precedent for a cross-package check is a tsx scenario script (see
 * `ias-template.e2e.mts`, which imports the workflow templates the same way).
 *
 * The runtime guard in `ConnectorsService` drops an invalid built-in with a
 * console warning, which is right for a user and useless as a development
 * signal. This script is the signal.
 *
 * Run: npx -y tsx engine/test/connectors-builtin.e2e.mts
 */
import {
  BROWSER_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  TAURI_DESKTOP_CAPABILITIES,
  buildConnectorConnection,
  connectorPreviewSpec,
  connectorSecretKeyNames,
  connectorStepNodeData,
  inspectAgainstCapabilities,
  serializeConnectorBundle,
  validateConnectorBundle,
} from '../src/index.js';
import type { ConnectorBundle, HostCapabilities } from '../src/index.js';
import { BUILTIN_CONNECTOR_BUNDLES } from '../../frontend/src/app/core/connectors-builtin.js';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

const NOW = '2026-08-12T00:00:00.000Z';

/** A plausible value for a config field the bundle leaves to the installer. */
function placeholderFor(name: string): string {
  switch (name) {
    case 'baseUrl':
      return 'https://api.example.test/v1';
    case 'host':
      return 'db.example.test';
    case 'port':
      return '5432';
    case 'driver':
      return 'postgres';
    case 'database':
      return 'reporting';
    default:
      return 'value';
  }
}

console.log('registry');
check('ships at least one connector', BUILTIN_CONNECTOR_BUNDLES.length > 0);
const ids = BUILTIN_CONNECTOR_BUNDLES.map(bundle => bundle.id);
check('ids are unique', new Set(ids).size === ids.length, ids.join(', '));

for (const raw of BUILTIN_CONNECTOR_BUNDLES) {
  const bundle = raw as ConnectorBundle;
  console.log(`\n${bundle.id} (${bundle.name})`);

  const findings = validateConnectorBundle(bundle);
  check(
    'valid, with nothing to warn about',
    findings.length === 0,
    findings.map(finding => `${finding.path}: ${finding.message}`).join(' | '),
  );

  check(
    'round-trips through the file format',
    JSON.stringify(JSON.parse(serializeConnectorBundle(bundle))) === JSON.stringify(bundle),
  );

  const config: Record<string, string> = {};
  for (const field of bundle.connection.configFields) {
    config[field.name] = field.default ?? placeholderFor(field.name);
  }
  const connection = buildConnectorConnection(bundle, { id: 'conn-test', nowIso: NOW, config });

  check(
    'declares exactly the secret names it needs',
    JSON.stringify(connection.secretKeys) === JSON.stringify(connectorSecretKeyNames(bundle.connection)),
    connection.secretKeys.join(', '),
  );
  check('does not grant write access', connection.allowWrites === undefined);

  const report = inspectAgainstCapabilities(connectorPreviewSpec(bundle, connection.id), TAURI_DESKTOP_CAPABILITIES, [
    { ...connection, secretsPresent: connection.secretKeys.length },
  ]);
  const errors = report.findings.filter(finding => finding.severity === 'error');
  check(
    'every step runs on the desktop host once configured',
    errors.length === 0,
    errors.map(finding => finding.message).join(' | '),
  );
  check('declares at least one egress host', report.egressHosts.length > 0, report.egressHosts.join(', '));

  let bindingOk = true;
  for (const step of bundle.steps) {
    const data = connectorStepNodeData(bundle, step, 'conn-test') as Record<string, unknown>;
    const shouldBind = step.kind === 'http-request' || step.kind === 'sql-query';
    if ('connectionId' in data !== shouldBind) bindingOk = false;
  }
  check('binds a connection id on I/O steps only', bindingOk);

  // Expressions and templates COMPILE with a bogus `input.` prefix, so
  // validation cannot catch this - `input.id` silently means `$.input.id` and
  // `{{input.id}}` looks for a payload field literally called `input`. Both
  // resolve to nothing, which is the worst failure mode for a starter bundle:
  // the step runs and quietly produces nulls. The grammar's names are `item`,
  // `$`, `$text` and `index`, plus a bare `name` for `$.name`.
  const stepJson = JSON.stringify(bundle.steps);
  check(
    'uses no bogus `input.` expression or template path',
    !/\binput\./.test(stepJson),
    (stepJson.match(/[^"]*\binput\.[^"]*/g) ?? []).join(' | '),
  );

  // A bundle that runs NOWHERE is a mistake. A SQL bundle that cannot run in the
  // browser is not - the browser has no SQL client by declaration.
  const hosts: HostCapabilities[] = [TAURI_DESKTOP_CAPABILITIES, CLOUDFLARE_CAPABILITIES, BROWSER_CAPABILITIES];
  const runnable = hosts.filter(host => {
    const hostReport = inspectAgainstCapabilities(connectorPreviewSpec(bundle, connection.id), host, [
      { ...connection, secretsPresent: connection.secretKeys.length },
    ]);
    return !hostReport.findings.some(finding => finding.severity === 'error');
  });
  check(
    'runs on at least one host',
    runnable.length > 0,
    `runnable on: ${runnable.map(host => host.id).join(', ') || 'nothing'}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
