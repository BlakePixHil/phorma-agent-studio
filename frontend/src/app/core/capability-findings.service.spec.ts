import { TestBed } from '@angular/core/testing';

import { CapabilityFindingsService } from './capability-findings.service';
import { TauriService } from './tauri.service';
import { findWorkflowTemplate } from './workflow-templates';
import { WorkflowService } from './workflow.service';

/**
 * The canvas badge and the properties panel validate the active document
 * WITH its workflow settings. Validating the graph alone made every
 * `vars.x` reference read as "not defined" and every url built from one read
 * as "not statically determinable", on a template whose variables were set.
 */
describe('CapabilityFindingsService - workflow variables', () => {
  let findings: CapabilityFindingsService;
  let workflow: WorkflowService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: TauriService, useValue: { isDesktop: true } }],
    });
    findings = TestBed.inject(CapabilityFindingsService);
    workflow = TestBed.inject(WorkflowService);
  });

  it('reports nothing for the weekly applications template, whose variables are declared', async () => {
    workflow.importSpec(await findWorkflowTemplate('tpl-weekly-job-applications')!.build());
    TestBed.flushEffects();

    expect(findings.localFindings().map(finding => finding.message)).toEqual([]);
  });

  it('still reports a reference to a variable the workflow does not declare', async () => {
    const spec = await findWorkflowTemplate('tpl-weekly-job-applications')!.build();
    spec.settings = {
      ...spec.settings,
      variables: spec.settings?.variables?.filter(variable => variable.name !== 'applyApiUrl'),
    };
    workflow.importSpec(spec);
    TestBed.flushEffects();

    const messages = findings.localFindings().map(finding => finding.message);
    expect(messages).toContain(
      '"Submit by API" references workflow variable "applyApiUrl", which is not defined.',
    );
    expect(messages.some(message => message.includes('not statically determinable'))).toBeTrue();
  });
});
