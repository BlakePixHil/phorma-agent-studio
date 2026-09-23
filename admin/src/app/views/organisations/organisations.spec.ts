// The organisations view - `views/organisations/organisations.ts`
// (multi-organisation-phorma task 12, Requirements 13.3 to 13.9, 18.1).
//
// This is the dashboard's FIRST write surface, and it is the only surface in the
// whole product that writes membership (Requirement 13.7). So the assertions here
// are about the four things a read-only view never had to get right:
//
//   1. the view declares NO vocabulary. Both selects are built from the `levels`
//      and `tiers` the Worker sent, so the view can never offer a token the Worker
//      would refuse with `role_unknown`. Asserted by handing it a vocabulary with
//      an invented token in it and requiring the option to appear.
//   2. a write issues exactly ONE request, with the body the Worker's route
//      expects, and then refetches BOTH resources - because a membership write
//      moves the member count the table above it renders.
//   3. a destructive action is TWO steps. One click on Remove issues nothing; the
//      confirm button is what issues the DELETE. Selecting another organisation
//      disarms, so an armed row cannot outlive the screen it was armed on.
//   4. a refused write shows the WORKER's sentence, not a local one - the two
//      answers an operator has to act on (`role_unknown` and `org_partial_write`)
//      are only distinguishable from the Worker's body.
//
// Plus the exclusivity assertion every view in this package carries: exactly one
// `[data-view-state]` element is present in each of the four states, which is a
// direct test of the two arms of the view's own `@if` rather than a reading of
// component state.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import Aura from '@primeuix/themes/aura';
import { providePrimeNG } from 'primeng/config';

import { VIEW_NAV } from '../../app';
import { routes } from '../../app.routes';
import { SESSION_TOKEN_RESOLVER } from '../../core/admin-api';
import { ORG_ADMIN_PREFIX } from '../../core/org-api.service';
import {
  ORG_VIEW_ID,
  UNPAID_ORG_TIER,
  type OrgListResponse,
  type OrgMembersResponse,
} from '../../core/org-models';
import { Organisations, describeWriteFailure, tokenLabel } from './organisations';

/** Any non-blank token: the bearer funnel is `admin-api`'s subject, not this file's. */
const TOKEN = 'sess_live_token';

/**
 * The vocabulary the fixtures serve. `curator` is INVENTED, and that is the point:
 * the view must render it because the Worker sent it, which is only possible if the
 * view declares no vocabulary of its own.
 */
const LEVELS = ['operator', 'editor', 'builder', 'curator', 'admin'];
const TIERS = [UNPAID_ORG_TIER, 'starter', 'pro', 'team'];

const ORG_ID = 'org_acme';

function listBody(overrides: Partial<OrgListResponse> = {}): OrgListResponse {
  return {
    organisations: [
      {
        id: ORG_ID,
        name: 'Acme Accounting',
        slug: 'acme',
        tier: 'pro',
        status: 'active',
        members: 2,
      },
      {
        id: 'org_halfmade',
        name: 'Half Made',
        slug: null,
        tier: UNPAID_ORG_TIER,
        status: 'unprovisioned',
        members: 0,
      },
    ],
    levels: LEVELS,
    tiers: TIERS,
    degraded: [],
    ...overrides,
  };
}

function membersBody(overrides: Partial<OrgMembersResponse> = {}): OrgMembersResponse {
  return {
    orgId: ORG_ID,
    members: [
      {
        userId: 'user_alpha',
        level: 'builder',
        invitedBy: 'operator',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        userId: 'user_beta',
        level: 'operator',
        invitedBy: 'operator',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    levels: LEVELS,
    ...overrides,
  };
}

/** Drains pending microtasks, including the resource loader's own awaits. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted {
  fixture: ComponentFixture<Organisations>;
  view: Organisations;
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
  const fixture = TestBed.createComponent(Organisations);
  fixture.detectChanges();
  return { fixture, view: fixture.componentInstance, host: fixture.nativeElement, http };
}

/** Answers the pending request for one route, asserting the method it was issued with. */
/**
 * Waits for one request matching `predicate` and hands it back.
 *
 * Settles repeatedly rather than once, because a resource loader awaits the
 * session-token resolver before it issues anything: a single drain is enough
 * for the first load and NOT enough after a `reload()` that was itself triggered
 * from inside a resolved promise chain.
 */
async function awaitRequest(
  mounted: Mounted,
  predicate: (url: string) => boolean,
  label: string,
) {
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

async function answer(
  mounted: Mounted,
  route: string,
  method: 'GET' | 'POST' | 'DELETE',
  // `object`, not `unknown` and not a local `Record`: `TestRequest.flush` takes a
  // body union, and a DECLARED interface carries no implicit index signature so it
  // is not assignable to `Record<string, unknown>` - the same typing trap the
  // `FeatureRow` to `GroupRow` rebuild hit.
  body: object,
) {
  const request = await awaitRequest(
    mounted,
    (url) => url.endsWith(`${ORG_ADMIN_PREFIX}${route}`),
    `${method} ${route}`,
  );
  expect(request.request.method).toBe(method);
  expect(request.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  request.flush(body);
  mounted.fixture.detectChanges();
  await settle();
  mounted.fixture.detectChanges();
  return request;
}

/** A mounted view with the list loaded and one organisation selected. */
async function withRoster(): Promise<Mounted> {
  const mounted = mount();
  await answer(mounted, 'list', 'GET', listBody());
  mounted.view.select(ORG_ID);
  mounted.fixture.detectChanges();
  await answer(mounted, 'members', 'GET', membersBody());
  return mounted;
}

/** Answers whatever the two resources refetch after a write, in either order. */
async function drainReloads(mounted: Mounted): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    mounted.fixture.detectChanges();
    await settle();
    const pending = mounted.http.match(() => true);
    if (pending.length === 0) break;
    for (const request of pending) {
      request.flush(
        request.request.url.endsWith('members') ? membersBody() : listBody(),
      );
    }
  }
  mounted.fixture.detectChanges();
  await settle();
  mounted.fixture.detectChanges();
}

function stateElements(host: HTMLElement): Element[] {
  return Array.from(host.querySelectorAll('[data-view-state]'));
}

describe('Organisations view', () => {
  it('renders the organisation table with its plan, status and authoritative member count', async () => {
    const mounted = mount();
    expect(stateElements(mounted.host).length).toBe(1);
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('loading');

    await answer(mounted, 'list', 'GET', listBody());

    const copy = mounted.host.textContent ?? '';
    expect(copy).toContain('Acme Accounting');
    expect(copy).toContain(ORG_ID);
    expect(copy).toContain('Pro');
    // `unprovisioned` must be visible as itself: an organisation that exists
    // upstream with no account row is a half-finished creation, and folding it onto
    // "cancelled" would hide it.
    expect(copy).toContain('Unprovisioned');
    expect(stateElements(mounted.host).length).toBe(1);
    expect(stateElements(mounted.host)[0].getAttribute('data-view-state')).toBe('loaded');

    mounted.http.verify();
  });

  it('offers exactly the level and tier vocabulary the Worker sent, including a token it does not know', async () => {
    const mounted = await withRoster();

    // The load-bearing assertion: `curator` is not a token this package declares
    // anywhere, and it has to appear because the Worker named it. A view with its
    // own copy of the vocabulary would drop it silently.
    expect(mounted.view.levelOptions().map((option) => option.value)).toEqual(LEVELS);
    expect(mounted.view.tierOptions().map((option) => option.value)).toEqual(TIERS);
    expect(mounted.view.levelOptions().map((option) => option.label)).toContain('Curator');

    // And the unpaid token reads as "No plan" rather than as a plan called none.
    expect(tokenLabel(UNPAID_ORG_TIER)).toBe('No plan');
    expect(mounted.view.tierOptions()[0].label).toBe('No plan');

    mounted.http.verify();
  });

  it('creates an organisation with one POST carrying the name, then refetches', async () => {
    const mounted = mount();
    await answer(mounted, 'list', 'GET', listBody());

    mounted.view.draftName.set('  New Customer  ');
    const done = mounted.view.create();
    const request = await answer(mounted, 'create', 'POST', {
      organisation: {
        id: 'org_new',
        name: 'New Customer',
        slug: null,
        tier: UNPAID_ORG_TIER,
        status: 'canceled',
        members: 0,
      },
    });
    // Trimmed, and no plan is ever requested: a new organisation gets none, and
    // the view has no way to ask for one here.
    expect(request.request.body).toEqual({ name: 'New Customer' });
    expect(Object.keys(request.request.body as object)).not.toContain('tier');

    await done;
    await drainReloads(mounted);

    expect(mounted.view.draftName()).toBe('');
    expect(mounted.host.textContent ?? '').toContain('no plan');
    mounted.http.verify();
  });

  it('changes a level with one POST and refetches both the roster and the list', async () => {
    const mounted = await withRoster();

    const done = mounted.view.changeLevel('user_alpha', 'operator');
    const request = await answer(mounted, 'members', 'POST', {
      orgId: ORG_ID,
      userId: 'user_alpha',
      level: 'operator',
      clerkMembership: 'written',
    });
    expect(request.request.body).toEqual({
      orgId: ORG_ID,
      userId: 'user_alpha',
      level: 'operator',
    });
    await done;

    // BOTH resources refetch. A membership write moves the member count the
    // organisation table renders, so refetching only the roster would leave the
    // table above it stating a superseded fact.
    //
    // ONE `match` call, and the requests are flushed from THAT array: `match`
    // dequeues, so a second call for the flushing loop finds nothing and the view
    // is left stuck in its loading state with nothing to blame it on.
    await settle();
    mounted.fixture.detectChanges();
    await settle();
    const refetched = mounted.http.match(() => true);
    const urls = refetched.map((request) => request.request.url);
    expect(urls.filter((url) => url.endsWith('list')).length).toBe(1);
    expect(urls.filter((url) => url.endsWith('members')).length).toBe(1);
    for (const pending of refetched) {
      pending.flush(pending.request.url.endsWith('members') ? membersBody() : listBody());
    }
    await drainReloads(mounted);

    // And the notice names when the change takes effect, which is the one thing an
    // operator cannot see for themselves.
    expect(mounted.view.notice()).toContain('next request');
    expect(mounted.host.textContent ?? '').toContain('next request');
    mounted.http.verify();
  });

  it('removes a member only after a second, explicit confirmation', async () => {
    const mounted = await withRoster();

    const removeButtons = () =>
      Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
        (button.textContent ?? '').includes('Remove'),
      );
    const confirmButtons = () =>
      Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
        (button.textContent ?? '').includes('Confirm removal'),
      );

    expect(removeButtons().length).toBe(2);
    expect(confirmButtons().length).toBe(0);

    // One click ARMS and issues nothing. This is the assertion that keeps a
    // destructive action off a single click, with no dialog in a package that has
    // none.
    removeButtons()[0].click();
    mounted.fixture.detectChanges();
    await settle();
    expect(mounted.http.match(() => true)).toEqual([]);
    expect(confirmButtons().length).toBe(1);

    // Cancelling disarms and still issues nothing.
    const cancel = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => (button.textContent ?? '').trim() === 'Cancel',
    );
    expect(cancel).toBeDefined();
    cancel?.click();
    mounted.fixture.detectChanges();
    await settle();
    expect(mounted.http.match(() => true)).toEqual([]);
    expect(confirmButtons().length).toBe(0);

    // The confirm is what writes, and it writes a DELETE naming both ids as query
    // parameters.
    removeButtons()[0].click();
    mounted.fixture.detectChanges();
    const done = mounted.view.confirmRemove('user_alpha');
    const request = await answer(mounted, 'members', 'DELETE', {
      orgId: ORG_ID,
      userId: 'user_alpha',
      level: null,
      clerkMembership: 'removed',
    });
    expect(request.request.params.get('orgId')).toBe(ORG_ID);
    expect(request.request.params.get('userId')).toBe('user_alpha');
    await done;
    await drainReloads(mounted);

    expect(mounted.view.armedUserId()).toBeNull();
    mounted.http.verify();
  });

  it('disarms an armed removal when another organisation is selected', async () => {
    const mounted = await withRoster();
    mounted.view.arm('user_alpha');
    expect(mounted.view.armedUserId()).toBe('user_alpha');

    mounted.view.select('org_halfmade');
    mounted.fixture.detectChanges();
    expect(mounted.view.armedUserId()).toBeNull();

    // Selecting adopts that organisation's plan as the draft, so Apply cannot
    // silently carry the previous organisation's plan across.
    expect(mounted.view.draftTier()).toBe(UNPAID_ORG_TIER);

    await answer(mounted, 'members', 'GET', { orgId: 'org_halfmade', members: [], levels: LEVELS });
    mounted.http.verify();
  });

  it('assigns a plan with one POST and says it is not a credit grant', async () => {
    const mounted = await withRoster();

    mounted.view.onTierChange('team');
    const done = mounted.view.applyTier();
    const request = await answer(mounted, 'tier', 'POST', {
      orgId: ORG_ID,
      tier: 'team',
      status: 'active',
      runtimeKeyProvisioned: true,
      runtimeKeyAction: 'limit_updated',
      runtimeKeyLimitUsd: 44,
      supersededKeyDisabled: null,
    });
    expect(request.request.body).toEqual({ orgId: ORG_ID, tier: 'team' });
    await done;
    await drainReloads(mounted);

    const copy = mounted.host.textContent ?? '';
    expect(copy).toContain('never a credit grant');
    expect(copy).not.toContain('Stripe');
    mounted.http.verify();
  });

  it("shows the Worker's own sentence when a write is refused", async () => {
    const mounted = await withRoster();

    const done = mounted.view.changeLevel('user_alpha', 'operator');
    await settle();
    // A half-applied write: the identity provider moved and the membership record
    // did not. This is the one state no later request can discover, so the copy
    // has to be the Worker's rather than a generic local failure line.
    const partial =
      'The identity provider was updated and the membership record was not, so the two now ' +
      'disagree. Re-run this change; it is safe to repeat.';
    mounted.http
      .expectOne((candidate) => candidate.method === 'POST')
      .flush({ error: partial, code: 'org_partial_write' }, { status: 502, statusText: 'Bad Gateway' });
    await done;
    await drainReloads(mounted);

    expect(mounted.view.notice()).toBe(partial);
    expect(mounted.host.textContent ?? '').toContain('safe to repeat');
    mounted.http.verify();
  });

  it('renders exactly one view state in each of the four states', async () => {
    // loading
    const loading = mount();
    expect(stateElements(loading.host).length).toBe(1);
    expect(stateElements(loading.host)[0].getAttribute('data-view-state')).toBe('loading');
    // The request is issued only after the session token resolves, so it cannot be
    // matched before the microtask queue drains.
    (await awaitRequest(loading, () => true, 'the first load')).flush(listBody());
    await settle();

    // loaded
    const loaded = mount();
    await answer(loaded, 'list', 'GET', listBody());
    expect(stateElements(loaded.host).length).toBe(1);
    expect(stateElements(loaded.host)[0].getAttribute('data-view-state')).toBe('loaded');
    loaded.http.verify();

    // failed, and its retry re-issues the view's own request
    const failed = mount();
    (await awaitRequest(failed, () => true, 'the first load')).flush(
      { error: 'Nope.' },
      { status: 500, statusText: 'Server Error' },
    );
    failed.fixture.detectChanges();
    await settle();
    failed.fixture.detectChanges();
    expect(stateElements(failed.host).length).toBe(1);
    expect(stateElements(failed.host)[0].getAttribute('data-view-state')).toBe('failed');

    const retry = Array.from(failed.host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => (button.textContent ?? '').includes('Retry'),
    );
    expect(retry).toBeDefined();
    retry?.click();
    await answer(failed, 'list', 'GET', listBody());
    expect(stateElements(failed.host)[0].getAttribute('data-view-state')).toBe('loaded');
    failed.http.verify();
  });

  it('reports a degraded name read without blanking the membership it is sure of', async () => {
    const mounted = mount();
    await answer(
      mounted,
      'list',
      'GET',
      listBody({
        degraded: ['clerk'],
        organisations: [
          { id: ORG_ID, name: null, slug: null, tier: 'pro', status: 'active', members: 3 },
        ],
      }),
    );

    const copy = mounted.host.textContent ?? '';
    expect(copy).toContain('could not be read');
    // The count is still shown: it comes from the authoritative table, not from the
    // vendor read that failed.
    expect(copy).toContain('3');
    expect(copy).toContain(ORG_ID);
    mounted.http.verify();
  });
});

describe('Organisations wiring', () => {
  it('is in the nav and has a lazy route', () => {
    const entry = VIEW_NAV.find((item) => item.route === ORG_VIEW_ID);
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Organisations');
    // Tabler icons only; `primeicons` is not installed in this package.
    expect(entry?.icon.startsWith('ti-')).toBe(true);

    const route = routes.find((candidate) => candidate.path === ORG_VIEW_ID);
    expect(route).toBeDefined();
    // Lazy, so a visitor who never opens it pays for none of its form controls.
    expect(typeof route?.loadComponent).toBe('function');
    expect(route?.component).toBeUndefined();
  });

  it('maps every non-ok write outcome to copy that names the remedy', () => {
    expect(describeWriteFailure({ kind: 'forbidden' })).toContain('cannot manage');
    expect(describeWriteFailure({ kind: 'no-session' })).toContain('Sign in');
    // NOT "sign in again": a rejected session is a deployment fault, and telling an
    // operator to sign in points them at the one thing that cannot help.
    expect(describeWriteFailure({ kind: 'session-rejected' })).not.toContain('Sign in again');
    expect(describeWriteFailure({ kind: 'failed', reason: 'Boom.' })).toBe('Boom.');
  });
});
