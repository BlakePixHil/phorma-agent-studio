import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { workerSecretName, type Connection } from '@phorma/engine';

import { ConnectionEditorDialog } from './connection-editor-dialog';
import { CloudService } from '../../../core/cloud.service';
import { ConnectionsService } from '../../../core/connections.service';
import { SettingsService } from '../../../core/settings.service';
import { ConnectionEditorDialogService } from '../connection-editor-dialog.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';

/**
 * A connection secret needs a copy in BOTH stores: the OS keychain for local
 * runs and the deploy target's vault for deployed ones. Neither can be read
 * back, so the draft the operator is typing is the only source for both.
 *
 * The regression this pins: saving locally cleared that draft, which disabled
 * the cloud upload for the same value. A `basic` connection saved locally could
 * therefore never be deployed - the push kept reporting "2 of 2 secret values
 * missing on Cloudflare Worker" with no reachable remedy short of retyping.
 */
describe('ConnectionEditorDialog secret storage', () => {
  const CONNECTION: Connection = {
    id: 'conn-basic-1',
    name: 'Practice API',
    type: 'http',
    config: {},
    secretKeys: ['user', 'password'],
    auth: { mode: 'basic', userSecretKey: 'user', passwordSecretKey: 'password' },
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };

  let fixture: ComponentFixture<ConnectionEditorDialog>;
  let dialogService: ConnectionEditorDialogService;
  /** Secret names the fake keychain holds. */
  let keychain: Set<string>;
  /** `workerSecretName` entries the fake deploy target holds. */
  let cloudNames: string[];
  let cloudProvider: ReturnType<typeof signal<'phorma' | 'cloudflare' | null>>;
  let secretsSupported: boolean;
  let putConnectionSecret: jasmine.Spy;
  let confirm: jasmine.Spy;

  beforeEach(() => {
    keychain = new Set<string>();
    cloudNames = [];
    cloudProvider = signal<'phorma' | 'cloudflare' | null>('cloudflare');
    secretsSupported = true;

    const connections = {
      connections: signal<Connection[]>([CONNECTION]),
      get secretsSupported() {
        return secretsSupported;
      },
      secretPresent: (_id: string, key: string) => Promise.resolve(keychain.has(key)),
      writeSecret: (_id: string, key: string, value: string) => {
        if (value.trim()) keychain.add(key);
        else keychain.delete(key);
        return Promise.resolve();
      },
      refresh: () => Promise.resolve(),
      removeSecretField: () => Promise.resolve(),
      update: (_id: string, patch: Partial<Connection>) =>
        Promise.resolve({ ...CONNECTION, ...patch }),
      referencingWorkflows: () => [],
    };

    putConnectionSecret = jasmine
      .createSpy('putConnectionSecret')
      .and.callFake((connectionId: string, secretKey: string) => {
        cloudNames = [...cloudNames, workerSecretName(connectionId, secretKey)];
        return Promise.resolve(true);
      });

    const cloud = {
      configured: () => true,
      connectionSecretNames: () => Promise.resolve([...cloudNames]),
      putConnectionSecret,
      deleteConnectionSecret: () => Promise.resolve(true),
    };

    confirm = jasmine.createSpy('confirm').and.resolveTo(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: ConnectionsService, useValue: connections },
        { provide: CloudService, useValue: cloud },
        { provide: SettingsService, useValue: { cloudProvider } },
        { provide: ConfirmDialogService, useValue: { confirm } },
        {
          provide: ToastService,
          useValue: { success: () => undefined, warning: () => undefined, error: () => undefined },
        },
      ],
    });

    dialogService = TestBed.inject(ConnectionEditorDialogService);
  });

  /**
   * Opens the editor on {@link CONNECTION}. Called per test rather than in
   * `beforeEach` because `secretsSupported` is read once at construction, so a
   * test that varies the host has to set it BEFORE the component exists.
   */
  async function render(): Promise<void> {
    fixture = TestBed.createComponent(ConnectionEditorDialog);
    dialogService.openEdit(CONNECTION);
    fixture.detectChanges();
    await settle();
  }

  /**
   * Drains the promise chain a row action starts (host write, metadata
   * refresh, then the deploy-target inventory read) and re-renders.
   */
  async function settle(): Promise<void> {
    for (let pass = 0; pass < 3; pass += 1) {
      await fixture.whenStable();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  }

  /** The `.phorma-conn-editor__secret-row` for one declared secret field. */
  function row(secretKey: string): HTMLElement {
    const root = fixture.nativeElement as HTMLElement;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.phorma-conn-editor__secret-row'));
    const found = rows.find(
      element => element.querySelector('.phorma-conn-editor__secret-label')?.textContent?.trim().startsWith(secretKey),
    );
    if (!found) throw new Error(`No secret row for "${secretKey}".`);
    return found;
  }

  function type(secretKey: string, value: string): void {
    const input = row(secretKey).querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  async function save(secretKey: string): Promise<void> {
    row(secretKey).querySelector<HTMLButtonElement>('[aria-label="Save secret"]')!.click();
    await settle();
  }

  it('stores one drafted value in the keychain AND on the deploy target', async () => {
    await render();
    type('user', 'accountant@example.com');
    await save('user');

    expect(keychain.has('user')).toBeTrue();
    expect(putConnectionSecret).toHaveBeenCalledWith(
      CONNECTION.id,
      'user',
      'accountant@example.com',
      { silent: true },
    );
    expect(cloudNames).toEqual([workerSecretName(CONNECTION.id, 'user')]);
  });

  it('reports both stores holding the value, leaving no upload step outstanding', async () => {
    await render();
    type('password', 'hunter2-hunter2');
    await save('password');

    expect(row('password').querySelector('.ti-circle-check')).toBeTruthy();
    expect(row('password').querySelector('.ti-cloud-check')).toBeTruthy();
    expect(row('password').querySelector('.phorma-conn-editor__pending')).toBeNull();
    expect(row('password').querySelector('[aria-label^="Send this value"]')).toBeNull();
  });

  it('keeps the draft usable when the deploy target rejected the value', async () => {
    await render();
    putConnectionSecret.and.resolveTo(false);

    type('user', 'accountant@example.com');
    await save('user');

    // The keychain took it, the deploy target did not: the draft is the only
    // route left to that store, so it must still be on screen and sendable.
    expect(keychain.has('user')).toBeTrue();
    const input = row('user').querySelector('input')!;
    expect(input.value).toBe('accountant@example.com');
    const upload = row('user').querySelector<HTMLButtonElement>('[aria-label^="Send this value"]')!;
    expect(upload.disabled).toBeFalse();
  });

  it('flags a secret the deploy target does not hold', async () => {
    await render();
    expect(row('user').querySelector('.phorma-conn-editor__pending')).toBeTruthy();
    expect(row('user').querySelector('.ti-cloud-check')).toBeNull();
  });

  it('asks once per dialog session before a value reaches Phorma Cloud', async () => {
    cloudProvider.set('phorma');
    await render();

    type('user', 'accountant@example.com');
    await save('user');
    type('password', 'hunter2-hunter2');
    await save('password');

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cloudNames.length).toBe(2);
  });

  it('stores locally but not in the cloud when Phorma Cloud is declined', async () => {
    cloudProvider.set('phorma');
    confirm.and.resolveTo(false);
    await render();

    type('user', 'accountant@example.com');
    await save('user');

    expect(keychain.has('user')).toBeTrue();
    expect(putConnectionSecret).not.toHaveBeenCalled();
    // Declining must not strand the value either: the draft stays, so the
    // explicit upload button can still offer it.
    expect(row('user').querySelector('input')!.value).toBe('accountant@example.com');
  });

  it('sends straight to the deploy target on a host with no local secret store', async () => {
    secretsSupported = false;
    await render();

    type('user', 'accountant@example.com');
    await save('user');

    expect(keychain.has('user')).toBeFalse();
    expect(cloudNames).toEqual([workerSecretName(CONNECTION.id, 'user')]);
  });
});
