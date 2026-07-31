import { AgentMessage, AgentMode } from './agent';
import { McpServerConfig } from '../repositories/settings';
import { randomBytes } from 'crypto';
import { getLogger } from '../utils/logger';
import { getInstanceTempDir } from '../utils/temp-dirs';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Anthropic API keys are ~100 characters. Anything shorter cannot authenticate —
 * this host had `ANTHROPIC_API_KEY=sk-ant-...`, the literal placeholder from the
 * docs, in the user environment.
 */
const MIN_API_KEY_LENGTH = 40;

/**
 * Explain why an ANTHROPIC_API_KEY value cannot work, or null when it looks real.
 *
 * The Claude CLI prefers this variable over the logged-in claude.ai subscription,
 * so a bogus value turns every message into "Invalid API key · Fix external API
 * key" while `claude` still reports itself as logged in. Exported so the startup
 * self-check and /api/health can report the same verdict the spawn path applies.
 */
export function describeUnusableApiKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return 'ANTHROPIC_API_KEY is set but empty';
  }

  if (!trimmed.startsWith('sk-')) {
    return 'ANTHROPIC_API_KEY does not start with sk-';
  }

  if (trimmed.length < MIN_API_KEY_LENGTH) {
    return `ANTHROPIC_API_KEY is only ${trimmed.length} characters — a real key is ~100`;
  }

  return null;
}

/**
 * Utilities for building and formatting agent messages.
 */
export class MessageBuilder {
  /**
   * Build a user message with optional images.
   */
  static buildUserMessage(content: string, images?: Array<{ data: string; mediaType: string }>): string {
    if (!images || images.length === 0) {
      return content;
    }

    // Build multimodal message with images
    const parts: string[] = [];

    // Add images first
    for (const image of images) {
      parts.push(`<image media_type="${image.mediaType}">${image.data}</image>`);
    }

    // Add text content
    parts.push(content);

    return parts.join('\n\n');
  }

  /**
   * Build command line arguments for Claude CLI.
   * Both interactive and autonomous modes use --print with stream-json format.
   * Messages are always sent via stdin, never as CLI arguments.
   */
  static buildArgs(options: {
    mode: AgentMode;
    sessionId?: string;
    resumeSessionId?: string;
    appendSystemPrompt?: string;
    model?: string;
    waitForReady?: boolean;
    contextTokens?: number;
    agentTurns?: number;
    totalBudget?: number;
    cacheAnything?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
    permissionMode?: 'acceptEdits' | 'plan';
    skipPermissions?: boolean;
    message?: string;
    env?: Record<string, string>;
    mcpConfigPath?: string;
    chromeEnabled?: boolean;
    permissionPromptTool?: string;
  }): string[] {
    const args: string[] = ['--print'];

    if (options.model) {
      args.push('--model', options.model);
    }

    MessageBuilder.addDisallowedToolArgs(args, options.disallowedTools);
    MessageBuilder.addPermissionArgs(args, options);
    MessageBuilder.addSessionArgs(args, options);
    MessageBuilder.addOutputArgs(args, options);

    if (options.permissionPromptTool) {
      args.push('--permission-prompt-tool', options.permissionPromptTool);
    }

    return args;
  }

  private static addDisallowedToolArgs(args: string[], disallowedTools?: string[]): void {
    const disallowed = MessageBuilder.buildDisallowedTools(disallowedTools);

    if (disallowed.length > 0) {
      args.push('--disallowedTools', disallowed.join(' '));
    }
  }

  private static addPermissionArgs(args: string[], options: {
    skipPermissions?: boolean;
    permissionMode?: string;
    allowedTools?: string[];
    appendSystemPrompt?: string;
    agentTurns?: number;
  }): void {
    if (options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
      return;
    }

    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(' '));
    }

    if (options.appendSystemPrompt && options.appendSystemPrompt.trim().length > 0) {
      args.push('--append-system-prompt', options.appendSystemPrompt.trim());
    }

    if (options.agentTurns !== undefined && options.agentTurns > 0) {
      args.push('--max-turns', String(options.agentTurns));
    }
  }

  private static addSessionArgs(args: string[], options: {
    sessionId?: string;
    resumeSessionId?: string;
  }): void {
    if (options.sessionId) {
      args.push('--session-id', options.sessionId);
    } else if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }
  }

  private static addOutputArgs(args: string[], options: {
    mcpConfigPath?: string;
    chromeEnabled?: boolean;
  }): void {
    args.push('--input-format', 'stream-json');
    args.push('--output-format', 'stream-json');
    args.push('--verbose');

    if (options.mcpConfigPath) {
      args.push('--mcp-config', options.mcpConfigPath);
    }

    args.push(options.chromeEnabled ? '--chrome' : '--no-chrome');
  }

  /**
   * Generate MCP configuration file for enabled servers.
   * Returns the path to the generated config file or null if no servers are enabled.
   */
  static generateMcpConfig(servers: McpServerConfig[], projectId: string): string | null {
    // No filtering here - servers have already been filtered by applyMcpOverrides
    if (servers.length === 0) {
      return null;
    }

    interface McpServerEntry {
      type: 'stdio' | 'http';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
    }

    // Build the config object
    const mcpServers: Record<string, McpServerEntry> = {};

    for (const server of servers) {
      if (server.type === 'stdio') {
        const serverConfig: McpServerEntry = { type: 'stdio', command: server.command };

        if (server.args && server.args.length > 0) {
          serverConfig.args = server.args;
        }

        if (server.env && Object.keys(server.env).length > 0) {
          serverConfig.env = server.env;
        }
        mcpServers[server.name] = serverConfig;
      } else if (server.type === 'http') {
        const serverConfig: McpServerEntry = { type: 'http', url: server.url };

        if (server.headers && Object.keys(server.headers).length > 0) {
          serverConfig.headers = server.headers;
        }
        mcpServers[server.name] = serverConfig;
      }
    }

    const tempDir = getInstanceTempDir('claudito-mcp');
    // Unique per invocation. The directory already separates instances, but two
    // agents started for the same project inside one instance would otherwise
    // share this file — and whichever stops first deletes it out from under the
    // other, which then loses its MCP servers mid-session.
    const configFileName = `mcp-${projectId}-${Date.now()}-${randomBytes(3).toString('hex')}.json`;
    const configPath = path.join(tempDir, configFileName);

    // Write the config file
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));

    return configPath;
  }

  /**
   * Build the disallowed tools list, always including AskUserQuestion.
   * In --print mode the CLI auto-responds to AskUserQuestion with is_error:true
   * before our app can provide the real answer via stdin.
   */
  static buildDisallowedTools(userDisallowed?: string[]): string[] {
    const tools = new Set(userDisallowed || []);
    tools.add('AskUserQuestion');
    return Array.from(tools);
  }

  /**
   * Build environment variables for Claude CLI.
   */
  static buildEnvironment(env?: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) result[k] = v;
    }
    if (env) Object.assign(result, env);
    result['FORCE_COLOR'] = '1';
    result['ANTHROPIC_TELEMETRY'] = 'false';

    // Remove CLAUDECODE to prevent "nested session" errors when
    // claudito itself runs inside a Claude Code terminal session
    delete result['CLAUDECODE'];

    MessageBuilder.dropUnusableApiKey(result);

    return result;
  }

  /**
   * Strip an ANTHROPIC_API_KEY that cannot possibly authenticate.
   *
   * The CLI prefers this variable over the logged-in claude.ai subscription, so a
   * bogus value makes every message fail with "Invalid API key · Fix external
   * API key" even though `claude` is signed in. Dropping it lets the CLI fall
   * back to the subscription; a real key is left untouched.
   */
  private static dropUnusableApiKey(env: Record<string, string>): void {
    const reason = describeUnusableApiKey(env['ANTHROPIC_API_KEY']);

    if (reason === null) {
      return;
    }

    delete env['ANTHROPIC_API_KEY'];
    getLogger('message-builder').warn('Ignoring unusable ANTHROPIC_API_KEY; falling back to the Claude CLI login', {
      reason,
    });
  }

  /**
   * Format a system message for display.
   */
  static formatSystemMessage(content: string): AgentMessage {
    return {
      type: 'system',
      content,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Format an error message for display.
   */
  static formatErrorMessage(error: Error | string): AgentMessage {
    const content = error instanceof Error ? error.message : error;
    return {
      type: 'stderr',
      content: `Error: ${content}`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check if a message indicates the agent is ready.
   */
  static isReadyMessage(message: string): boolean {
    const readyPatterns = [
      /^Ready\.?$/i,
      /Agent is ready/i,
      /Claude is ready/i,
      /Assistant is ready/i,
    ];

    return readyPatterns.some(pattern => pattern.test(message.trim()));
  }

  /**
   * Check if a message indicates the agent is waiting for input.
   */
  static isWaitingMessage(message: string): boolean {
    const waitingPatterns = [
      /Waiting for input/i,
      /Waiting for user input/i,
      /Enter your message/i,
      /^>$/,
    ];

    return waitingPatterns.some(pattern => pattern.test(message.trim()));
  }

  /**
   * Parse agent response for completion status.
   * Used in autonomous mode to detect when the agent has finished.
   */
  static parseCompletionResponse(content: string): { status: 'COMPLETE' | 'FAILED'; reason: string } | null {
    // Check for explicit completion markers
    if (content.includes('MILESTONE_COMPLETE')) {
      const match = content.match(/MILESTONE_COMPLETE: (.+)/);
      return {
        status: 'COMPLETE',
        reason: match?.[1] || 'Milestone completed',
      };
    }

    if (content.includes('MILESTONE_FAILED')) {
      const match = content.match(/MILESTONE_FAILED: (.+)/);
      return {
        status: 'FAILED',
        reason: match?.[1] || 'Milestone failed',
      };
    }

    // Check for task completion patterns
    const completionPatterns = [
      /All tasks? (?:have been )?completed?/i,
      /Milestone is complete/i,
      /Successfully completed all tasks/i,
      /Finished all pending tasks/i,
    ];

    for (const pattern of completionPatterns) {
      if (pattern.test(content)) {
        return {
          status: 'COMPLETE',
          reason: 'All tasks completed',
        };
      }
    }

    // Check for failure patterns
    const failurePatterns = [
      /Failed to complete milestone/i,
      /Cannot continue with milestone/i,
      /Milestone cannot be completed/i,
      /Critical error occurred/i,
    ];

    for (const pattern of failurePatterns) {
      if (pattern.test(content)) {
        return {
          status: 'FAILED',
          reason: content.trim(),
        };
      }
    }

    return null;
  }

  /**
   * Escape command line arguments for shell execution.
   * This is used when shell mode is required.
   */
  static escapeShellArg(arg: string): string {
    if (process.platform === 'win32') {
      // Windows: Double quotes and escape internal quotes
      return `"${arg.replace(/"/g, '""')}"`;
    } else {
      // Unix: Single quotes and escape internal quotes
      return `'${arg.replace(/'/g, "'\"'\"'")}'`;
    }
  }

  /**
   * Build a shell command from command and arguments.
   * Used when shell execution is required.
   */
  static buildShellCommand(command: string, args: string[]): string {
    const escapedArgs = args.map(arg => this.escapeShellArg(arg));
    return `${command} ${escapedArgs.join(' ')}`;
  }
}