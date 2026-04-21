/**
 * AgentIntent — semantic layer mapping OpenClaw tool activity to workstation kinds.
 *
 * Flow:  agent tool event → toolNameToIntent → intentToWorkstationKind → seat pool lookup
 *
 * Rest / sleep are time-based (idle duration), not tool-based.
 */

export const AgentIntent = {
  CODING: 'coding',
  EXECUTING: 'executing',
  BROWSING: 'browsing',
  THINKING: 'thinking',
  MEMORY: 'memory',
  SPAWNING: 'spawning',
  RESTING: 'resting',
  SLEEPING: 'sleeping',
  ERROR: 'error',
} as const;
export type AgentIntent = (typeof AgentIntent)[keyof typeof AgentIntent];

export const WorkstationKind = {
  DESK: 'desk',
  SERVER_RACK: 'server_rack',
  BROWSER: 'browser',
  WHITEBOARD: 'whiteboard',
  BOOKSHELF: 'bookshelf',
  DOOR: 'door',
  SOFA: 'sofa',
  BED: 'bed',
} as const;
export type WorkstationKind = (typeof WorkstationKind)[keyof typeof WorkstationKind];

/** Time agent stays idle before wandering to the sofa. */
export const IDLE_TO_REST_SEC = 30;

/** Additional rest time before lying down on the bed. */
export const REST_TO_SLEEP_SEC = 270; // total ~5 min idle = sleeping

/** Map an OpenClaw tool name to the agent's current intent. */
export function toolNameToIntent(toolName: string): AgentIntent {
  const t = toolName.toLowerCase();
  if (t === 'read' || t === 'edit' || t === 'write' || t === 'str_replace' || t === 'notebookedit' || t === 'grep' || t === 'glob') {
    return AgentIntent.CODING;
  }
  if (t === 'exec' || t === 'bash' || t === 'shell' || t === 'run' || t === 'command') {
    return AgentIntent.EXECUTING;
  }
  if (t === 'web_fetch' || t === 'webfetch' || t === 'websearch' || t === 'browser' || t === 'fetch') {
    return AgentIntent.BROWSING;
  }
  if (t.startsWith('memory') || t === 'agents_search' || t === 'recall') {
    return AgentIntent.MEMORY;
  }
  if (t === 'sessions_spawn' || t === 'task' || t === 'agent' || t === 'delegate') {
    return AgentIntent.SPAWNING;
  }
  // Unknown tool → treat as coding (safe default: sit at desk)
  return AgentIntent.CODING;
}

/** Map an intent to the preferred workstation kind. */
export function intentToWorkstationKind(intent: AgentIntent): WorkstationKind {
  switch (intent) {
    case AgentIntent.CODING:
      return WorkstationKind.DESK;
    case AgentIntent.EXECUTING:
      return WorkstationKind.SERVER_RACK;
    case AgentIntent.BROWSING:
      return WorkstationKind.BROWSER;
    case AgentIntent.THINKING:
      return WorkstationKind.WHITEBOARD;
    case AgentIntent.MEMORY:
      return WorkstationKind.BOOKSHELF;
    case AgentIntent.SPAWNING:
      return WorkstationKind.DOOR;
    case AgentIntent.RESTING:
      return WorkstationKind.SOFA;
    case AgentIntent.SLEEPING:
      return WorkstationKind.BED;
    case AgentIntent.ERROR:
      return WorkstationKind.WHITEBOARD;
  }
}

/** Fallback chain: if the preferred kind has no free seat, try these in order. */
export function fallbackKinds(kind: WorkstationKind): WorkstationKind[] {
  switch (kind) {
    case WorkstationKind.SERVER_RACK:
    case WorkstationKind.BROWSER:
      return [WorkstationKind.DESK];
    case WorkstationKind.WHITEBOARD:
    case WorkstationKind.BOOKSHELF:
    case WorkstationKind.DOOR:
      return [WorkstationKind.DESK];
    case WorkstationKind.BED:
      return [WorkstationKind.SOFA, WorkstationKind.DESK];
    case WorkstationKind.SOFA:
      return [WorkstationKind.DESK];
    case WorkstationKind.DESK:
      return [];
  }
  return [];
}
