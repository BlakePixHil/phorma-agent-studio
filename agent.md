# Phorma Agent Studio — Product Overview & Project Vision

Welcome! This document is the source of truth for what Phorma Agent Studio is, who it serves, and the vocabulary and architecture every contributor (human or AI) must share. Read this before writing any code.

> **AI agents:** after reading this file, also read [.github/agent-memory.md](.github/agent-memory.md) — the global repo memory. It holds accumulated learnings, gotchas, and verified practices from previous work on this codebase. If you finish a feature and learned something a future agent should know, append it there.

---

## The Vision

Phorma Agent Studio is a premium, desktop-grade canvas where teams **design, debug, and deploy multi-agent AI workflows — and watch them run live**.

AI agents are becoming the workhorses of modern operations, but today they are built in code-first SDKs, configured in YAML, and observed through log files. Agent Studio flips that: agents are physical **Nodes** on an infinite canvas, handoffs between them are **Edges** that light up as work flows through, and the whole run can be paused, stepped, and inspected like an IDE debugger. Build and debug locally (including free local models via Ollama), then deploy the identical workflow to the cloud with one click.

## What This Product Is (and What It Isn't)

* **What it IS:** An agent orchestration platform with a live, visual execution surface. Users compose agents (model + prompt + tools), wire them together with handoffs, attach triggers (manual, schedule, webhook) and human approval gates, then run the workflow and watch it execute in real time — nodes glow while thinking, edges pulse on handoffs, tokens stream into the console.
* **What it IS NOT:**
  * Not a code-first SDK (LangGraph, CrewAI, AutoGen). No Python, no YAML — operators compose visually.
  * Not an integration automator with AI bolted on (n8n, Zapier, Make). Agents, prompts, handoffs, and approvals are the *first-class* primitives, not just another step type.
  * Not a hosted walled garden. Workflows are portable JSON; cloud deployment targets the **user's own** Cloudflare account; model access is bring-your-own-key.
  * Not a datacentre product. There is no Phorma server fleet — local runs happen in-app, cloud runs happen in serverless Durable Objects.

## Why It Wins

1. **Execution theatre** — the canvas *is* the monitor. Live node states, pulsing handoff edges, streaming output. No other tool makes agent behaviour this legible to non-engineers.
2. **Debugger discipline** — pause, resume, step, breakpoints, and full run traces. Treats agent workflows with the same rigour an IDE treats code.
3. **Local-to-cloud parity** — ONE TypeScript engine executes workflows both in-app (local debug) and inside a Cloudflare Durable Object (deployed). Same `RunEvent` stream, same visualization, zero behavioural drift.

## Target Audience

1. **Ops teams & non-technical product owners** (primary): people who know *what* the process should be — triage, research, review, escalation — and need to make agents do it without writing code.
2. **Automation engineers** (secondary): who want a visual source of truth for agent systems, a real debugger, and an escape hatch (portable JSON specs, MCP extensibility) instead of a black box.

## Core Domain Vocabulary

* **The Canvas:** the infinite, zoomable, draggable grid workspace where workflows are composed and watched.
* **Workflow:** the saved document — a graph of agents, tools, and triggers, serialized as a portable JSON spec (`.phorma.json`).
* **Agent (Node):** an LLM-backed worker — a model + a **markdown system prompt** + attached tools + handoff targets. All prompts in Phorma are markdown.
* **Handoff (Edge):** a control-flow edge. When an agent finishes (or decides), it hands the task/conversation to the next agent. Handoffs animate during runs.
* **Tool Link (Edge):** a capability edge (rendered dashed) from an agent's tools port to a Tool node — HTTP request, web search, or an **MCP server**. Tool links are *not* sequential flow; they declare what an agent may call.
* **Trigger (Node):** a workflow entry point — Manual (Run button), Schedule (cron), or Webhook.
* **Flow nodes:** Router (branching), Parallel (fan-out/fan-in), Aggregator (merge), **Approval Gate** (human-in-the-loop pause).
* **Run:** one execution of a workflow. **Trace:** its ordered log of `RunEvent`s (node-started, node-token, handoff, tool-call, approval-required, ...).
* **Port:** a connection point on a node — message-in/message-out for handoffs, a tools port for tool links.

## Architecture Map

| Layer | Location | Role |
|---|---|---|
| **Frontend shell** | `frontend/` | Angular 20 + PrimeNG + Tailwind v4. Window chrome, toolbars, side panels, bottom console, toasts, theming, undo/redo, clipboard — inherited from Phorma Code. |
| **Canvas engine** | `frontend/src/app/workspace/canvas/` | Custom Canvas2D renderer: nodes, bezier edges, grid, minimap, selection, execution glow/pulse states. |
| **Run engine** | `engine/` | Pure TypeScript, zero Angular/Tauri deps. Interprets a workflow spec, calls models through a `ModelClient` transport, emits a `RunEvent` stream. Runs in the app (local) **and** in the cloud worker (deployed). |
| **Desktop backend** | `backend/src-tauri/` | Rust + Tauri v2. Window management, streaming LLM proxy (keys never enter the webview), OS-keychain secret storage, process spawning (MCP stdio servers, wrangler deploys), file dialogs. |
| **Cloud runtime** | `cloud/` | Cloudflare Worker using the Agents SDK. A `WorkflowAgent` Durable Object hosts the same engine, exposes WebSocket monitoring + HTTP/cron triggers. |

**Model providers (v1, bring-your-own-key):** Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama (local, zero-cost debugging).

**Extensibility:** MCP (Model Context Protocol) is the primary extension surface — any MCP server becomes a draggable Tool node. Node kinds are registry-driven (data + strategy), so new node types don't require canvas changes.

## Product Conventions

* Desktop-first, web-compatible: the app must run in a plain browser (`ng serve`) with no Tauri present — guard native calls behind `TauriService.isDesktop`.
* Native feel: browser context menus and ctrl+wheel zoom stay disabled; the canvas owns those gestures.
* Icons: **Tabler icons only** (`ti ti-*`). PrimeIcons is removed.
* Prompts: **markdown everywhere** — edited as markdown, rendered sanitized.
* No Monaco / no code editors: this is not a coding tool. If syntax highlighting is ever needed (e.g. JSON payloads in traces), use a lightweight highlighter.
