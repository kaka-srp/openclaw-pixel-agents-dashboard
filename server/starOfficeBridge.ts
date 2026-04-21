/**
 * Star Office UI Bridge
 *
 * Consumes DashboardEvents (the same stream the WebSocket already broadcasts)
 * and translates them into Star Office UI's 6-state model, POSTing to
 * http://<host>/set_state.
 *
 * Zero-intrusion to the existing pipeline — instantiate and feed events via
 * `handleEvent()`.  If STAR_OFFICE_URL is unset the bridge is a no-op.
 *
 * Mapping:
 *   tool Read/Edit/Write/Grep/Glob/str_replace  -> writing
 *   tool exec/bash/shell/run/command            -> executing
 *   tool web_fetch/WebSearch/memory_xxx/browser -> researching
 *   tool sessions_spawn/task/delegate           -> syncing
 *   agentStatus == 'stalled'                    -> error
 *   agent active, no tool (text reply)          -> writing
 *   agentStatus == 'waiting' / agent idle       -> idle
 */

import type { DashboardEvent } from './openclawParser.js';

export type StarState = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error';

const WRITING_TOOLS = new Set([
  'read', 'edit', 'write', 'str_replace', 'notebookedit', 'grep', 'glob',
]);
const EXECUTING_TOOLS = new Set([
  'exec', 'bash', 'shell', 'run', 'command',
]);
const RESEARCHING_TOOLS = new Set([
  'web_fetch', 'webfetch', 'websearch', 'web_search', 'browser', 'fetch',
  'memory_search', 'memory_get', 'memory', 'recall',
]);
const SYNCING_TOOLS = new Set([
  'sessions_spawn', 'task', 'agent', 'delegate',
]);

function toolNameToStarState(toolName: string): StarState {
  const t = toolName.toLowerCase();
  if (WRITING_TOOLS.has(t)) return 'writing';
  if (EXECUTING_TOOLS.has(t)) return 'executing';
  if (RESEARCHING_TOOLS.has(t)) return 'researching';
  if (SYNCING_TOOLS.has(t)) return 'syncing';
  // Unknown tools: treat as writing (safer than idle — they ARE working)
  return 'writing';
}

export interface StarOfficeBridgeOptions {
  /** Base URL of the Star Office UI backend, e.g. http://127.0.0.1:19000 */
  url: string;
  /** Optional agent filter — if set, only events from this agent id drive state */
  focusAgentId?: number;
  /** Minimum ms between two POSTs for the same state (default 1000) */
  minIntervalMs?: number;
}

interface AgentRuntime {
  activeTools: Map<string, string /* toolName */>;
  lastStatus: 'active' | 'waiting' | 'stalled' | 'idle';
  lastTask: string;
  lastChat: string;
}

export class StarOfficeBridge {
  private readonly url: string;
  private readonly focusAgentId: number | undefined;
  private readonly minIntervalMs: number;
  private readonly agents = new Map<number, AgentRuntime>();
  private lastPushedState: StarState | null = null;
  private lastPushedDetail = '';
  private lastPushAt = 0;

  constructor(opts: StarOfficeBridgeOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.focusAgentId = opts.focusAgentId;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
  }

  /** Entry point — call once per DashboardEvent. */
  handleEvent(evt: DashboardEvent): void {
    const id = typeof evt.id === 'number' ? evt.id : undefined;
    if (this.focusAgentId !== undefined && id !== undefined && id !== this.focusAgentId) {
      return;
    }
    if (id !== undefined) {
      this.ensureAgent(id);
    }

    switch (evt.type) {
      case 'agentToolStart': {
        if (id === undefined) return;
        const rt = this.agents.get(id)!;
        const toolId = String(evt.toolId ?? '');
        const toolName = String(evt.toolName ?? '');
        if (toolId) rt.activeTools.set(toolId, toolName);
        break;
      }
      case 'agentToolDone': {
        if (id === undefined) return;
        const rt = this.agents.get(id)!;
        const toolId = String(evt.toolId ?? '');
        if (toolId) rt.activeTools.delete(toolId);
        break;
      }
      case 'agentToolsClear': {
        if (id === undefined) return;
        const rt = this.agents.get(id)!;
        rt.activeTools.clear();
        break;
      }
      case 'agentStatus': {
        if (id === undefined) return;
        const rt = this.agents.get(id)!;
        rt.lastStatus = (evt.status as AgentRuntime['lastStatus']) ?? 'idle';
        break;
      }
      case 'agentTask': {
        if (id === undefined) return;
        const rt = this.agents.get(id)!;
        rt.lastTask = String(evt.task ?? '');
        break;
      }
      case 'agentChat': {
        if (id === undefined) return;
        const rt = this.agents.get(id)!;
        rt.lastChat = String(evt.message ?? '');
        break;
      }
      case 'agentSessionStart':
      case 'userMessage':
        // These imply the agent is alive; idle/active is handled via agentStatus events.
        break;
      default:
        // Ignore layout, subagent, etc.
        return;
    }

    this.maybePush();
  }

  private ensureAgent(id: number): void {
    if (!this.agents.has(id)) {
      this.agents.set(id, {
        activeTools: new Map(),
        lastStatus: 'idle',
        lastTask: '',
        lastChat: '',
      });
    }
  }

  /** Pick the state for the currently focused (or most active) agent. */
  private derivedState(): { state: StarState; detail: string } {
    const rt = this.primaryAgent();
    if (!rt) return { state: 'idle', detail: '' };

    if (rt.lastStatus === 'stalled') {
      return { state: 'error', detail: rt.lastTask || 'stalled' };
    }

    if (rt.activeTools.size > 0) {
      // Pick the most recently started tool (iteration order == insertion order)
      const tools = [...rt.activeTools.values()];
      const latest = tools[tools.length - 1] || '';
      return { state: toolNameToStarState(latest), detail: latest };
    }

    if (rt.lastStatus === 'active') {
      // No tool but active ⇒ agent is composing a text reply.
      return { state: 'writing', detail: rt.lastTask || rt.lastChat.slice(0, 60) };
    }

    // waiting / idle -> idle
    return { state: 'idle', detail: '' };
  }

  private primaryAgent(): AgentRuntime | null {
    if (this.focusAgentId !== undefined) {
      return this.agents.get(this.focusAgentId) ?? null;
    }
    // Prefer the agent with active tools, else first active status, else any.
    let fallback: AgentRuntime | null = null;
    for (const rt of this.agents.values()) {
      if (rt.activeTools.size > 0) return rt;
      if (rt.lastStatus === 'active') fallback = fallback ?? rt;
      else if (!fallback) fallback = rt;
    }
    return fallback;
  }

  private maybePush(): void {
    const { state, detail } = this.derivedState();
    const now = Date.now();
    if (state === this.lastPushedState && detail === this.lastPushedDetail) return;
    if (now - this.lastPushAt < this.minIntervalMs && state !== 'error') {
      // Throttle unless we're surfacing an error.
      setTimeout(() => this.maybePush(), this.minIntervalMs - (now - this.lastPushAt));
      return;
    }
    void this.push(state, detail);
  }

  private async push(state: StarState, detail: string): Promise<void> {
    this.lastPushedState = state;
    this.lastPushedDetail = detail;
    this.lastPushAt = Date.now();
    const body = JSON.stringify({ state, detail });
    try {
      const res = await fetch(`${this.url}/set_state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        console.error(`[StarBridge] POST /set_state ${res.status} ${await res.text().catch(() => '')}`);
        return;
      }
      console.log(`[StarBridge] -> ${state}${detail ? ` (${detail})` : ''}`);
    } catch (err) {
      console.error('[StarBridge] push failed:', err instanceof Error ? err.message : err);
    }
  }
}
