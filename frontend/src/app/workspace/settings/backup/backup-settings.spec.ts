/**
 * Layout guards for "Cloud backup".
 *
 * The trap they exist for: the switch sits in a flex row beside a two-line
 * description. Flex shrink is weighted by flex-basis, and the paragraph's basis
 * is an order of magnitude wider than the track's, so without `flex: 0 0 auto`
 * the track absorbs a small share of a large overflow and collapses into a circle
 * that overlaps its own label. It shipped that way.
 *
 * `flex-shrink` is read off the browser's cascade rather than measured in pixels.
 * PrimeNG's dimensions come from the theme, and the theme is injected at runtime
 * by `providePrimeNG` - a TestBed that supplied it would leave its stylesheet in
 * the head for every later spec in the shared karma browser, so an unthemed
 * control is the right trade here. The cascade read still proves the selector
 * survives view encapsulation, which asserting on a class name would not.
 */

import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { BackupSettings } from './backup-settings';
import { WorkflowBackupService } from '../../../core/cloud/workflow-backup.service';
import { PhormaCloudService } from '../../../core/phorma-cloud.service';
import { WorkflowService } from '../../../core/workflow.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { VersionHistoryDialogService } from '../../workflows/version-history-dialog.service';

/**
 * The width of the Settings dialog's content pane: an 880px card less the 190px
 * nav, its padding and the scrollbar gutter. The squeeze only happens once the
 * row has to shrink, so a fixture left at the karma window's full width would
 * pass on the bug.
 */
const CONTENT_PANE_WIDTH = 620;

describe('BackupSettings layout', () => {
  let fixture: ComponentFixture<BackupSettings>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        {
          provide: WorkflowBackupService,
          useValue: {
            available: signal(true),
            active: signal(true),
            disabled: signal(false),
            writable: signal(true),
            uploading: signal(false),
            loading: signal(false),
            loaded: signal(true),
            error: signal<string | null>(null),
            backups: signal([]),
            tombstones: signal([]),
            conflicts: signal<ReadonlySet<string>>(new Set()),
            cap: signal(25),
            revisionsKept: signal(5),
            readOnlyDaysRemaining: signal<number | null>(null),
            hasAnyBackup: signal(false),
            refresh: () => Promise.resolve(),
            enable: () => undefined,
            uploadAll: () => Promise.resolve(),
            deleteBackup: () => Promise.resolve(),
            disableAndDeleteAll: () => Promise.resolve(),
          },
        },
        {
          provide: PhormaCloudService,
          useValue: { signedIn: signal(true), subscribed: signal(true), pastDue: signal(false) },
        },
        { provide: WorkflowService, useValue: { library: signal([]) } },
        { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
        {
          provide: ToastService,
          useValue: { success: () => undefined, error: () => undefined, warning: () => undefined },
        },
        { provide: VersionHistoryDialogService, useValue: { open: () => undefined } },
      ],
    });
    fixture = TestBed.createComponent(BackupSettings);
    (fixture.nativeElement as HTMLElement).style.width = `${CONTENT_PANE_WIDTH}px`;
    fixture.detectChanges();
    expand();
  });

  /** Opens the disclosure the way a click on its summary does. */
  function expand(): void {
    const details = (fixture.nativeElement as HTMLElement).querySelector('details');
    if (!details) throw new Error('No disclosure in the Cloud backup section.');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
  }

  function host(): HTMLElement {
    const element = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.settings-section__switch-row p-toggleswitch',
    );
    if (!element) throw new Error('No switch in the Cloud backup section.');
    return element;
  }

  it('refuses to shrink the switch when the description beside it wraps', () => {
    expect(getComputedStyle(host()).flexShrink)
      .withContext('flex-shrink on the switch')
      .toBe('0');
  });

  it('keeps the switch clear of the description beside it', () => {
    const description = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.settings-section__switch-row .settings-section__meta',
    )!;
    const switchRect = host().getBoundingClientRect();
    const textRect = description.getBoundingClientRect();

    expect(Math.round(switchRect.left)).toBeGreaterThanOrEqual(Math.round(textRect.right));
  });

  it('keeps the switch inside the section', () => {
    const switchRect = host().getBoundingClientRect();
    const hostRect = (fixture.nativeElement as HTMLElement).getBoundingClientRect();

    expect(Math.round(switchRect.right)).toBeLessThanOrEqual(Math.round(hostRect.right) + 1);
  });
});
