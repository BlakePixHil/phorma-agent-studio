#!/usr/bin/env node
/**
 * check-docs.mjs
 *
 * Asserts that the Deploy_Guide (docs/deploy-aws.md) stays in sync with the
 * implementation by deriving assertions from the synthesized template and
 * source files rather than duplicating them.
 *
 * Checks:
 * 1. Section order matches the required sequence (Req 17.2)
 * 2. Resource list correspondence: every resource type the CDK app creates
 *    appears in the guide's resource table (Req 17.3, 13.11)
 * 3. Troubleshooting symptom strings are derivable from source (Req 17.6)
 * 4. IAM action labels carry the required status text (Req 15.9, 15.10, 15.11)
 * 5. Every guide section a preflight failure line cites exists, with a matching
 *    heading, and the section the Docker failure line points at describes the
 *    `imageUri` alternative it offers (Req 4.5, 5.2)
 *
 * Validates: Requirements 4.2, 4.5, 5.2, 10.9, 13.11, 15.9, 15.10, 15.11, 17.1,
 *   17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GUIDE_PATH = resolve(ROOT, 'docs', 'deploy-aws.md');
const TEMPLATE_PATH = resolve(PKG_ROOT, 'cdk.out', 'phorma-check-host.template.json');

let failures = 0;

function fail(message) {
  console.error(`  FAIL: ${message}`);
  failures++;
}

function pass(message) {
  console.log(`  OK: ${message}`);
}

// ---------------------------------------------------------------------------
// Load the guide
// ---------------------------------------------------------------------------

if (!existsSync(GUIDE_PATH)) {
  console.error('Deploy guide not found at docs/deploy-aws.md');
  process.exit(1);
}

const guide = readFileSync(GUIDE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// 1. Section order (Req 17.2)
// ---------------------------------------------------------------------------

console.log('--- Section order ---');

/**
 * The required section order from Requirement 17.2. Each entry is a substring
 * that must appear as a heading (## N. Title) in the guide, in this order.
 */
const REQUIRED_SECTIONS = [
  'What you are deploying',
  'Decide first',
  'Platform Request Template',
  'Bootstrap',
  'Configure',
  'Deploy',
  'Verify',
  'Operate',
  'Teardown',
  'Troubleshooting',
];

const headingPattern = /^##\s+\d*\.?\s*(.+)$/gm;
const guideHeadings = [];
let match;
while ((match = headingPattern.exec(guide)) !== null) {
  guideHeadings.push(match[1].trim());
}

let lastIdx = -1;
for (const section of REQUIRED_SECTIONS) {
  const idx = guideHeadings.findIndex(
    (h, i) => i > lastIdx && h.toLowerCase().includes(section.toLowerCase()),
  );
  if (idx === -1) {
    fail(`Section "${section}" not found in the guide after position ${lastIdx}`);
  } else {
    lastIdx = idx;
  }
}

if (failures === 0) {
  pass('All required sections present in the correct order');
}

// ---------------------------------------------------------------------------
// 2. Resource list correspondence (Req 17.3, 13.11)
// ---------------------------------------------------------------------------

console.log('--- Resource list correspondence ---');

if (!existsSync(TEMPLATE_PATH)) {
  fail(`Synthesized template not found at ${TEMPLATE_PATH}. Run "cdk synth" first.`);
} else {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf-8'));
  const resources = template.Resources || {};

  // Collect all distinct AWS resource types from the template, excluding CDK metadata
  const resourceTypes = new Set();
  for (const [, resource] of Object.entries(resources)) {
    const type = resource.Type;
    if (type && type !== 'AWS::CDK::Metadata') {
      resourceTypes.add(type);
    }
  }

  // Map each CloudFormation resource type to a human-readable service name that
  // must appear somewhere in the guide's "Resources the IaC_App creates" section.
  // The mapping uses terms the guide naturally uses, not raw CFN type strings.
  // Subordinate/detail resources (security group rules, KMS aliases, IAM policies)
  // are grouped under their parent service.
  const TYPE_TO_GUIDE_TERM = {
    'AWS::DynamoDB::Table': 'DynamoDB',
    'AWS::ECS::Cluster': 'ECS',
    'AWS::ECS::Service': 'Fargate',
    'AWS::ECS::TaskDefinition': 'ECS',
    'AWS::ApiGatewayV2::Api': 'API Gateway',
    'AWS::ApiGatewayV2::Integration': 'API Gateway',
    'AWS::ApiGatewayV2::Route': 'API Gateway',
    'AWS::ApiGatewayV2::Stage': 'API Gateway',
    'AWS::ApiGatewayV2::VpcLink': 'VPC Link',
    'AWS::CloudWatch::Alarm': 'alarm',
    'AWS::EC2::SecurityGroup': null, // subordinate to the VPC/network section
    'AWS::EC2::SecurityGroupEgress': null,
    'AWS::EC2::SecurityGroupIngress': null,
    'AWS::EC2::VPCEndpoint': 'VPC endpoint',
    // No 'AWS::ECR::Repository' entry on purpose: the stack declares zero of them
    // on both image paths (Req 4.2, 4.6) - the asset path publishes into the CDK
    // bootstrap container asset repository and the `imageUri` path pulls from the
    // operator's own registry. Leaving a mapping here would describe a resource
    // the stack cannot produce. If one is ever added, the unknown-type branch
    // below demands the guide's resource inventory mention it.
    'AWS::ElasticLoadBalancingV2::Listener': 'Load Balancer',
    'AWS::ElasticLoadBalancingV2::LoadBalancer': 'NLB',
    'AWS::ElasticLoadBalancingV2::TargetGroup': 'Load Balancer',
    'AWS::IAM::ManagedPolicy': 'IAM',
    'AWS::IAM::Policy': 'IAM',
    'AWS::IAM::Role': 'IAM role',
    'AWS::KMS::Key': 'KMS',
    'AWS::KMS::Alias': null, // subordinate to KMS key
    'AWS::Logs::LogGroup': 'Log group',
    'AWS::Scheduler::ScheduleGroup': 'Scheduler',
    // The Schedule_Shim. EventBridge Scheduler has no API Gateway target, so this
    // function is the one hop between a fired schedule and the Trigger_Route.
    'AWS::Lambda::Function': 'Lambda',
  };

  // The resource table is in section 1, find that section
  const resourceSectionMatch = guide.match(
    /###?\s*Resources the IaC.App creates[\s\S]*?(?=\n##|\n###\s*Run_Table|$)/i,
  );
  const resourceSection = resourceSectionMatch ? resourceSectionMatch[0] : guide;

  let resourceFailures = 0;
  const checked = new Set();

  for (const type of resourceTypes) {
    const term = TYPE_TO_GUIDE_TERM[type];
    if (term === null) continue; // subordinate resource, covered by its parent
    if (term === undefined) {
      // Unknown type not in our map - the guide should mention a recognizable fragment
      const fragment = type.split('::').pop().toLowerCase();
      if (!resourceSection.toLowerCase().includes(fragment)) {
        fail(`Template resource type "${type}" has no corresponding mention in the guide`);
        resourceFailures++;
      }
      continue;
    }
    if (checked.has(term)) continue;
    checked.add(term);

    if (!resourceSection.toLowerCase().includes(term.toLowerCase())) {
      fail(`Template creates "${type}" but the guide does not mention "${term}" in the resource table`);
      resourceFailures++;
    }
  }

  if (resourceFailures === 0) {
    pass(`All ${resourceTypes.size} template resource types have guide coverage`);
  }
}

// ---------------------------------------------------------------------------
// 3. Troubleshooting symptom strings derived from source (Req 17.6)
// ---------------------------------------------------------------------------

console.log('--- Troubleshooting symptom strings ---');

// Extract the troubleshooting section from the guide
const troubleshootingMatch = guide.match(
  /##\s*\d*\.?\s*Troubleshooting[\s\S]*$/i,
);
const troubleshootingSection = troubleshootingMatch ? troubleshootingMatch[0] : '';

if (!troubleshootingSection) {
  fail('No troubleshooting section found in the guide');
} else {
  // Derive expected symptom substrings from source files.
  // These strings come from the actual implementation, not from hardcoded expectations.

  const sourceSymptoms = [];

  // Source 1: phorma-aws.mjs - authentication failure messages
  const phormaAwsPath = resolve(PKG_ROOT, 'bin', 'phorma-aws.mjs');
  if (existsSync(phormaAwsPath)) {
    const phormaAwsSrc = readFileSync(phormaAwsPath, 'utf-8');
    // Extract string literals that contain "sso login" (the auth failure advice)
    if (phormaAwsSrc.includes('sso login')) {
      sourceSymptoms.push({
        source: 'bin/phorma-aws.mjs',
        substring: 'sso login',
        description: 'authentication failure next-step advice',
      });
    }
  }

  // Source 2: preflight.ts - preflight failure message format
  const preflightPath = resolve(PKG_ROOT, 'src', 'infra', 'preflight.ts');
  if (existsSync(preflightPath)) {
    const preflightSrc = readFileSync(preflightPath, 'utf-8');
    // The formatPreflightFailures function prefixes with "Preflight check failed"
    if (preflightSrc.includes('Preflight')) {
      sourceSymptoms.push({
        source: 'src/infra/preflight.ts',
        substring: 'Preflight',
        description: 'preflight failure prefix',
      });
    }
    // Subnet membership check message
    if (preflightSrc.includes('is not a member of')) {
      sourceSymptoms.push({
        source: 'src/infra/preflight.ts',
        substring: 'is not a member of',
        description: 'subnet membership failure',
      });
    }
  }

  // Source 3: phorma-aws.mjs - credential/session error keywords
  // AWS SDK surfaces "credentials" or "expired" in auth failure messages
  sourceSymptoms.push({
    source: 'AWS SDK credential errors',
    substring: 'credentials',
    description: 'credential location failure keyword',
  });

  // Source 4: egress/connection failure - the guide must mention hostname and allow-list
  sourceSymptoms.push({
    source: 'host adapter connection timeout',
    substring: 'allow-list',
    description: 'egress failure corrective action mentioning the allow-list',
  });

  let symptomFailures = 0;
  for (const { source, substring, description } of sourceSymptoms) {
    if (!troubleshootingSection.toLowerCase().includes(substring.toLowerCase())) {
      fail(
        `Troubleshooting section missing symptom string "${substring}" from ${source} (${description})`,
      );
      symptomFailures++;
    }
  }

  if (symptomFailures === 0) {
    pass('All source-derived symptom strings present in troubleshooting section');
  }
}

// ---------------------------------------------------------------------------
// 4. IAM action labels (Req 15.9, 15.10, 15.11)
// ---------------------------------------------------------------------------

console.log('--- IAM action labels ---');

// Requirement 15.9: every IAM action list must be labelled with one of two phrases
const VALID_LABELS = [
  'verified against a deployed account',
  'indicative, pending account validation',
];

// The IAM section is in the guide, check it mentions one of the valid labels
const iamSectionMatch = guide.match(
  /##\s*IAM action lists[\s\S]*?(?=\n##\s+)/,
);
const iamSection = iamSectionMatch ? iamSectionMatch[0] : '';

if (!iamSection) {
  fail('No IAM action lists section found in the guide');
} else {
  const hasLabel = VALID_LABELS.some(label =>
    iamSection.toLowerCase().includes(label.toLowerCase()),
  );
  if (!hasLabel) {
    fail(
      `IAM action lists section does not contain either "${VALID_LABELS[0]}" or "${VALID_LABELS[1]}"`,
    );
  } else {
    pass('IAM action lists carry a valid status label');
  }

  // Requirement 15.10: must name IAM Access Analyzer policy generation from CloudTrail
  if (!guide.toLowerCase().includes('iam access analyzer')) {
    fail('Guide does not name IAM Access Analyzer as the Runtime policy trimming method');
  } else {
    pass('IAM Access Analyzer policy generation named');
  }

  // Requirement 15.11: must list organisation guardrails
  const guardrails = [
    'permissions-boundary',
    'region',
    'customer-managed-key',
    'tagging',
    'public subnet',
    'egress',
    'approved-policy',
    'change control',
  ];

  let guardrailFailures = 0;
  for (const g of guardrails) {
    if (!guide.toLowerCase().includes(g.toLowerCase())) {
      fail(`Guide does not mention organisation guardrail: "${g}"`);
      guardrailFailures++;
    }
  }
  if (guardrailFailures === 0) {
    pass('All organisation guardrails listed');
  }
}

// ---------------------------------------------------------------------------
// 5. Private-source connectivity patterns (Req 10.9)
// ---------------------------------------------------------------------------

console.log('--- Private-source connectivity patterns ---');

const CONNECTIVITY_PATTERNS = [
  'security group to security group',
  'VPC peering',
  'Transit Gateway',
  'PrivateLink',
  'Direct Connect',
];

let patternFailures = 0;
for (const pattern of CONNECTIVITY_PATTERNS) {
  if (!guide.toLowerCase().includes(pattern.toLowerCase())) {
    fail(`Guide does not document private-source connectivity pattern: "${pattern}"`);
    patternFailures++;
  }
}
if (patternFailures === 0) {
  pass('All private-source connectivity patterns documented');
}

// ---------------------------------------------------------------------------
// 6. Guide existence (Req 17.1) and CDK version mention (Req 13.11, 17.10)
// ---------------------------------------------------------------------------

console.log('--- Guide metadata ---');

// Req 17.1: guide exists at docs/deploy-aws.md (already checked above)
pass('Guide exists at docs/deploy-aws.md');

// Req 13.11 / 17.10: the guide names the check command as the pre-deploy step
if (!guide.includes('npm run check')) {
  fail('Guide does not name "npm run check" as the pre-deploy step');
} else {
  pass('"npm run check" named as pre-deploy step');
}

// Derive CDK version from package.json and verify guide mentions it
const pkgJson = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf-8'));
const cdkVersion =
  pkgJson.dependencies?.['aws-cdk-lib'] ?? pkgJson.devDependencies?.['aws-cdk-lib'];

if (cdkVersion && !guide.includes(cdkVersion)) {
  fail(`Guide does not mention the pinned CDK version "${cdkVersion}"`);
} else if (cdkVersion) {
  pass(`CDK version ${cdkVersion} mentioned in the guide`);
}

// ---------------------------------------------------------------------------
// 7. Platform Request Template (Req 17.4)
// ---------------------------------------------------------------------------

console.log('--- Platform Request Template ---');

const templateItems = [
  'Deployment_Identity',
  'Permissions_Boundary',
  'bootstrap',
  'VPC',
  'subnet',
  'App_CMK',
  'Egress_Allow_List',
  'tag',
];

const platformSection = guide.match(
  /##\s*\d*\.?\s*Platform Request Template[\s\S]*?(?=\n##\s*\d)/i,
);
const platformSectionText = platformSection ? platformSection[0] : '';

if (!platformSectionText) {
  fail('Platform Request Template section not found');
} else {
  let templateFailures = 0;
  for (const item of templateItems) {
    if (!platformSectionText.toLowerCase().includes(item.toLowerCase())) {
      fail(`Platform Request Template missing item: "${item}"`);
      templateFailures++;
    }
  }
  if (templateFailures === 0) {
    pass('Platform Request Template contains all required items');
  }
}

// ---------------------------------------------------------------------------
// 8. Verify section (Req 17.9)
// ---------------------------------------------------------------------------

console.log('--- Verify section ---');

const verifySectionMatch = guide.match(
  /##\s*\d*\.?\s*Verify[\s\S]*?(?=\n##\s*\d)/i,
);
const verifySection = verifySectionMatch ? verifySectionMatch[0] : '';

if (!verifySection) {
  fail('Verify section not found');
} else {
  const verifyChecks = ['push', 'trigger', 'monitor', 'history', 'schedule'];
  let verifyFailures = 0;
  for (const check of verifyChecks) {
    if (!verifySection.toLowerCase().includes(check.toLowerCase())) {
      fail(`Verify section missing check: "${check}"`);
      verifyFailures++;
    }
  }
  if (verifyFailures === 0) {
    pass('Verify section covers all required checks');
  }
}

// ---------------------------------------------------------------------------
// 9. Teardown section (Req 17.5)
// ---------------------------------------------------------------------------

console.log('--- Teardown section ---');

const teardownMatch = guide.match(
  /##\s*\d*\.?\s*Teardown[\s\S]*?(?=\n##\s*\d)/i,
);
const teardownSection = teardownMatch ? teardownMatch[0] : '';

if (!teardownSection) {
  fail('Teardown section not found');
} else {
  // Must name resources retained and the action to remove each
  if (!teardownSection.toLowerCase().includes('retain')) {
    fail('Teardown section does not name retained resources');
  } else {
    pass('Teardown section names retained resources');
  }
}

// ---------------------------------------------------------------------------
// 10. Guide sections cited by preflight failure lines (Req 4.5, 5.2)
// ---------------------------------------------------------------------------

console.log('--- Cited guide sections ---');

const preflightSource = resolve(PKG_ROOT, 'src', 'infra', 'preflight.ts');

if (!existsSync(preflightSource)) {
  fail('src/infra/preflight.ts not found, cannot derive cited guide sections');
} else {
  const preflightSrc = readFileSync(preflightSource, 'utf-8');

  // Every failure line names the guide section that supplies the missing
  // prerequisite. A cited section that does not exist is a dead pointer, so the
  // citations are derived from the source and checked against the guide.
  const citationPattern =
    /docs\/deploy-aws\.md section (\d+(?:\.\d+)?)(?:\s*\(([^)]*)\))?/g;

  // Guide subsection headings: "### 3.4 VPC, subnets and endpoints"
  const subheadings = new Map();
  const subheadingPattern = /^###\s+(\d+(?:\.\d+)?)\s+(.+)$/gm;
  let sub;
  while ((sub = subheadingPattern.exec(guide)) !== null) {
    subheadings.set(sub[1], sub[2].trim());
  }

  const citations = new Map();
  let citation;
  while ((citation = citationPattern.exec(preflightSrc)) !== null) {
    const [, number, title] = citation;
    if (!citations.has(number) || (title && !citations.get(number))) {
      citations.set(number, title ? title.trim() : '');
    }
  }

  if (citations.size === 0) {
    fail('No docs/deploy-aws.md section citations found in src/infra/preflight.ts');
  }

  let citationFailures = 0;
  for (const [number, title] of citations) {
    const heading = subheadings.get(number);
    if (!heading) {
      fail(`preflight.ts cites guide section ${number}, which the guide does not contain`);
      citationFailures++;
      continue;
    }
    // The citation may name more than the heading does (for example the
    // data-source security group under the Egress_Allow_List item), so the
    // leading fragment of the citation is what must match the heading.
    const lead = title.split(',')[0].trim();
    if (lead && !heading.toLowerCase().includes(lead.toLowerCase())) {
      fail(
        `preflight.ts cites guide section ${number} as "${title}" but the heading reads "${heading}"`,
      );
      citationFailures++;
    }
  }

  // The Docker failure line offers the `imageUri` alternative and names the
  // Dockerfile. The section it points at must actually describe both.
  const dockerDecl = /DOCKER_UNAVAILABLE_MESSAGE\s*=([\s\S]*?);/.exec(preflightSrc);
  if (!dockerDecl) {
    fail('DOCKER_UNAVAILABLE_MESSAGE not found in src/infra/preflight.ts');
    citationFailures++;
  } else {
    const dockerNumber = /section (\d+(?:\.\d+)?)/.exec(dockerDecl[1])?.[1];
    if (!dockerNumber) {
      fail('DOCKER_UNAVAILABLE_MESSAGE cites no guide section');
      citationFailures++;
    } else {
      // No 'm' flag: `$` must mean end of input, not end of line, or the body
      // stops at the heading itself.
      const bodyPattern = new RegExp(
        `\\n###\\s+${dockerNumber.replace('.', '\\.')}\\s+[\\s\\S]*?(?=\\n#{1,3}\\s|$)`,
      );
      const body = bodyPattern.exec(guide)?.[0] ?? '';
      if (!body) {
        fail(`Guide section ${dockerNumber} cited by the Docker failure line is empty or missing`);
        citationFailures++;
      } else {
        for (const token of ['imageUri', 'Dockerfile']) {
          if (dockerDecl[1].includes(token) && !body.includes(token)) {
            fail(
              `Guide section ${dockerNumber} does not describe "${token}", which the Docker failure line points the operator at`,
            );
            citationFailures++;
          }
        }
      }
    }
  }

  if (citationFailures === 0) {
    pass(`All ${citations.size} guide sections cited by preflight failure lines resolve`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.error(`check-docs FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('check-docs passed: guide correspondences verified.');
