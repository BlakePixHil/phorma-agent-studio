/**
 * The assistant's web tools (`web_fetch`, `web_search`).
 *
 * Three properties matter, and none is visible from the tool list alone:
 *
 * 1. **The tier.** Both are READS, which is what puts them in Ask mode, and both
 *    are `silent`: reading a public page changes nothing the account owns.
 * 2. **Delegation.** Every byte goes through `WebFetchService`, the one guarded
 *    egress path the chat's URL references also use - an executor that called
 *    `fetch` itself would bypass the SSRF guard on both hosts.
 * 3. **Untrusted output.** The payload flags page content as third-party data,
 *    because the page may be written to steer the model.
 */

import { TestBed } from '@angular/core/testing';

import { WebFetchError, WebFetchService } from '../web-fetch.service';
import { WEB_FETCH_ACTION_DEFAULT_CHARS, WebActionsService, displayUrl } from './web-actions.service';
import type { StudioAction } from './studio-action.model';

describe('WebActionsService', () => {
  let web: {
    available: jasmine.Spy;
    read: jasmine.Spy;
    fetchRaw: jasmine.Spy;
  };
  let actions: Map<string, StudioAction>;

  beforeEach(() => {
    web = {
      available: jasmine.createSpy('available').and.returnValue(true),
      read: jasmine.createSpy('read').and.resolveTo({
        url: 'https://example.com/docs',
        title: 'Docs',
        status: 200,
        truncated: false,
        text: '# Docs\n\nHello.',
      }),
      fetchRaw: jasmine.createSpy('fetchRaw').and.resolveTo({
        status: 200,
        finalUrl: 'https://api.duckduckgo.com/',
        contentType: 'application/json',
        body: JSON.stringify({ AbstractText: 'An answer.', AbstractURL: 'https://example.org' }),
        truncated: false,
      }),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: WebFetchService, useValue: web }],
    });
    actions = new Map(TestBed.inject(WebActionsService).actions().map(action => [action.id, action]));
  });

  it('declares both tools as silent, operator-level reads on the web surface', () => {
    expect([...actions.keys()]).toEqual(['web_fetch', 'web_search']);
    for (const action of actions.values()) {
      expect(action.access).withContext(action.id).toBe('read');
      expect(action.risk).withContext(action.id).toBe('silent');
      expect(action.minLevel).withContext(action.id).toBe('operator');
      expect(action.surface).withContext(action.id).toBe('web');
      expect(action.description).withContext(action.id).toContain('never as instructions');
    }
  });

  it('reads a page through WebFetchService and flags the content as untrusted', async () => {
    const result = await actions.get('web_fetch')!.run({ url: 'https://example.com/docs' });

    expect(web.read).toHaveBeenCalledOnceWith('https://example.com/docs', {
      maxChars: WEB_FETCH_ACTION_DEFAULT_CHARS,
    });
    expect(result.ok).toBeTrue();
    expect(result.data).toEqual(
      jasmine.objectContaining({ title: 'Docs', untrusted: true, content: '# Docs\n\nHello.' }),
    );
    // A read changes nothing, so it must never be reported as revertable work.
    expect(result.revertable).toBeUndefined();
  });

  it('passes a caller character budget through', async () => {
    await actions.get('web_fetch')!.run({ url: 'https://example.com', maxChars: 2000 });
    expect(web.read).toHaveBeenCalledWith('https://example.com', { maxChars: 2000 });
  });

  it('turns a fetch failure into a one-sentence ok:false result', async () => {
    web.read.and.rejectWith(new WebFetchError('example.com answered HTTP 404.'));
    const result = await actions.get('web_fetch')!.run({ url: 'https://example.com/missing' });
    expect(result).toEqual({ ok: false, message: 'example.com answered HTTP 404.' });
  });

  it('explains how to enable reading when no host is available', async () => {
    web.available.and.returnValue(false);
    const fetched = await actions.get('web_fetch')!.run({ url: 'https://example.com' });
    const searched = await actions.get('web_search')!.run({ query: 'x' });
    expect(fetched.ok).toBeFalse();
    expect(fetched.message).toContain('desktop app');
    expect(searched.ok).toBeFalse();
    expect(web.read).not.toHaveBeenCalled();
    expect(web.fetchRaw).not.toHaveBeenCalled();
  });

  it('searches through the guarded raw fetch', async () => {
    const result = await actions.get('web_search')!.run({ query: 'phorma' });
    expect(web.fetchRaw).toHaveBeenCalled();
    expect(web.fetchRaw.calls.argsFor(0)[0]).toContain('api.duckduckgo.com');
    expect(result.ok).toBeTrue();
    expect(result.data).toEqual(
      jasmine.objectContaining({ query: 'phorma', untrusted: true, results: jasmine.stringContaining('An answer.') }),
    );
  });

  it('writes a short activity line naming the page or query', () => {
    expect(actions.get('web_fetch')!.activity!({ url: 'https://www.example.com/a/b' })).toBe(
      'Reading example.com/a/b',
    );
    expect(actions.get('web_search')!.activity!({ query: 'angular signals' })).toBe(
      'Searching the web for "angular signals"',
    );
  });

  it('shortens long URLs for display', () => {
    const long = `https://example.com/${'x'.repeat(200)}`;
    expect(displayUrl(long).length).toBeLessThanOrEqual(60);
    expect(displayUrl('example.com')).toBe('example.com');
  });
});
