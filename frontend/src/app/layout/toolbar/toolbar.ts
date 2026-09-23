import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MenubarModule } from 'primeng/menubar';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
import { TooltipModule } from 'primeng/tooltip';
import type { MenuItem } from 'primeng/api';
import { ClerkService, ClerkUserButtonComponent } from 'ngx-clerk';
import { ThemeService, type ThemeMode } from '../../core/theme.service';
import { THEME_MODES } from '../../core/theme-modes';
import { CanvasStateService } from '../../core/canvas-state.service';
import { PanelRegistryService, type PanelTab } from '../../core/panel-registry.service';
import { PanelExpandService, isExpandablePanelId } from '../../core/panel-expand.service';
import { PortalService } from '../../core/portal.service';
import { WorkflowService } from '../../core/workflow.service';
import { TauriService } from '../../core/tauri.service';
import { TerminalOutputService } from '../../core/terminal-output.service';
import { HistoryService } from '../../core/history.service';
import { ClipboardService } from '../../core/clipboard.service';
import { SelectionService } from '../../core/selection.service';
import { RunControllerService } from '../../core/run-controller.service';
import { CloudService } from '../../core/cloud.service';
import { WorkflowVersionsService } from '../../core/workflow-versions.service';
import { SettingsService } from '../../core/settings.service';
import { CloudDialogService } from '../../workspace/cloud/cloud-dialog.service';
import { PhormaCloudService } from '../../core/phorma-cloud.service';
import { SettingsDialogService } from '../../workspace/settings/settings-dialog.service';
import { CommandPaletteService } from '../../core/command-palette.service';
import { OwnerSwitchService } from '../../core/owner-switch.service';
import { UpdateService } from '../../core/update.service';
import { ToastService } from '../../shared/toast/toast.service';
import { VersionHistoryDialogService } from '../../workspace/workflows/version-history-dialog.service';
import { NotificationBell } from './notification-bell/notification-bell';

/**
 * Sleek top application toolbar.
 *
 * Hosts the primary application menus (File, Edit, Selection, Arrange, View)
 * on the left, the run controls in the centre (wired to the engine in
 * Phase 3), and window/theme controls on the right.
 */
@Component({
  selector: 'app-toolbar',
  imports: [
    MenubarModule,
    ButtonModule,
    MenuModule,
    TooltipModule,
    ClerkUserButtonComponent,
    NotificationBell,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.html',
  styleUrl: './toolbar.scss',
  host: {
    '(document:keydown)': 'onKeyDown($event)',
  },
})
export class Toolbar {
  protected readonly theme = inject(ThemeService);
  protected readonly workflow = inject(WorkflowService);
  protected readonly canvasState = inject(CanvasStateService);
  protected readonly terminal = inject(TerminalOutputService);
  protected readonly runController = inject(RunControllerService);
  protected readonly cloud = inject(CloudService);
  protected readonly versions = inject(WorkflowVersionsService);
  protected readonly portal = inject(PortalService);
  protected readonly clerk = inject(ClerkService);
  // Sign-in goes through here, not through `clerk` directly: the redirect targets
  // have to be pinned per call. See `openSignIn` below. Also the source of the
  // Clerk-or-device-token `signedIn` union that every gate here reads.
  protected readonly phormaCloud = inject(PhormaCloudService);
  private readonly cloudDialog = inject(CloudDialogService);
  private readonly settingsDialog = inject(SettingsDialogService);
  private readonly commandPalette = inject(CommandPaletteService);
  private readonly settings = inject(SettingsService);
  protected readonly updates = inject(UpdateService);
  private readonly tauri = inject(TauriService);
  private readonly panels = inject(PanelRegistryService);
  private readonly panelExpand = inject(PanelExpandService);
  private readonly history = inject(HistoryService);
  private readonly clipboard = inject(ClipboardService);
  private readonly selection = inject(SelectionService);
  private readonly toast = inject(ToastService);
  private readonly versionHistory = inject(VersionHistoryDialogService);
  /**
   * The owner switcher (multi-organisation-phorma, Requirement 20).
   *
   * Injected by a COMPONENT, which is the only thing allowed to inject it: it
   * reaches the confirm rail, the document tabs, three notification services and
   * `/api/me`, so it sits well above the transport path. The bare signal lives in
   * `ActiveOwnerService`, which is a DI leaf.
   */
  protected readonly ownerSwitch = inject(OwnerSwitchService);

  /**
   * Current Clerk user (null until Clerk loads / when signed out, and ALWAYS null
   * on desktop). Read only by the `<clerk-user-button>` branch below, which needs
   * a real Clerk user to render anything; use {@link isSignedIn} for every gate.
   */
  protected readonly clerkUser = toSignal(this.clerk.user$, { initialValue: null });
  /**
   * True when this install has an account, by EITHER route.
   *
   * Delegates to `PhormaCloudService.signedIn`, which is the Clerk-or-device-token
   * union. This USED to be `clerkUser() != null`, and that was a shipped bug: a
   * desktop install signs in through the browser handoff and Clerk never loads a
   * user, so the toolbar kept offering "Sign in", the overflow menu kept offering
   * "Sign-in", and `openCloud()` bounced every click to Settings - all while the
   * account was live and the success toast had already named the user's email.
   */
  protected readonly isSignedIn = this.phormaCloud.signedIn;

  /** True when running inside the Tauri desktop runtime. */
  protected readonly isDesktop = this.tauri.isDesktop;

  /**
   * Tooltip for the device-token account button. Names the address when the
   * handoff supplied one - a brand new account has no tenant row and therefore no
   * server-side email, so null is legitimate and must not read as signed out.
   */
  protected readonly accountTooltip = computed(() => {
    const email = this.phormaCloud.email();
    return email ? `Signed in as ${email}` : 'Your Phorma account';
  });

  /**
   * The account's profile picture, or null to fall back to {@link accountInitial}.
   *
   * A device-token install has no Clerk session, so this does NOT come from a
   * Clerk user object - it rides the sign-in handoff alongside the email, from
   * `window.Clerk.user.imageUrl` on the worker's own sign-in page, which is how a
   * Google (or any other provider) photo reaches a desktop install at all.
   *
   * Null is the ordinary case for an account with no photo, so the initial is
   * still the substitute and not an error state.
   */
  protected readonly accountAvatar = computed(() => {
    // A load failure is sticky for the session: retrying a broken URL on every
    // change detection pass would be a request loop behind a 28px circle.
    if (this.avatarFailed()) return null;
    return this.phormaCloud.avatarUrl();
  });

  /** Set when the avatar `<img>` reports an error. See {@link accountAvatar}. */
  private readonly avatarFailed = signal(false);

  /** The `<img>` could not load the avatar - fall back to the initial. */
  protected onAvatarError(): void {
    this.avatarFailed.set(true);
  }

  /**
   * One initial for the avatar, used whenever there is no picture to show.
   *
   * Falls back to a person glyph's stead ('P' for Phorma) when the handoff
   * supplied no email either.
   */
  protected readonly accountInitial = computed(() => {
    const email = this.phormaCloud.email();
    const first = email?.trim()?.[0];
    return first ? first.toUpperCase() : 'P';
  });

  /**
   * The device-token account menu.
   *
   * This exists because dropping `<clerk-user-button>` on desktop also dropped
   * the only Sign out control in the toolbar - a REGRESSION, since that popover
   * carried "Manage account" and "Sign out" and the replacement button carried
   * neither. The email is a disabled header rather than a tooltip alone, so the
   * account is identifiable from the keyboard and not only on hover.
   */
  protected readonly accountMenu = computed<MenuItem[]>(() => {
    const email = this.phormaCloud.email();
    return [
      ...(email ? [{ label: email, disabled: true } satisfies MenuItem] : []),
      {
        label: 'Account and plan',
        icon: 'ti ti-user-circle',
        command: () => this.settingsDialog.open('cloud'),
      },
      {
        label: 'Sign out',
        icon: 'ti ti-logout',
        command: () => void this.phormaCloud.signOut(),
      },
    ];
  });

  /**
   * The owner switcher's menu: the personal account plus every membership
   * (multi-organisation-phorma, Requirements 20.1, 20.12).
   *
   * Offers ONLY memberships that already exist. There is no "create organisation"
   * and no "join" item, and there must not be - the Super_Admin route family is
   * the only party that creates an organisation or assigns a member to one, which
   * is also why `ngx-clerk`'s own organisation switcher is deliberately not used
   * here.
   *
   * The active owner carries a check icon as well as being named on the trigger,
   * so the current scope is legible from the keyboard and not only by reading the
   * button beside it.
   */
  protected readonly ownerMenu = computed<MenuItem[]>(() =>
    this.ownerSwitch.owners().map(owner => ({
      label: owner.label,
      icon: owner.orgId === null ? 'ti ti-user' : 'ti ti-building',
      styleClass:
        owner.orgId === this.ownerSwitch.activeOwner$().orgId
          ? 'phorma-toolbar__owner-item--active'
          : undefined,
      command: () => void this.ownerSwitch.switchTo(owner.orgId),
    })),
  );

  /** Tooltip for the owner switcher, naming what a deploy would reach. */
  protected readonly ownerTooltip = computed(
    () => `Working in ${this.ownerSwitch.activeOwner$().label}. Click to switch account.`,
  );

  /** Tooltip for the toolbar Update button, reflecting the update state. */
  protected readonly updateTooltip = computed(() => {
    const version = this.updates.available()?.version;
    if (this.updates.downloading()) {
      const pct = this.updates.progress();
      return `Downloading update${pct > 0 ? ` ${Math.round(pct * 100)}%` : ''}…`;
    }
    if (this.updates.readyToRestart()) {
      return `Restart to update${version ? ` to v${version}` : ''}`;
    }
    return version ? `Update to v${version} and restart` : 'Update and restart';
  });

  /** One-click update: download (if needed), silent install, restart. */
  protected updateNow(): void {
    void this.updates.updateNow();
  }

  /**
   * Opens Clerk's modal sign-in flow through `PhormaCloudService`, NOT through
   * `ClerkService` directly. That service pins the redirect targets to this app's
   * own URL, which the desktop build cannot sign in without - see the comment on
   * `PhormaCloudService.signIn`. Calling `clerk.openSignIn()` here as well would
   * be a second, unpinned entry point into the same flow.
   */
  protected openSignIn(): void {
    this.phormaCloud.signIn();
  }

  /**
   * Opens the account surface.
   *
   * Clerk's own profile modal only works where Clerk holds a session, which is a
   * browser build. On desktop the account lives behind the device token and Clerk
   * has nothing to show, so this opens Settings > Cloud - the panel that actually
   * renders the signed-in account, its plan and its quota.
   */
  protected openAccount(): void {
    if (this.clerkUser() == null) {
      this.settingsDialog.open('cloud');
      return;
    }
    this.clerk.openUserProfile();
  }

  constructor() {
    // Sync Clerk's component theme with Phorma's light/dark mode. Clerk's
    // appearance prop accepts a `variables` map of color tokens; we map the
    // app's surface/text/border tokens onto Clerk's so the sign-in modal,
    // UserButton menu, etc. match the surrounding chrome.
    effect(() => {
      const mode = this.theme.mode();
      this.clerk.updateAppearance(this.clerkAppearanceFor(mode));
    });
  }

  /**
   * Builds a Clerk `appearance` object for the active theme mode. The colour
   * values mirror each theme's surface tokens (see `theme-modes.ts` swatches
   * and `styles.scss`) so Clerk's prebuilt components blend into the toolbar
   * and modal overlays. Light gets the clean light surfaces; every
   * dark-family theme reuses its own panel/canvas/text tokens.
   */
  private clerkAppearanceFor(mode: ThemeMode) {
    const def = THEME_MODES[mode] ?? THEME_MODES.dark;
    const { dark, swatch } = def;
    const hover = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
    const inputBg = dark ? swatch.canvas : '#f7f8fa';
    const textSecondary = dark ? 'rgba(230,230,230,0.6)' : 'rgba(26,26,26,0.6)';
    const border = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.10)';
    return {
      variables: {
        colorBackground: dark ? swatch.panel : '#ffffff',
        colorBackgroundHover: hover,
        colorInputBackground: inputBg,
        colorInputText: swatch.text,
        colorText: swatch.text,
        colorTextSecondary: textSecondary,
        colorBorder: border,
        colorPrimary: dark ? '#878fa3' : '#67708a',
        colorPrimaryForeground: '#ffffff',
        borderRadius: '0.5rem',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      },
      elements: dark
        ? {
            socialButtonsBlockButton: {
              backgroundColor: swatch.canvas,
              borderColor: border,
              color: swatch.text,
              '&:hover': {
                backgroundColor: hover,
                color: swatch.text,
              },
            },
            socialButtonsBlockButtonText: {
              color: swatch.text,
            },
            userButtonPopoverActionButton: {
              color: swatch.text,
              '&:hover': {
                color: swatch.text,
                backgroundColor: hover,
              },
            },
            userButtonPopoverActionButtonIcon: {
              color: swatch.text,
            },
          }
        : {},
    };
  }

  /** Whether a run is in flight (run controls swap to Stop). */
  protected readonly running = this.runController.running;
  protected readonly paused = this.runController.paused;
  protected readonly canReset = this.runController.canReset;

  // ── Right-cluster icon computeds (signals keep OnPush templates in sync) ─
  protected readonly gridSnapTooltip = computed(() =>
    this.canvasState.gridSnap() ? 'Disable grid snapping' : 'Enable grid snapping',
  );

  /**
   * Whether the ACTIVE workflow is deployed to a cloud runtime. Combines the
   * live status from the Cloud dialog (`deployedStatus`, authoritative when
   * the dialog has been opened for THIS workflow) with the local version-
   * snapshot flag (`deployedWorkflowIds`, always available offline). The live
   * signal is only trusted when its workflow id matches the active workflow -
   * otherwise it's a stale status from a previously-opened workflow and the
   * local set is used instead.
   */
  protected readonly cloudDeployed = computed(() => {
    const activeId = this.workflow.activeDoc()?.workflowId;
    if (!activeId) return false;
    const live = this.cloud.deployedStatusFor(activeId);
    if (live) return live.hasWorkflow;
    return this.versions.deployedWorkflowIds().has(activeId);
  });

  /** Tooltip for the cloud button, reflecting deploy + monitor state. */
  protected readonly cloudTooltip = computed(() => {
    if (this.cloud.connected()) return 'Cloud monitor connected';
    if (this.cloudDeployed()) return 'Workflow is deployed to the cloud';
    return 'Cloud deploy & monitor';
  });

  /** Whether the user is on macOS (for Cmd vs Ctrl shortcut display). */
  protected readonly isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

  /**
   * Formats a shortcut hint for display in the menubar. On macOS, `Ctrl+`
   * becomes `⌘+` (rendered with the Tabler command icon); other modifiers
   * (Shift, Alt) are preserved. Non-Ctrl shortcuts pass through unchanged.
   */
  protected shortcut(hint: string): string {
    if (!hint.startsWith('Ctrl+')) return hint;
    return this.isMac ? hint.replace(/^Ctrl\+/, '⌘+') : hint;
  }

  /** Whether the shortcut's macOS form should render the Tabler command icon. */
  protected shortcutHasCommandIcon(hint: string): boolean {
    return this.isMac && hint.startsWith('Ctrl+');
  }

  // ── Keyboard shortcut bindings ──────────────────────────────────────────

  protected onKeyDown(e: KeyboardEvent): void {
    const ctrl  = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const key   = e.key.toLowerCase();

    // ── Run controls (F5 / Shift+F5 / F6 / F10) — debugger-style. ─────────
    if (key === 'f5' && !ctrl) {
      e.preventDefault();
      if (shift) this.runController.stop();
      else if (this.paused()) this.runController.pauseOrResume();
      else if (!this.running()) this.runController.start();
      return;
    }
    if (key === 'f6' && !ctrl && !shift) {
      e.preventDefault();
      this.runController.pauseOrResume();
      return;
    }
    if (key === 'f10' && !ctrl && !shift) {
      e.preventDefault();
      this.runController.step();
      return;
    }

    // ── Save (Ctrl/Cmd+S) ───────────────────────────────────────────────────
    // Handled before the text-editing guard so it works while focused in the
    // prompt editor. Always prevent the browser's native "Save page".
    if (ctrl && !shift && key === 's') {
      e.preventDefault();
      void this.saveWorkflow();
      return;
    }
    // New workflow (Ctrl+N).
    if (ctrl && !shift && key === 'n') {
      e.preventDefault();
      this.workflow.newWorkflow();
      return;
    }
    // AI command palette (Ctrl+P / Cmd+P) — registered before the
    // text-editing guard (like Save) so it works from any focus, and always
    // preventDefault to suppress the browser's print dialog.
    if (ctrl && !shift && key === 'p') {
      e.preventDefault();
      this.commandPalette.toggle();
      return;
    }

    // ── Edit menu hotkeys ──────────────────────────────────────────────────
    // Skip when the user is typing in an input/textarea/contenteditable so
    // browser-native undo/redo and text copy/paste keep working there.
    // Also skip when the user has an active text selection inside a
    // `.selectable` region — native Ctrl+C should copy the highlighted text,
    // not canvas nodes.
    if (this.isTextEditingTarget(e.target) || this.hasSelectableTextSelection()) {
      // Text editing owns these keys; fall through to the app-level ones below.
    } else if (ctrl && !shift && key === 'z') {
      e.preventDefault();
      this.history.undo();
      return;
    } else if (ctrl && (key === 'y' || (shift && key === 'z'))) {
      e.preventDefault();
      this.history.redo();
      return;
    } else if (ctrl && !shift && key === 'x') {
      e.preventDefault();
      this.clipboard.cut();
      return;
    } else if (ctrl && !shift && key === 'c') {
      e.preventDefault();
      this.clipboard.copy();
      return;
    } else if (ctrl && !shift && key === 'v') {
      e.preventDefault();
      this.clipboard.paste();
      return;
    } else if (ctrl && !shift && key === 'a') {
      e.preventDefault();
      this.selection.selectAll();
      return;
    } else if (!ctrl && !e.metaKey && !e.altKey && key === 'escape') {
      // Any open overlay owns Escape (it closes itself). Deselecting as well
      // would silently drop the selection the overlay was editing, so the
      // reopened panel would come back empty.
      if (!this.anyOverlayOpen()) this.selection.deselect();
      return;
    }

    if (ctrl && !shift && key === '=') { e.preventDefault(); this.canvasState.zoomCommand.set('in'); }
    if (ctrl && !shift && key === '-') { e.preventDefault(); this.canvasState.zoomCommand.set('out'); }
    if (ctrl && !shift && key === '0') { e.preventDefault(); this.canvasState.zoomCommand.set('reset'); }
    if (ctrl &&  shift && key === 'f') { e.preventDefault(); this.canvasState.zoomCommand.set('fit'); }

    // Arrange > Auto-arrange nodes — Ctrl+Shift+L.
    if (ctrl && shift && key === 'l') {
      e.preventDefault();
      this.selection.arrangeNodes();
      return;
    }

    if (ctrl && !shift && key === 'b') {
      e.preventDefault();
      this.panels.collapsedLeft() ? this.panels.expandLeft() : this.panels.collapseLeft();
    }
    if (ctrl && shift && key === 'b') {
      e.preventDefault();
      this.panels.collapsedRight() ? this.panels.expandRight() : this.panels.collapseRight();
    }
    // View > Expand Active Panel — Ctrl+Shift+E.
    if (ctrl && shift && key === 'e') {
      e.preventDefault();
      this.expandActivePanel();
      return;
    }
    if (ctrl && key === '`') {
      e.preventDefault();
      this.terminal.toggle();
    }
    // Settings — Ctrl+, / Cmd+, (VS Code-style). On macOS the browser
    // sometimes intercepts Cmd+,; the menubar item is the reliable path.
    if (ctrl && !shift && key === ',') {
      e.preventDefault();
      this.settingsDialog.open();
      return;
    }
    if (ctrl && !shift && key === 'g') {
      e.preventDefault();
      this.canvasState.gridVisible.update(v => !v);
    }
    // Grid snapping toggle — Alt+G (Ctrl+G is already grid visibility).
    if (e.altKey && !ctrl && !e.metaKey && key === 'g') {
      e.preventDefault();
      this.canvasState.gridSnap.update(v => !v);
    }
  }

  protected readonly menuItems = computed<MenuItem[]>(() => [
    {
      // Brand mark: the Phorma logo renders as a plain icon (no menu).
      // The #item template swaps the label for the logo when `brand` is set.
      label: '',
      brand: true,
    },
    {
      label: 'File',
      items: [
        {
          label: 'New Workflow',
          icon: 'ti ti-plus',
          shortcut: 'Ctrl+N',
          command: () => this.workflow.newWorkflow(),
        },
        {
          label: 'Open Workflow',
          icon: 'ti ti-folder-open',
          items: this.savedWorkflowItems(),
        },
        { separator: true },
        {
          label: 'Build with AI',
          icon: 'ti ti-sparkles',
          shortcut: 'Ctrl+P',
          command: () => this.commandPalette.open(),
        },
        { separator: true },
        {
          label: 'Save',
          icon: 'ti ti-device-floppy',
          shortcut: 'Ctrl+S',
          command: () => void this.saveWorkflow(),
        },
        {
          label: 'Version History',
          icon: 'ti ti-history',
          disabled: !this.workflow.activeDoc()?.workflowId,
          command: () => {
            const workflowId = this.workflow.activeDoc()?.workflowId;
            if (workflowId) this.versionHistory.open(workflowId);
          },
        },
        { separator: true },
        {
          label: 'Preferences',
          icon: 'ti ti-adjustments',
          items: [
            {
              label: 'Settings',
              icon: 'ti ti-settings',
              shortcut: 'Ctrl+,',
              command: () => this.settingsDialog.open(),
            },
            this.isSignedIn()
              ? {
                  label: 'Account',
                  icon: 'ti ti-user-circle',
                  command: () => this.openAccount(),
                }
              : {
                  label: 'Sign-in',
                  icon: 'ti ti-login',
                  command: () => this.openSignIn(),
                },
          ],
        },
        { separator: true },
        {
          label: 'Import',
          icon: 'ti ti-file-import',
          command: () => void this.importWorkflow(),
        },
        {
          label: 'Export',
          icon: 'ti ti-file-export',
          command: () => void this.exportWorkflow(),
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: 'Undo',
          icon: 'ti ti-arrow-back-up',
          shortcut: 'Ctrl+Z',
          disabled: !this.history.canUndo(),
          command: () => this.history.undo(),
        },
        {
          label: 'Redo',
          icon: 'ti ti-arrow-forward-up',
          shortcut: 'Ctrl+Y',
          disabled: !this.history.canRedo(),
          command: () => this.history.redo(),
        },
        { separator: true },
        {
          label: 'Cut',
          icon: 'ti ti-cut',
          shortcut: 'Ctrl+X',
          command: () => this.clipboard.cut(),
        },
        {
          label: 'Copy',
          icon: 'ti ti-copy',
          shortcut: 'Ctrl+C',
          command: () => this.clipboard.copy(),
        },
        {
          label: 'Paste',
          icon: 'ti ti-clipboard',
          shortcut: 'Ctrl+V',
          disabled: !this.clipboard.hasContent(),
          command: () => this.clipboard.paste(),
        },
      ],
    },
    {
      label: 'Selection',
      items: [
        {
          label: 'Select All',
          icon: 'ti ti-select-all',
          shortcut: 'Ctrl+A',
          command: () => this.selection.selectAll(),
        },
        {
          label: 'Deselect',
          icon: 'ti ti-deselect',
          shortcut: 'Esc',
          command: () => this.selection.deselect(),
        },
      ],
    },
    {
      label: 'Arrange',
      items: [
        {
          label: 'Auto-arrange Nodes',
          icon: 'ti ti-layout-distribute-horizontal',
          shortcut: 'Ctrl+Shift+L',
          command: () => this.selection.arrangeNodes(),
        },
        { separator: true },
        {
          label: 'Fit to Screen',
          icon: 'ti ti-maximize',
          shortcut: 'Ctrl+Shift+F',
          command: () => this.canvasState.zoomCommand.set('fit'),
        },
      ],
    },
    {
      label: 'View',
      items: [
        {
          label: 'Zoom In',
          icon: 'ti ti-zoom-in',
          shortcut: 'Ctrl+=',
          command: () => this.canvasState.zoomCommand.set('in'),
        },
        {
          label: 'Zoom Out',
          icon: 'ti ti-zoom-out',
          shortcut: 'Ctrl+-',
          command: () => this.canvasState.zoomCommand.set('out'),
        },
        {
          label: 'Reset Zoom',
          icon: 'ti ti-zoom-reset',
          shortcut: 'Ctrl+0',
          command: () => this.canvasState.zoomCommand.set('reset'),
        },
        {
          label: 'Fit to Screen',
          icon: 'ti ti-maximize',
          shortcut: 'Ctrl+Shift+F',
          command: () => this.canvasState.zoomCommand.set('fit'),
        },
        { separator: true },
        {
          label: 'Toggle Grid',
          icon: 'ti ti-grid-4x4',
          shortcut: 'Ctrl+G',
          command: () => this.canvasState.gridVisible.update(v => !v),
        },
        {
          label: this.canvasState.gridSnap() ? 'Disable Grid Snapping' : 'Enable Grid Snapping',
          icon: 'ti ti-magnet',
          shortcut: 'Alt+G',
          command: () => this.toggleGridSnap(),
        },
        { separator: true },
        {
          label: this.canvasState.minimapVisible() ? 'Hide Minimap' : 'Show Minimap',
          icon: 'ti ti-map',
          command: () => this.canvasState.minimapVisible.update(v => !v),
        },
        { separator: true },
        {
          label: 'Panels',
          icon: 'ti ti-layout-sidebar',
          items: [
            {
              label: 'Toggle Left',
              icon: 'ti ti-layout-sidebar-left-collapse',
              shortcut: 'Ctrl+B',
              command: () =>
                this.panels.collapsedLeft()
                  ? this.panels.expandLeft()
                  : this.panels.collapseLeft(),
            },
            {
              label: 'Toggle Right',
              icon: 'ti ti-layout-sidebar-right-collapse',
              shortcut: 'Ctrl+Shift+B',
              command: () =>
                this.panels.collapsedRight()
                  ? this.panels.expandRight()
                  : this.panels.collapseRight(),
            },
            { separator: true },
            {
              label: 'Expand Active Panel',
              icon: 'ti ti-arrows-maximize',
              shortcut: 'Ctrl+Shift+E',
              disabled: !isExpandablePanelId(this.panels.activeRight()),
              command: () => this.expandActivePanel(),
            },
            { separator: true },
            {
              label: 'Collapse Both Panels',
              icon: 'ti ti-arrows-minimize',
              command: () => this.panels.collapseAll(),
            },
            {
              label: 'Expand Both Panels',
              icon: 'ti ti-arrows-maximize',
              command: () => this.panels.expandAll(),
            },
            { separator: true },
            {
              label: 'Reset Panel Layout',
              icon: 'ti ti-refresh',
              command: () => this.panels.resetPanels(),
            },
          ],
        },
        { separator: true },
        {
          label: this.terminal.collapsed() ? 'Show Console' : 'Hide Console',
          icon: 'ti ti-terminal-2',
          shortcut: 'Ctrl+`',
          command: () => this.terminal.toggle(),
        },
      ],
    },
    {
      label: 'Window',
      items: [
        // Every panel tab this session may open, grouped by the side it lives
        // on. Visible tabs get a checkmark; clicking toggles visibility (hiding
        // a tab removes it from its sidebar, showing reveals + activates it).
        //
        // `allowedTabs` rather than `tabs`: the sidebars subtract a tab above the
        // resolved capability level, so offering it here would be a menu entry
        // that ticks itself and changes nothing on screen.
        ...this.panels.allowedTabs()
          .filter(t => t.side === 'left')
          .sort((a, b) => a.order - b.order)
          .map(tab => this.windowTabItem(tab)),
        { separator: true },
        ...this.panels.allowedTabs()
          .filter(t => t.side === 'right')
          .sort((a, b) => a.order - b.order)
          .map(tab => this.windowTabItem(tab)),
        { separator: true },
        {
          label: 'Reset Panel Layout',
          icon: 'ti ti-refresh',
          command: () => this.panels.resetPanels(),
        },
      ],
    },
  ]);

  /**
   * Builds a Window-menu entry for one panel tab: green checkmark when
   * visible, click toggles show/hide. The last visible tab on a side can't
   * be hidden (mirrors `PanelRegistryService.canHide`).
   */
  private windowTabItem(tab: PanelTab): MenuItem {
    return {
      label: tab.label,
      icon: tab.visible ? 'ti ti-check text-green-500' : tab.icon,
      disabled: tab.visible && !this.panels.canHide(tab.id),
      command: () => {
        if (tab.visible) {
          this.panels.hideTab(tab.id);
        } else {
          this.panels.showTab(tab.id);
          this.panels.setActive(tab.side, tab.id);
          if (tab.side === 'right') this.panels.expandRight();
          else this.panels.expandLeft();
        }
      },
    };
  }

  /** Run controls — delegate to the run controller. */
  protected toggleRun(): void {
    if (this.running()) this.runController.stop();
    else this.runController.start();
  }

  protected pauseRun(): void {
    this.runController.pauseOrResume();
  }

  protected stepRun(): void {
    this.runController.step();
  }

  protected resetRun(): void {
    this.runController.reset();
  }

  /**
   * Opens the cloud deploy/monitor dialog — unless no cloud provider has
   * been chosen (or it's missing required config), in which case the user
   * is routed to Settings → Cloud to pick one first.
   *
   * No toast on that route: the settings dialog opens on the Cloud section with
   * the choice on screen, so a warning only repeats what the user can already
   * see and has to be dismissed.
   */
  protected openCloud(): void {
    const provider = this.settings.cloudProvider();
    const needsSetup =
      provider === null ||
      (provider === 'cloudflare' && !this.cloud.workerUrl()) ||
      (provider === 'phorma' && !this.isSignedIn());
    if (needsSetup) {
      this.settingsDialog.open('cloud');
      return;
    }
    this.cloudDialog.open();
  }

  /**
   * Expands the active right-side panel into its full-size dialog, or closes
   * the open one. Only Prompt / Properties / Evals / Usage have expanded
   * surfaces; anything else is a no-op (the menu item is disabled to match).
   */
  private expandActivePanel(): void {
    if (this.panelExpand.anyOpen()) {
      this.panelExpand.close();
      return;
    }
    const active = this.panels.activeRight();
    if (isExpandablePanelId(active)) this.panelExpand.open(active);
  }

  /**
   * Reveals the Portal panel. Deliberately NOT a dialog: publish state is
   * something you keep an eye on while editing, and the panel is also where
   * the checklist and access keys live.
   */
  protected openPortal(): void {
    this.panels.expandRight();
    this.panels.setActive('right', 'portal');
  }

  /** Toggles grid snapping on/off (toolbar icon button + View menu). */
  protected toggleGridSnap(): void {
    this.canvasState.gridSnap.update(v => !v);
  }

  private async saveWorkflow(): Promise<void> {
    const saved = await this.workflow.saveActive();
    if (saved) this.toast.success(`Workflow “${saved.name}” saved`);
  }

  private async exportWorkflow(): Promise<void> {
    const spec = this.workflow.exportActiveSpec();
    if (!spec) return;
    try {
      const path = await this.tauri.saveWorkflowFileDialog(spec);
      if (path) this.toast.success('Workflow exported', path);
    } catch (error) {
      this.toast.error('Export failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async importWorkflow(): Promise<void> {
    try {
      const result = await this.tauri.openWorkflowFileDialog();
      if (!result) return;
      this.workflow.importSpec(result.spec);
      this.toast.success('Workflow imported', result.spec.name);
    } catch (error) {
      this.toast.error('Import failed', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * True while any modal surface is mounted. Every dialog in the studio is an
   * `@if`-gated overlay carrying `role="dialog"`, so one DOM probe covers them
   * all - including ones added later - without this handler having to inject
   * every dialog service.
   */
  private anyOverlayOpen(): boolean {
    return !!document.querySelector('[role="dialog"]');
  }

  private isTextEditingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) return false;
    return !!element.closest('input, textarea, select, [contenteditable="true"]');
  }

  /**
   * True when the user has an active text selection inside a `.selectable`
   * region (e.g. the prompt preview). In that case Ctrl+C should perform the
   * browser's native copy of the highlighted text rather than copying canvas
   * nodes — the user explicitly selected text to copy it.
   */
  private hasSelectableTextSelection(): boolean {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }
    const anchor = selection.anchorNode;
    if (!anchor) return false;
    const element = anchor.nodeType === Node.ELEMENT_NODE
      ? (anchor as Element)
      : anchor.parentElement;
    return !!element?.closest('.selectable');
  }

  private savedWorkflowItems(): MenuItem[] {
    const specs = this.workflow.library();
    if (specs.length === 0) {
      return [{ label: 'No Saved Workflows', disabled: true }];
    }
    return specs.map(spec => ({
      label: spec.name,
      icon: 'ti ti-topology-star-3',
      command: () => this.workflow.openWorkflow(spec.id),
    }));
  }
}
