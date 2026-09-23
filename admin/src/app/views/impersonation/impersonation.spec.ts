// The impersonation view - `views/impersonation/impersonation.ts`
// (multi-organisation-phorma task 13, Requirements 14.11, 14.12, 18.1).
//
// This is the only surface in the whole product that can read a customer's account
// as that customer, so the assertions here are about the four things that make that
// safe rather than about the table markup:
//
//   1. the act-as header is SENT, on the customer read, carrying the owner the
//      operator typed - and it is NOT sent on the audit read, which is an ordinary
//      operator read of an `/api/admin/*` route. A header on the wrong request would
//      be silently honoured by the Worker for a route nobody meant to impersonate.
//   2. the request is a GET. Impersonation is read-only, and this view offers no
//      control that writes, so the one request it issues must be a read.
//   3. a read RELOADS the audit, because the Worker wrote the row before answering.
//      Watching your own action appear is the only in-product evidence the record is
//      real, and it must happen on a refusal too - a refusal on the audit-write path
//      is exactly when an operator needs to see what did and did not get recorded.
//   4. an unusable owner id issues NOTHING. The Worker ignores a value it does not
//      recognise and answers with the caller's own data and no error, so a typo
//      would otherwise read as "that customer has nothing deployed".
//
// Plus the exclusivity assertion every view in this package carries: exactly one
// `[data-view-state]` element is present in each state.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';

import { VIEW_NAV } from '../../app';
import { routes } from '../../app.routes';
import { ACT_AS_HEADER, SESSION_TOKEN_RESOLVER } from '../../core/admin-api';
import {
  IMPERSONATION_ADMIN_PATH,
  SUPPORT_DEPLOYMENTS_PATH,
} from '../../core/impersonation-api.service';
import {
  IMPERSONATION_VIEW_ID,
  type ImpersonationAuditResponse,
  type SupportDeploymentsResponse,
} from '../../core/impersonation-models';
import { Impersonation, OWNER_ID_HINT } from './impersonation';

/** Any non-blank token: the bearer funnel is `admin-api`'s subject, not this file's. */
const TOKEN = 'sess_live_token';

const OWNER = 'org_acme';

function auditBody(overrides: Partial<ImpersonationAuditResponse> = {}): ImpersonationAuditResponse {
  return {
    entries: [
      {
        id: 2,
        actingUserId: 'user_operator',
        ownerId: OWNER,
        method: 'GET',
        path: '/api/deployments',
        at: '2026-02-02T10:00:00.000Z',
      },
      {
        id: 1,
        actingUserId: 'user_operator',
        ownerId: 'user_solo',
        method: 'GET',
        path: '/api/me',
        at: '2026-02-01T09:00:00.000Z',
      },
    ],
    owner: null,
    limit: 100,
    truncated: false,
    generatedAt: '2026-02-02T10:00:01.000Z',
    ...overrides,
  };
}

function deploymentsBody(
  overrides: Partial<SupportDeploymentsResponse> = {},
): SupportDeploymentsResponse {
  return {
    month: '2026-02',
    deployments: [
      {
        workflowId: 'wf-invoices',
        workflowName: 'Invoice chaser',
        updatedAt: Date.parse('2026-02-01T08:00:00.000Z'),
        cronArmed: true,
        portalSlug: null,
        creditsSpent: 42,
        runsThisMonth: 7,
      },
    ],
    ...overrides,
  };
}

/** Drains pending microtasks, including the resource loader's own awaits. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted {
  fixture: ComponentFixture<Impersonation>;
  view: Impersonation;
  host: HTMLElement;
  http: HttpTestingController;
}

function mount(): Mounted {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      providePrimeNG({ theme: { preset: Aura } }),
      { provide: SESSION_TOKEN_RESOLVER, useValue: () => Promise.resolve(TOKEN) },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(Impersonation);
  fixture.detectChanges();
  return { fixture, view: fixture.componentInstance, host: fixture.nativeElement, http };
}

/**
 * Waits for one request matching `predicate` and hands it back.
 *
 * Settles repeatedly rather than once, because a resource loader awaits the
 * session-token resolver before it issues anything: a single drain is enough for the
 * first load and NOT enough after a `reload()` that was itself triggered from inside
 * a resolved promise chain.
 *
 * `match()` DEQUEUES, so the array is captured once and flushed from it - calling it
 * again to count would leave every request unflushed and the view stuck loading with
 * nothing to blame.
 */
async function awaitRequest(mounted: Mounted, predicate: (url: string) => boolean, label: string) {
  for (let round = 0; round < 6; round += 1) {
    mounted.fixture.detectChanges();
    await settle();
    const matched = mounted.http.match((candidate) => predicate(candidate.url));
    if (matched.length > 0) {
      expect(matched.length).toBe(1);
      return matched[0];
    }
  }
  throw new Error(`no request was issued for ${label}`);
}

/** Answers the audit read and lets the view render. */
async function answerAudit(mounted: Mounted, body = auditBody()) {
  const request = await awaitRequest(
    mounted,
    (url) => url.endsWith(IMPERSONATION_ADMIN_PATH),
    'the audit read',
  );
  expect(request.request.method).toBe('GET');
  expect(request.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  request.flush(body);
  mounted.fixture.detectChanges();
  await settle();
  mounted.fixture.detectChanges();
  return request;
}

function stateElements(host: HTMLElement): Element[] {
  return Array.from(host.querySelectorAll('[data-view-state]'));
}

/** A mounted view with the audit loaded. */
async function withAudit(body = auditBody()): Promise<Mounted> {
  const mounted = mount();
  await answerAudit(mounted, body);
  return mounted;
}

describe('Impersonation view', () => {
  it('renders the audit, naming who acted, as whom, and what they read', async () => {
    const mounted = mount();
    expect(stateElements(mounted.host).length).toBe(1);
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('loading');

    await answerAudit(mounted);

    const copy = mounted.host.textContent ?? '';
    expect(copy).toContain('user_operator');
    expect(copy).toContain(OWNER);
    expect(copy).toContain('/api/deployments');
    expect(stateElements(mounted.host).length).toBe(1);
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('loaded');

    mounted.http.verify();
  });

  it('says so rather than showing an empty table when nobody has impersonated anybody', async () => {
    const mounted = await withAudit(auditBody({ entries: [] }));

    // A sentence rather than the empty rail: "nobody has read a customer's account"
    // is a real and reassuring answer, not an absence of data to hide behind.
    expect(mounted.host.textContent ?? '').toContain('Nobody has read');
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('loaded');

    mounted.http.verify();
  });

  it('sends the act-as header on the customer read, as a GET, and on no other request', async () => {
    const mounted = await withAudit();

    // The audit read is an ORDINARY operator read. A stray act-as header on it would
    // be honoured by the Worker for a route nobody meant to impersonate.
    const audit = mounted.http.match(() => true);
    expect(audit.length).toBe(0);

    mounted.view.draftOwner.set(OWNER);
    mounted.fixture.detectChanges();
    void mounted.view.read();

    const read = await awaitRequest(
      mounted,
      (url) => url.endsWith(SUPPORT_DEPLOYMENTS_PATH),
      'the customer read',
    );
    expect(read.request.method).toBe('GET');
    expect(read.request.headers.get(ACT_AS_HEADER)).toBe(OWNER);
    expect(read.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    read.flush(deploymentsBody());

    // And the audit is reloaded, because the Worker wrote the row before answering.
    await answerAudit(mounted);

    const copy = mounted.host.textContent ?? '';
    expect(copy).toContain('Invoice chaser');
    expect(copy).toContain('wf-invoices');
    expect(copy).toContain('Armed');

    mounted.http.verify();
  });

  it('reloads the audit even when the read was refused', async () => {
    const mounted = await withAudit();

    mounted.view.draftOwner.set(OWNER);
    mounted.fixture.detectChanges();
    void mounted.view.read();

    const read = await awaitRequest(
      mounted,
      (url) => url.endsWith(SUPPORT_DEPLOYMENTS_PATH),
      'the customer read',
    );
    // The Worker's own sentence for an unrecordable read. The view must show THAT,
    // not a local paraphrase: `impersonation_read_only` and `impersonation_unaudited`
    // are only distinguishable from its body.
    read.flush(
      { error: 'This impersonated request could not be recorded.', code: 'impersonation_unaudited' },
      { status: 403, statusText: 'Forbidden' },
    );

    await answerAudit(mounted);

    // 403 is the shell's not-authorized fact, so the view reports it rather than
    // inventing a reason, and it shows NO customer table for a refused read.
    expect(mounted.view.viewing()).toBeNull();
    expect(mounted.view.notice()).not.toBeNull();
    expect(mounted.host.textContent ?? '').not.toContain('Invoice chaser');

    mounted.http.verify();
  });

  it('issues nothing for a value that could not be an owner id', async () => {
    const mounted = await withAudit();

    for (const value of ['', 'acme', 'org', 'user', 'org_bad id']) {
      mounted.view.draftOwner.set(value);
      mounted.fixture.detectChanges();
      expect(mounted.view.ownerUsable()).toBe(false);
      await mounted.view.read();
      mounted.fixture.detectChanges();
      await settle();
      expect(mounted.http.match(() => true).length).toBe(0);
    }

    // And the hint explains it, for everything except a field nobody has typed in.
    mounted.view.draftOwner.set('acme');
    expect(mounted.view.ownerHint()).toBe(OWNER_ID_HINT);
    mounted.view.draftOwner.set('');
    expect(mounted.view.ownerHint()).toBeNull();
    mounted.view.draftOwner.set(OWNER);
    expect(mounted.view.ownerHint()).toBeNull();
    expect(mounted.view.ownerUsable()).toBe(true);

    mounted.http.verify();
  });

  it('renders a dash for a figure the worker could not measure', async () => {
    const mounted = await withAudit();

    mounted.view.draftOwner.set(OWNER);
    void mounted.view.read();
    const read = await awaitRequest(
      mounted,
      (url) => url.endsWith(SUPPORT_DEPLOYMENTS_PATH),
      'the customer read',
    );
    read.flush(
      deploymentsBody({
        deployments: [
          {
            workflowId: 'wf-quiet',
            workflowName: 'Quiet workflow',
            updatedAt: Date.parse('2026-02-01T08:00:00.000Z'),
            cronArmed: false,
            portalSlug: null,
            // Null is NOT zero: it means there was no ledger to read.
            creditsSpent: null,
            runsThisMonth: null,
          },
        ],
      }),
    );
    await answerAudit(mounted);

    expect(mounted.view.figure(null)).toBe('-');
    expect(mounted.view.figure(0)).toBe('0');
    expect(mounted.host.textContent ?? '').toContain('Quiet workflow');

    mounted.http.verify();
  });

  it('shows the failed state with a retry that re-issues the audit read', async () => {
    const mounted = mount();
    const request = await awaitRequest(
      mounted,
      (url) => url.endsWith(IMPERSONATION_ADMIN_PATH),
      'the audit read',
    );
    request.flush({ error: 'Impersonation audit unavailable.' }, { status: 500, statusText: 'Error' });
    mounted.fixture.detectChanges();
    await settle();
    mounted.fixture.detectChanges();

    expect(stateElements(mounted.host).length).toBe(1);
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('failed');

    const retry = mounted.host.querySelector<HTMLButtonElement>(
      '[data-view-state="failed"] button',
    );
    expect(retry).not.toBeNull();
    retry?.click();
    await answerAudit(mounted);
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('loaded');

    mounted.http.verify();
  });
});

describe('Impersonation wiring', () => {
  it('is in the nav and has a lazy route', () => {
    const entry = VIEW_NAV.find((item) => item.route === IMPERSONATION_VIEW_ID);
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Impersonation');
    // Tabler only. A `pi pi-` class renders an empty box with no error anywhere.
    expect(entry?.icon.startsWith('ti-')).toBe(true);

    // LAST in the nav: it is the surface an operator should reach for least often.
    expect(VIEW_NAV[VIEW_NAV.length - 1]?.route).toBe(IMPERSONATION_VIEW_ID);

    const route = routes.find((candidate) => candidate.path === IMPERSONATION_VIEW_ID);
    expect(route).toBeDefined();
    // Lazy, so a visitor who never opens it pays for none of it.
    expect(typeof route?.loadComponent).toBe('function');
    expect(route?.component).toBeUndefined();
  });
});
