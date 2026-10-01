import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';

import { WorkflowService } from '../../../core/workflow.service';
import type {
  DocumentLayout,
  HttpRequestNodeData,
  NotifyNodeData,
  RenderDocumentNodeData,
  StateListNodeData,
  WorkflowNode,
} from '../../../core/workflow.model';

const NOTIFY_BODY_FORMATS: { id: 'markdown' | 'html' | 'text'; label: string }[] = [
  { id: 'markdown', label: 'Markdown (sent as HTML and text)' },
  { id: 'text', label: 'Plain text' },
  { id: 'html', label: 'HTML' },
];

const ATTACHMENT_LIMITS: { id: 'fail' | 'truncate'; label: string }[] = [
  { id: 'fail', label: 'Fail the step' },
  { id: 'truncate', label: 'Send the files that fit' },
];

const PAGE_SIZES: { id: 'a4' | 'letter'; label: string }[] = [
  { id: 'a4', label: 'A4' },
  { id: 'letter', label: 'US Letter' },
];

/**
 * Document delivery configuration: the Render Document and State List
 * editors, the email extras of a Notify step (sender, copies, body format,
 * attachments, idempotency), and the part list of an HTTP Request whose body
 * mode is multipart. A separate, deferred component so its template stays out
 * of the initial bundle, exactly like `DecisionConfig`.
 *
 * Writes go straight through `WorkflowService`, like the host form.
 */
@Component({
  selector: 'app-delivery-config',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, InputNumberModule, InputTextModule, SelectModule, TextareaModule],
  templateUrl: './delivery-config.html',
  styleUrl: './delivery-config.scss',
})
export class DeliveryConfig {
  private readonly workflow = inject(WorkflowService);

  /** The selected node (render-document, state-list, notify, or a multipart http-request). */
  readonly node = input.required<WorkflowNode>();
  /** Id prefix from the host form, so panel and dialog ids never collide. */
  readonly scope = input<string>('panel');

  protected readonly notifyBodyFormats = NOTIFY_BODY_FORMATS;
  protected readonly attachmentLimits = ATTACHMENT_LIMITS;
  protected readonly pageSizes = PAGE_SIZES;

  protected readonly document = computed<RenderDocumentNodeData | null>(() => {
    const node = this.node();
    return node.kind === 'render-document' ? (node.data as RenderDocumentNodeData) : null;
  });
  protected readonly stateList = computed<StateListNodeData | null>(() => {
    const node = this.node();
    return node.kind === 'state-list' ? (node.data as StateListNodeData) : null;
  });
  protected readonly email = computed<NotifyNodeData | null>(() => {
    const node = this.node();
    const data = node.data as NotifyNodeData;
    return node.kind === 'notify' ? data : null;
  });
  protected readonly multipart = computed<HttpRequestNodeData | null>(() => {
    const node = this.node();
    const data = node.data as HttpRequestNodeData;
    return node.kind === 'http-request' && data.bodyMode === 'multipart' ? data : null;
  });

  protected id(suffix: string): string {
    return `${this.scope()}-dlv-${suffix}`;
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  }

  protected patch(patch: Record<string, unknown>): void {
    this.workflow.updateNodeData(this.node().id, patch);
  }

  /** A text field where empty means "unset". */
  protected patchOptional(key: string, event: Event): void {
    const text = this.value(event);
    this.patch({ [key]: text.trim().length > 0 ? text : undefined });
  }

  protected numberOrUndefined(value: number | null): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  /** Merges a partial layout into the step's `layout`, dropping cleared fields. */
  protected patchLayout(patch: Partial<DocumentLayout>): void {
    const next: Record<string, unknown> = { ...(this.document()?.layout ?? {}), ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined || next[key] === null || next[key] === '') delete next[key];
    }
    this.patch({ layout: Object.keys(next).length > 0 ? next : undefined });
  }

  /** Comma-separated attachment paths to the stored list. */
  protected onAttachmentsInput(event: Event): void {
    const paths = this.value(event)
      .split(',')
      .map(path => path.trim())
      .filter(path => path.length > 0);
    this.patch({ attachments: paths.length > 0 ? paths : undefined });
  }

  /** `name = value` lines for a multipart part list. */
  protected multipartLines(
    parts: readonly { name: string; value?: string; artifact?: string }[] | undefined,
    field: 'value' | 'artifact',
  ): string {
    return (parts ?? []).map(part => `${part.name} = ${part[field] ?? ''}`).join('\n');
  }

  /** Parses `name = value` lines back into a multipart part list. */
  protected onMultipartInput(which: 'fields' | 'files', event: Event): void {
    const parts = this.value(event)
      .split('\n')
      .map(line => {
        const at = line.indexOf('=');
        return at < 0
          ? { name: line.trim(), rest: '' }
          : { name: line.slice(0, at).trim(), rest: line.slice(at + 1).trim() };
      })
      .filter(part => part.name.length > 0);
    const current = this.multipart()?.multipart ?? {};
    const next =
      which === 'fields'
        ? { ...current, fields: parts.map(part => ({ name: part.name, value: part.rest })) }
        : { ...current, files: parts.map(part => ({ name: part.name, artifact: part.rest })) };
    this.patch({ multipart: next });
  }
}
