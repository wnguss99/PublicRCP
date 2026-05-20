import { EventEmitter } from 'events';
import { generateUUID } from '../../utils/uuid';
import { getLogger, Logger } from '../../utils/logger';

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface PendingApproval {
  requestId: string;
  projectId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: number;
}

export interface ApprovalCoordinatorEvents {
  request: (pending: PendingApproval) => void;
  resolved: (requestId: string, projectId: string, decision: ApprovalDecision) => void;
  cancelled: (requestId: string, projectId: string) => void;
}

interface InternalEntry {
  pending: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface ApprovalCoordinatorOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Builds the rule key used to short-circuit future approvals for the same kind of action.
 * Bash is keyed by first word so `git status` and `git log` share one approval.
 * Other tools are keyed by tool name.
 */
export function buildAllowKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const command = String((input && input['command']) || '').trim();
    const firstWord = command.split(/\s+/)[0] || '';
    if (firstWord) {
      return `Bash:${firstWord}`;
    }
  }
  return toolName;
}

/**
 * Builds the persistent Claude Code allow rule for the same key.
 * Format documented at https://code.claude.com/docs/en/settings#permission-settings
 */
export function buildAllowRule(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const command = String((input && input['command']) || '').trim();
    const firstWord = command.split(/\s+/)[0] || '';
    if (firstWord) {
      return `Bash(${firstWord}:*)`;
    }
  }
  return toolName;
}

export class ApprovalCoordinator extends EventEmitter {
  private readonly entries = new Map<string, InternalEntry>();
  // Per-project in-memory allowlist: { projectId -> Set<allowKey> }.
  // Populated when the user clicks "Allow always" so the same key auto-passes for the rest of the session.
  private readonly sessionAllowlist = new Map<string, Set<string>>();
  private readonly logger: Logger;
  private readonly timeoutMs: number;

  constructor(options: ApprovalCoordinatorOptions = {}) {
    super();
    this.logger = getLogger('approval-coordinator');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  request(projectId: string, toolName: string, input: Record<string, unknown>): Promise<ApprovalDecision> {
    // Short-circuit if user already chose "Allow always" for this key in this session.
    const key = buildAllowKey(toolName, input);
    const set = this.sessionAllowlist.get(projectId);
    if (set && set.has(key)) {
      this.logger.debug('Auto-approving from session allowlist', { projectId, toolName, key });
      return Promise.resolve({ behavior: 'allow' });
    }

    const requestId = generateUUID();
    const pending: PendingApproval = {
      requestId,
      projectId,
      toolName,
      input,
      createdAt: Date.now(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.logger.warn('Approval request timed out', { requestId, projectId, toolName });
        this.resolveInternal(requestId, {
          behavior: 'deny',
          message: 'Approval request timed out (no user response).',
        });
      }, this.timeoutMs);

      this.entries.set(requestId, { pending, resolve, timeoutHandle });
      this.logger.info('Approval request created', { requestId, projectId, toolName });
      this.emit('request', pending);
    });
  }

  /**
   * Register a session-scoped auto-approval. Called when the user clicks "Allow always".
   * The key is shared with `request()` via buildAllowKey().
   */
  rememberAllow(projectId: string, toolName: string, input: Record<string, unknown>): string {
    const key = buildAllowKey(toolName, input);
    let set = this.sessionAllowlist.get(projectId);
    if (!set) {
      set = new Set<string>();
      this.sessionAllowlist.set(projectId, set);
    }
    set.add(key);
    return key;
  }

  forgetProjectAllowlist(projectId: string): void {
    this.sessionAllowlist.delete(projectId);
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    return this.resolveInternal(requestId, decision);
  }

  cancelProject(projectId: string, message = 'Agent stopped.'): void {
    for (const [requestId, entry] of this.entries) {
      if (entry.pending.projectId === projectId) {
        this.resolveInternal(requestId, { behavior: 'deny', message });
        this.emit('cancelled', requestId, projectId);
      }
    }
    // Session allowlist dies with the agent so a fresh session starts fresh.
    this.forgetProjectAllowlist(projectId);
  }

  peek(requestId: string): PendingApproval | null {
    const entry = this.entries.get(requestId);
    return entry ? entry.pending : null;
  }

  listForProject(projectId: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const entry of this.entries.values()) {
      if (entry.pending.projectId === projectId) {
        out.push(entry.pending);
      }
    }
    return out;
  }

  private resolveInternal(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timeoutHandle);
    this.entries.delete(requestId);
    entry.resolve(decision);
    this.emit('resolved', requestId, entry.pending.projectId, decision);
    return true;
  }
}
