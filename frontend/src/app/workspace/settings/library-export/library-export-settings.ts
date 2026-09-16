import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { ToggleSwitchModule } from 'primeng/toggleswitch';

import { LibraryExportService } from '../../../core/library-export.service';
import { SettingsService } from '../../../core/settings.service';
import { TauriService } from '../../../core/tauri.service';
import { WorkflowService } from '../../../core/workflow.service';

/**
 * "Library export" - the durability path that needs no subscription
 * (Requirement 21).
 *
 * "Bring your own everything" is a product rule. A user on their own Cloudflare
 * or AWS account, or on no plan at all, is exposed to the same reinstall that
 * started this feature, and answering that with "subscribe" would be selling back
 * durability we already owe them. So this writes every spec plus a
 * `deployments.json` manifest to a folder they choose, on hardware they control.
 *
 * Shown to EVERY user, not only BYO ones: a subscriber with cloud backup on still
 * benefits from a copy that does not depend on us being reachable.
 */
@Component({
  selector: 'app-library-export-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, ToggleSwitchModule],
  templateUrl: './library-export-settings.html',
  styleUrl: './library-export-settings.scss',
})
export class LibraryExportSettings {
  /**
   * Per-instance id scope, minted from a static counter.
   *
   * The same rule the settings dialog's own AWS fields follow: two instances of a
   * settings body can be in the DOM at once, and a static `id` would then appear
   * twice and break every `<label for>` association in both of them. Verified by
   * `settings-dialog.aws.spec.ts`, which mounts two dialogs and asserts that no id
   * in the document repeats.
   */
  private static instances = 0;
  private readonly scope = `library-export-${(LibraryExportSettings.instances += 1)}`;

  protected readonly settings = inject(SettingsService);
  private readonly exporter = inject(LibraryExportService);
  private readonly workflow = inject(WorkflowService);
  protected readonly tauri = inject(TauriService);

  /** True while an export is running, for the button spinner. */
  protected readonly exporting = signal(false);

  /** How many workflows an export would write. */
  protected readonly count = computed(() => this.workflow.library().length);

  /** Where the last export went, for the confirmation line. */
  protected readonly lastDestination = signal<string | null>(null);

  protected readonly folder = this.settings.libraryExportFolder;

  /** Scoped element id, e.g. `library-export-1-on-save`. */
  protected id(suffix: string): string {
    return `${this.scope}-${suffix}`;
  }

  protected async pickFolder(): Promise<void> {
    await this.exporter.pickFolder();
  }

  protected clearFolder(): void {
    // Also turns rewrite-on-save off - a toggle reading as on while writing
    // nowhere is the exact shape of a durability feature that is not there.
    this.settings.setLibraryExportFolder('');
  }

  protected onRewriteChange(next: boolean): void {
    this.settings.libraryExportOnSave.set(next === true);
  }

  protected async exportNow(): Promise<void> {
    this.exporting.set(true);
    try {
      const result = await this.exporter.exportNow();
      if (result.ok) this.lastDestination.set(result.destination);
    } finally {
      this.exporting.set(false);
    }
  }
}
