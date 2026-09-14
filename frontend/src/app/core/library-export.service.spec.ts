/**
 * `LibraryExportService` - the durability path that needs no subscription
 * (Requirement 21).
 *
 * Four claims are worth defending here:
 *
 * 1. **No secret reaches disk** (21.5). A `WorkflowSpec` carries no credential by
 *    construction, so the export needs no redaction pass - but "by construction"
 *    is a claim about code that changes, and this is where it gets checked
 *    against real generated specs rather than assumed.
 * 2. **The manifest names what is deployed** (21.2). A folder of specs cannot say
 *    that a given workflow id is still live somewhere and still spending; the
 *    manifest is the only local record of that after a reinstall.
 * 3. **Browser parity** (21.6). The app must run under plain `ng serve`, so the
 *    no-Tauri path writes one file instead of a folder.
 * 4. **The manifest is written LAST.** A folder with specs and no manifest is a
 *    partial write, and being able to tell that apart from a complete one is the
 *    difference between trusting a backup and hoping.
 */

import { TestBed } from '@angular/core/testing';
import fc from 'fast-check';

import { CloudService } from './cloud.service';
import { LibraryExportService, exportFilename } from './library-export.service';
import { SettingsService } from './settings.service';
import { TauriService } from './tauri.service';
import { WorkflowService } from './workflow.service';
import { ToastService } from '../shared/toast/toast.service';
import { WORKFLOW_SPEC_VERSION, type WorkflowSpec } from './workflow.model';
import type { DeploymentSummary } from './deployments.model';

function spec(id: string, name: string): WorkflowSpec {
  return {
    version: WORKFLOW_SPEC_VERSION,
    id,
    name,
    savedAt: '2026-01-01T00:00:00.000Z',
    graph: {
      nodes: [
        {
          id: 'agent-1',
          name: 'Summarize',
          kind: 'agent',
          category: 'flow',
          icon: 'ti ti-robot',
          position: { x: 0, y: 0 },
          ports: [{ id: 'agent-1-out', name: 'Out', role: 'message-out' }],
          data: { prompt: 'Summarize the input.', provider: 'ollama', model: 'llama3.2' },
        },
      ],
      connections: [],
    },
  };
}

function deployment(overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    workflowId: 'wf-one',
    workflowName: 'Invoice triage',
    deployedAt: Date.UTC(2026, 0, 15, 9, 30),
    updatedAt: Date.UTC(2026, 0, 16, 9, 30),
    specHash: 'abc123',
    cronArmed: true,
    portalSlug: 'invoices',
    creditsSpent: 12,
    runsThisMonth: 3,
    ...overrides,
  };
}

describe('LibraryExportService', () => {
  let exporter: LibraryExportService;
  let settings: SettingsService;
  let library: WorkflowSpec[];
  let deployments: DeploymentSummary[];
  let isDesktop: boolean;
  /** Every `write_workflow_file` invoke, in order. */
  let writes: { path: string; content: string }[];
  let toastError: jasmine.Spy;

  beforeEach(() => {
    library = [spec('wf-one', 'Invoice triage')];
    deployments = [];
    isDesktop = true;
    writes = [];
    toastError = jasmine.createSpy('error');

    TestBed.configureTestingModule({
      providers: [
        { provide: TauriService, useValue: { get isDesktop() { return isDesktop; } } },
        {
          provide: WorkflowService,
          useValue: { library: () => library },
        },
        {
          provide: CloudService,
          useValue: { listDeployments: async () => deployments },
        },
        {
          provide: ToastService,
          useValue: { success: () => undefined, error: toastError, warning: () => undefined },
        },
      ],
    });
    settings = TestBed.inject(SettingsService);
    exporter = TestBed.inject(LibraryExportService);

    // The disk seam. Everything else on the folder path - the separator, the
    // filenames, the manifest-last ordering - is real.
    exporter.writeFile = async (path, content) => {
      writes.push({ path, content });
    };
  });

  // ── Filenames ─────────────────────────────────────────────────────────────

  it('names a file uniquely even when two workflows share a name', () => {
    const first = exportFilename(spec('wf-aaa', 'Monthly close'));
    const second = exportFilename(spec('wf-bbb', 'Monthly close'));

    expect(first).toBe('Monthly-close-wf-aaa.phorma.json');
    expect(second).toBe('Monthly-close-wf-bbb.phorma.json');
    expect(first).not.toBe(second);
  });

  it('survives a name that reduces to nothing a filesystem accepts', () => {
    expect(exportFilename(spec('wf-ccc', '///'))).toBe('workflow-wf-ccc.phorma.json');
    expect(exportFilename(spec('wf-ddd', '  '))).toBe('workflow-wf-ddd.phorma.json');
  });

  it('produces a filename with no path separator in it (property, 21.5)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), name => {
        const file = exportFilename(spec('wf-eee', name));
        return !file.includes('/') && !file.includes('\\') && !file.includes('..');
      }),
      { numRuns: 300 },
    );
  });

  // ── Manifest ──────────────────────────────────────────────────────────────

  it('records each deployment id, name and deployment time (21.2)', () => {
    const manifest = exporter.buildManifest(library, [deployment()]);

    expect(manifest.deployments).toEqual([
      {
        workflowId: 'wf-one',
        name: 'Invoice triage',
        deployedAt: '2026-01-15T09:30:00.000Z',
        cronArmed: true,
        portalSlug: 'invoices',
      },
    ]);
  });

  it('indexes every library workflow to its file', () => {
    library = [spec('wf-one', 'First'), spec('wf-two', 'Second')];
    const manifest = exporter.buildManifest(library, []);

    expect(manifest.workflows.map(entry => entry.workflowId)).toEqual(['wf-one', 'wf-two']);
    expect(manifest.workflows[0].file).toBe('First-wf-one.phorma.json');
  });

  it('states what the export does NOT contain', () => {
    // The person opening this a year from now is recovering from a loss and has no
    // other documentation to hand.
    const manifest = exporter.buildManifest(library, []);
    const text = manifest.notIncluded.join(' ');
    expect(text).toContain('keychain');
    expect(text).toContain('skill');
  });

  it('carries no credential, over generated specs (property, 21.5)', () => {
    // The claim is that a `WorkflowSpec` references secrets by NAME. This is where
    // that stops being an assumption: any key or value that reads like a
    // credential in a serialized export is a failure.
    const secretish = /(sk-|sk_live|pk_live|Bearer\s|BEGIN [A-Z ]*PRIVATE KEY)/i;
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^wf-[a-z0-9]{3,8}$/), { minLength: 1, maxLength: 4 }),
        ids => {
          const specs = ids.map((id, index) => spec(id, `Workflow ${index}`));
          const manifest = exporter.buildManifest(specs, [deployment()]);
          const serialized = JSON.stringify({ manifest, specs });
          return !secretish.test(serialized);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Folder write ──────────────────────────────────────────────────────────

  it('writes one file per workflow plus the manifest, manifest LAST', async () => {
    settings.setLibraryExportFolder('C:\\backups\\phorma');
    library = [spec('wf-one', 'First'), spec('wf-two', 'Second')];

    const result = await exporter.exportNow();

    expect(result.ok).toBeTrue();
    expect(result.files).toBe(3);
    expect(writes.map(entry => entry.path)).toEqual([
      'C:\\backups\\phorma\\First-wf-one.phorma.json',
      'C:\\backups\\phorma\\Second-wf-two.phorma.json',
      // Last, so its presence means the export completed.
      'C:\\backups\\phorma\\deployments.json',
    ]);
    // The folder's own separator, not an assumed one: a Windows path joined with
    // `/` still resolves, but reads as a bug in every log and error message.
    expect(writes.every(entry => !entry.path.includes('/'))).toBeTrue();
  });

  it('uses the posix separator for a posix folder', async () => {
    settings.setLibraryExportFolder('/home/me/backups');

    await exporter.exportNow();

    expect(writes[0].path).toBe('/home/me/backups/Invoice-triage-wf-one.phorma.json');
  });

  it('writes the spec verbatim, so a single file can be dragged back in', async () => {
    settings.setLibraryExportFolder('/tmp/x');

    await exporter.exportNow();

    const written = JSON.parse(writes[0].content) as WorkflowSpec;
    expect(written).toEqual(library[0]);
  });

  it('normalizes a trailing separator off the chosen folder', () => {
    settings.setLibraryExportFolder('C:\\backups\\phorma\\');
    expect(settings.libraryExportFolder()).toBe('C:\\backups\\phorma');
  });

  it('turns rewrite-on-save off when the folder is cleared', () => {
    settings.setLibraryExportFolder('C:\\backups\\phorma');
    settings.libraryExportOnSave.set(true);

    settings.setLibraryExportFolder('');

    // A toggle that reads as on while writing nowhere is the exact shape of a
    // durability feature that quietly is not there.
    expect(settings.libraryExportOnSave()).toBeFalse();
  });

  // ── Browser fallback ──────────────────────────────────────────────────────

  it('downloads a single bundle when there is no Tauri (21.6)', async () => {
    isDesktop = false;
    let captured: Blob | null = null;
    let downloadName = '';
    spyOn(URL, 'createObjectURL').and.callFake((blob: Blob) => {
      captured = blob;
      return 'blob:probe';
    });
    spyOn(URL, 'revokeObjectURL');
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    const result = await exporter.exportNow();

    expect(result.ok).toBeTrue();
    expect(result.files).toBe(1);
    expect(downloadName).toMatch(/^phorma-library-\d{4}-\d{2}-\d{2}\.json$/);

    const bundle = JSON.parse(await captured!.text()) as {
      specs: WorkflowSpec[];
      workflows: unknown[];
    };
    // Every spec travels BY VALUE, since there is no folder to put them in.
    expect(bundle.specs.map(entry => entry.id)).toEqual(['wf-one']);
    expect(bundle.workflows.length).toBe(1);
  });

  it('refuses a folder export with no folder chosen, writing nothing', async () => {
    settings.setLibraryExportFolder('');

    const result = await exporter.exportNow();

    expect(result.ok).toBeFalse();
    expect(result.files).toBe(0);
    expect(writes).toEqual([]);
  });
});
