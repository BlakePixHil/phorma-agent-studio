import { TestBed, fakeAsync, tick, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { PropertiesForm } from './properties-form';
import { SelectionService } from '../../../core/selection.service';
import { WorkflowService } from '../../../core/workflow.service';
import { IndexedDbStorageService } from '../../../core/indexed-db-storage.service';
import type {
  AggregateNodeData,
  HttpRequestNodeData,
  TransformNodeData,
} from '../../../core/workflow.model';
import type { Connection } from '@phorma/engine';
import { TauriService } from '../../../core/tauri.service';

/**
 * Requirement 19.2: every field of the selected data node kind gets a control,
 * and no control belonging only to another kind is rendered. The labels carry
 * deterministic `for` attributes (`{scope}-prop-*`), so the DOM is the honest
 * place to assert both halves of that rule.
 */
/** Mirrors the component's debounce window (Requirement 19.3). */
const EXPRESSION_DEBOUNCE = 300;

describe('PropertiesForm data nodes', () => {
  let fixture: ComponentFixture<PropertiesForm>;
  let workflow: WorkflowService;
  let selection: SelectionService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PropertiesForm],
      providers: [
        provideNoopAnimations(),
        // Desktop capabilities declare every connection type; the browser
        // record declares none, which would make the picker vacuous below.
        { provide: TauriService, useValue: { isDesktop: true } },
      ],
    }).compileComponents();

    workflow = TestBed.inject(WorkflowService);
    selection = TestBed.inject(SelectionService);
    workflow.newWorkflow();
    fixture = TestBed.createComponent(PropertiesForm);
  });

  /** Drops a catalog entry, selects it and renders. Returns the node id. */
  function select(entryId: string): string {
    const node = workflow.addNodeFromCatalog(entryId, { x: 0, y: 0 });
    expect(node).withContext(`catalog entry ${entryId}`).toBeTruthy();
    selection.selectNode(node!.id);
    fixture.detectChanges();
    return node!.id;
  }

  function has(field: string): boolean {
    const root = fixture.nativeElement as HTMLElement;
    return !!root.querySelector(`[id="panel-${field}"], [for="panel-${field}"]`);
  }

  function nodeData<T>(nodeId: string): T {
    const node = workflow.activeDoc()?.graph.nodes.find(item => item.id === nodeId);
    return node!.data as T;
  }

  it('renders request, pagination, retry and fixture controls for http-request', () => {
    select('data-http-request');

    expect(has('prop-connection-id')).toBeTrue();
    expect(has('prop-http-body-mode')).toBeTrue();
    expect(has('prop-http-success-codes')).toBeTrue();
    expect(has('prop-http-pagination')).toBeTrue();
    expect(has('prop-http-idempotency')).toBeTrue();
    expect(has('prop-fixtures')).toBeTrue();
    expect(has('prop-retry-on')).toBeTrue();
    expect(has('prop-data-error-port')).toBeTrue();

    // Fields belonging to other data kinds stay away.
    expect(has('prop-transform-mode')).toBeFalse();
    expect(has('prop-sql-statement')).toBeFalse();
    expect(has('prop-state-get-key')).toBeFalse();
    expect(has('prop-notify-channel')).toBeFalse();
    expect(has('prop-aggregate-op')).toBeFalse();
  });

  it('renders only transform controls for a transform node', () => {
    select('data-transform');

    expect(has('prop-transform-items')).toBeTrue();
    expect(has('prop-transform-mode')).toBeTrue();
    expect(has('prop-transform-result-key')).toBeTrue();
    expect(has('prop-transform-lookups')).toBeTrue();

    // Transform performs no I/O: no connection, no retry, no fixtures, no
    // error port, and none of the other kinds' fields.
    expect(has('prop-connection-id')).toBeFalse();
    expect(has('prop-retry-on')).toBeFalse();
    expect(has('prop-fixtures')).toBeFalse();
    expect(has('prop-data-error-port')).toBeFalse();
    expect(has('prop-http-pagination')).toBeFalse();
    expect(has('prop-assert-breach')).toBeFalse();
    expect(has('prop-state-set-semantics')).toBeFalse();
  });

  it('renders the state, assert and notify controls for their own kinds only', () => {
    select('data-state-set');
    expect(has('prop-state-set-key')).toBeTrue();
    expect(has('prop-state-set-semantics')).toBeTrue();
    expect(has('prop-state-set-ttl')).toBeTrue();
    expect(has('prop-state-get-default')).toBeFalse();
    expect(has('prop-retry-on')).toBeFalse();

    select('data-assert');
    expect(has('prop-assert-breach')).toBeTrue();
    expect(has('prop-assert-baseline')).toBeTrue();
    expect(has('prop-fixtures')).toBeFalse();
    expect(has('prop-data-error-port')).toBeFalse();

    select('data-notify');
    expect(has('prop-notify-channel')).toBeTrue();
    expect(has('prop-notify-body')).toBeTrue();
    expect(has('prop-retry-on')).toBeTrue();
    expect(has('prop-sql-statement')).toBeFalse();
  });

  it('shows SQL controls and hides them again when another kind is selected', () => {
    select('data-sql-query');
    expect(has('prop-sql-statement')).toBeTrue();
    expect(has('prop-sql-max-rows')).toBeTrue();
    expect(has('prop-fixtures')).toBeTrue();

    select('data-aggregate');
    expect(has('prop-sql-statement')).toBeFalse();
    expect(has('prop-aggregate-op')).toBeTrue();
    expect(has('prop-group-by')).toBeTrue();
  });

  it('writes committed edits into the selected node data', () => {
    const httpId = select('data-http-request');
    const root = fixture.nativeElement as HTMLElement;

    const url = root.querySelector<HTMLInputElement>('input[aria-label="Request URL or path"]')!;
    url.value = '/v1/contacts';
    url.dispatchEvent(new Event('input'));
    expect(nodeData<HttpRequestNodeData>(httpId).url).toBe('/v1/contacts');

    const successCodes = root.querySelector<HTMLInputElement>('#panel-prop-http-success-codes')!;
    successCodes.value = '404, oops, 409';
    successCodes.dispatchEvent(new Event('input'));
    expect(nodeData<HttpRequestNodeData>(httpId).successCodes).toEqual([404, 409]);
  });

  /**
   * Requirements 2.9, 19.4: the picker lists connections declared for the
   * active host with name/type/secret-count, marks an incomplete or unmatched
   * selection unusable, and never touches the stored `connectionId` because of
   * it.
   */
  it('lists connections for the picker and marks incomplete or unmatched ones unusable', async () => {
    const db = TestBed.inject(IndexedDbStorageService);
    const now = new Date().toISOString();
    const complete: Connection = {
      id: 'conn-crm',
      name: 'CRM',
      type: 'http',
      config: {},
      secretKeys: [],
      auth: { mode: 'none' },
      createdAt: now,
      updatedAt: now,
    };
    const incomplete: Connection = {
      id: 'conn-lob',
      name: 'LOB',
      type: 'http',
      config: {},
      secretKeys: ['apiKey'],
      auth: { mode: 'bearer', secretKey: 'apiKey' },
      createdAt: now,
      updatedAt: now,
    };
    await db.saveConnection(complete);
    await db.saveConnection(incomplete);

    const httpId = select('data-http-request');
    const form = fixture.componentInstance as unknown as {
      connectionOptions(): { id: string; type: string; secretsPresent: number; secretsTotal: number; disabled: boolean }[];
      connectionUnmatched(): boolean;
    };

    // The picker's connection list loads asynchronously (IndexedDB + keychain
    // presence checks); poll a few change-detection cycles for it to settle.
    let options = form.connectionOptions();
    for (let attempt = 0; attempt < 20 && options.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      fixture.detectChanges();
      options = form.connectionOptions();
    }
    const crm = options.find(option => option.id === 'conn-crm');
    const lob = options.find(option => option.id === 'conn-lob');
    expect(crm).withContext('conn-crm listed').toBeTruthy();
    expect(crm?.disabled).toBeFalse();
    expect(lob?.secretsTotal).toBe(1);
    // No real keychain in this environment: the declared secret can never be
    // "present", so the incomplete connection is correctly marked unusable.
    expect(lob?.disabled).toBeTrue();

    // A stored id matching no listed connection is flagged, but left in place.
    const form2 = fixture.componentInstance as unknown as {
      patchData(patch: Record<string, unknown>): void;
    };
    form2.patchData({ connectionId: 'conn-does-not-exist' });
    fixture.detectChanges();
    expect(form.connectionUnmatched()).toBeTrue();
    expect(nodeData<HttpRequestNodeData>(httpId).connectionId).toBe('conn-does-not-exist');
  });

  /**
   * Requirements 17.8, 17.9, 17.15: a node referencing an unknown connection
   * gets an inline error finding naming the connection, rendered under the
   * header without disabling any control (the connection picker below still
   * accepts input).
   */
  it('shows an inline capability finding for a node with an unresolved connection', () => {
    const httpId = select('data-http-request');
    const form = fixture.componentInstance as unknown as {
      patchData(patch: Record<string, unknown>): void;
      nodeCapabilityFindings(): { severity: string; message: string; nodeId?: string }[];
    };
    form.patchData({ connectionId: 'conn-does-not-exist' });
    fixture.detectChanges();

    const findings = form.nodeCapabilityFindings();
    expect(findings.some(finding => finding.severity === 'error' && finding.nodeId === httpId)).toBeTrue();

    const root = fixture.nativeElement as HTMLElement;
    const rendered = root.querySelector('.phorma-props__finding');
    expect(rendered).withContext('finding rendered inline').toBeTruthy();
    expect(rendered?.textContent).toContain('conn-does-not-exist');
    // Editing stays available: the connection picker select is still present
    // and not disabled by the finding.
    expect(has('prop-connection-id')).toBeTrue();
  });

  it('replaces the pagination config wholesale when the mode changes', () => {
    const httpId = select('data-http-request');
    const form = fixture.componentInstance as unknown as {
      onPaginationModeChange(mode: string): void;
    };

    form.onPaginationModeChange('cursor');
    fixture.detectChanges();
    const cursor = nodeData<HttpRequestNodeData>(httpId).pagination;
    expect(cursor).toEqual({
      mode: 'cursor',
      cursorPath: '',
      cursorParam: 'cursor',
      itemsPath: '',
      maxPages: 100,
    });
    expect(has('prop-page-cursor-path')).toBeTrue();
    expect(has('prop-page-param')).toBeFalse();

    form.onPaginationModeChange('page');
    fixture.detectChanges();
    // No leftover cursor keys: each mode carries only its own configuration.
    expect(Object.keys(nodeData<HttpRequestNodeData>(httpId).pagination ?? {})).not.toContain(
      'cursorPath',
    );
    expect(has('prop-page-param')).toBeTrue();
  });

  it('adds and edits transform fields and keeps unparseable lookups as text', () => {
    const transformId = select('data-transform');
    const form = fixture.componentInstance as unknown as {
      addTransformField(): void;
      updateTransformField(index: number, patch: Record<string, unknown>): void;
      onLookupsInput(event: Event): void;
      lookupsText(): string;
      lookupsError(): string | null;
    };

    form.addTransformField();
    form.updateTransformField(0, { target: 'contact.email', expression: 'lower(item.Email)' });
    fixture.detectChanges();
    expect(nodeData<TransformNodeData>(transformId).fields).toEqual([
      { target: 'contact.email', expression: 'lower(item.Email)' },
    ]);

    const lookups = (fixture.nativeElement as HTMLElement).querySelector<HTMLTextAreaElement>(
      '#panel-prop-transform-lookups',
    )!;
    lookups.value = '{ "region": ';
    lookups.dispatchEvent(new Event('input'));
    expect(form.lookupsError()).toBeTruthy();
    expect(form.lookupsText()).toBe('{ "region": ');
    expect(nodeData<TransformNodeData>(transformId).lookups).toBeUndefined();

    lookups.value = '{ "region": { "n": "North" } }';
    lookups.dispatchEvent(new Event('input'));
    expect(form.lookupsError()).toBeNull();
    expect(nodeData<TransformNodeData>(transformId).lookups).toEqual({ region: { n: 'North' } });
  });

  it('materialises the aggregate spec for the chosen operation', () => {
    const aggregateId = select('data-aggregate');
    const form = fixture.componentInstance as unknown as {
      onAggregateOpChange(op: string): void;
    };

    form.onAggregateOpChange('join');
    fixture.detectChanges();
    const data = nodeData<AggregateNodeData>(aggregateId);
    expect(data.op).toBe('join');
    expect(data.join).toEqual({
      leftPath: '',
      rightPath: '',
      leftKey: '',
      rightKey: '',
      type: 'inner',
    });
    expect(has('prop-join-left-key')).toBeTrue();
    expect(has('prop-group-by')).toBeFalse();
    expect(has('prop-pivot-value-field')).toBeFalse();
  });

  /**
   * Requirement 19.3: validate 300 ms after the last keystroke, show the message
   * with its zero-based position while the result is not ok, clear it while ok,
   * and retain the entered text either way.
   */
  it('validates an expression field 300 ms after the last keystroke', fakeAsync(() => {
    const transformId = select('data-transform');
    const form = fixture.componentInstance as unknown as { addTransformField(): void };
    form.addTransformField();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const expression = root.querySelector<HTMLInputElement>(
      'input[aria-label="Expression for field 1"]',
    )!;
    const message = (): string =>
      root.querySelector('.phorma-props__cron-desc--invalid')?.textContent?.trim() ?? '';

    expression.value = 'lower(item.Email';
    expression.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // Nothing yet: the text is stored, the check is still pending.
    expect(nodeData<TransformNodeData>(transformId).fields[0].expression).toBe('lower(item.Email');
    expect(message()).toBe('');

    tick(299);
    fixture.detectChanges();
    expect(message()).toBe('');

    tick(1);
    fixture.detectChanges();
    expect(message()).toContain('position');
    // The rejected text is retained, in the node and in the field.
    expect(nodeData<TransformNodeData>(transformId).fields[0].expression).toBe('lower(item.Email');
    expect(expression.value).toBe('lower(item.Email');

    expression.value = 'lower(item.Email)';
    expression.dispatchEvent(new Event('input'));
    tick(EXPRESSION_DEBOUNCE);
    fixture.detectChanges();
    expect(message()).toBe('');
    expect(nodeData<TransformNodeData>(transformId).fields[0].expression).toBe('lower(item.Email)');
  }));

  it('validates only once for a burst of keystrokes and drops the check on reselection', fakeAsync(() => {
    select('data-assert');
    const form = fixture.componentInstance as unknown as { addAssertion(): void };
    form.addAssertion();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const expression = root.querySelector<HTMLInputElement>(
      'input[aria-label="Assertion 1 expression"]',
    )!;

    // Two keystrokes 200 ms apart: only the second one's text is validated.
    expression.value = 'len(rows) >';
    expression.dispatchEvent(new Event('input'));
    tick(200);
    expression.value = 'len(rows) > 0';
    expression.dispatchEvent(new Event('input'));
    tick(EXPRESSION_DEBOUNCE);
    fixture.detectChanges();
    expect(root.querySelector('.phorma-props__cron-desc--invalid')).toBeNull();

    // A pending check never lands on another node.
    expression.value = 'len(rows) >';
    expression.dispatchEvent(new Event('input'));
    select('data-transform');
    tick(EXPRESSION_DEBOUNCE);
    fixture.detectChanges();
    expect(root.querySelector('.phorma-props__cron-desc--invalid')).toBeNull();
  }));
});
