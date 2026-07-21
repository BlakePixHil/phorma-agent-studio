import { Injectable, inject, signal } from '@angular/core';

import type { ModelRequest } from '@phorma/engine';

import { ModelTransportService } from './model-transport.service';
import { WorkflowBuilderService } from './workflow-builder.service';
import { WorkflowService } from './workflow.service';
import { summarizeGraph } from './workflow-builder-prompt';
import { findNodeForConnector, isAgentNode, type WorkflowNode } from './workflow.model';

/**
 * Inline AI field generation (EPIC 5): one-shot generation of an agent's
 * markdown system prompt from the node's context (name, connections, and
 * the surrounding workflow). Works without a subscription — routing follows
 * the same rule as Ask/Plan (subscribers use Phorma Cloud's builder model,
 * everyone else their default model).
 */
@Injectable({ providedIn: 'root' })
export class FieldGenerationService {
  private readonly transport = inject(ModelTransportService);
  private readonly builder = inject(WorkflowBuilderService);
  private readonly workflow = inject(WorkflowService);

  /** Node id currently being generated for (drives per-field spinners). */
  readonly generatingFor = signal<string | null>(null);

  /**
   * Generates (or improves) an agent node's markdown system prompt.
   * Returns the generated prompt, or null on cancellation/empty output.
   */
  async generateAgentPrompt(node: WorkflowNode): Promise<string | null> {
    if (!isAgentNode(node) || this.generatingFor()) return null;
    this.generatingFor.set(node.id);
    try {
      const model = this.builder.resolveModel();
      const graph = this.workflow.graph();

      const tools = graph.connections
        .filter(conn => conn.kind === 'tool-link')
        .map(conn => ({
          source: findNodeForConnector(graph, conn.outputId),
          target: findNodeForConnector(graph, conn.inputId),
        }))
        .filter(pair => pair.source?.node.id === node.id || pair.target?.node.id === node.id)
        .map(pair =>
          pair.source?.node.id === node.id ? pair.target?.node.name : pair.source?.node.name,
        )
        .filter((name): name is string => !!name);

      const current = node.data.prompt?.trim();
      const request: ModelRequest = {
        provider: model.provider,
        model: model.model,
        system: `You write markdown system prompts for AI agents in a workflow tool. Respond with ONLY the prompt markdown — no fences, no commentary. The prompt must include {{input}} where the incoming task text is interpolated, define a clear role and task, and stay under 250 words.

## The workflow this agent belongs to

${summarizeGraph(graph)}`,
        messages: [
          {
            role: 'user',
            content: [
              `Write the system prompt for the agent named "${node.name}".`,
              tools.length > 0 ? `It can call these tools: ${tools.join(', ')}.` : '',
              current
                ? `Improve on its current prompt (keep the intent, raise the quality):\n\n${current}`
                : 'It has no prompt yet — write one from its name and position in the workflow.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
        temperature: 0.5,
        maxTokens: 1024,
      };

      let text = '';
      for await (const chunk of this.transport.create().stream(request)) {
        if (chunk.type === 'text') text += chunk.text;
      }
      const prompt = stripFences(text.trim());
      return prompt || null;
    } finally {
      this.generatingFor.set(null);
    }
  }
}

/** Strips accidental markdown fences from the model's output. */
function stripFences(text: string): string {
  const fenced = /^```(?:markdown|md)?\s*([\s\S]*?)```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
}
