import fs from 'fs';
import path from 'path';
import { DockerSettings } from '../services/docker/types';
import { isValidModel } from '../config/models';

export interface PermissionRule {
  tool: string;
  specifier?: string;
}

export interface ClaudePermissions {
  /** @deprecated Use allowRules instead. Will be removed in future version. */
  dangerouslySkipPermissions: boolean;
  /** @deprecated Use allowRules instead */
  allowedTools: string[];
  /** Permission rules that allow tool usage without prompting */
  allowRules: string[];
  /** Permission rules that require confirmation before use */
  askRules: string[];
  /** Permission rules that block tool usage entirely */
  denyRules: string[];
  /** Default permission mode: 'acceptEdits' | 'plan' */
  defaultMode: 'acceptEdits' | 'plan';
}

export const DEFAULT_AGENT_PROMPT_TEMPLATE = `You are working on the project "\${var:project-name}".

Current Phase: \${var:phase-title}
Current Milestone: \${var:milestone-title}

Your current task is:
\${var:milestone-item}

Instructions:
1. Work on this specific task until it is fully complete
2. Write tests for the functionality and ensure they pass
3. If you discover important context about the project, save it to CLAUDE.md
4. Mark the task as completed in ROADMAP.md by changing [ ] to [x]
5. Do NOT work on other tasks - focus only on this one

When finished, you MUST return a JSON object with the following structure:
{
  "status": "COMPLETE" or "FAILED",
  "reason": "explanation of what was done or why it failed"
}`;

export interface AgentLimitsSettings {
  /** Maximum number of agentic turns before stopping (0 = unlimited) */
  maxTurns: number;
}

export interface AgentStreamingSettings {
  /** Include partial streaming events for smoother real-time display */
  includePartialMessages: boolean;
  /** Disable session persistence - sessions won't be saved to disk */
  noSessionPersistence: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  isQuickAction?: boolean;
}

export interface RalphLoopSettings {
  /** Default maximum turns for Ralph Loop */
  defaultMaxTurns: number;
  /** Default model for worker agent */
  defaultWorkerModel: string;
  /** Default model for reviewer agent */
  defaultReviewerModel: string;
  /** Default append system prompt for worker agent */
  defaultWorkerSystemPrompt?: string;
  /** Default append system prompt for reviewer agent */
  defaultReviewerSystemPrompt?: string;
  /** Maximum number of Ralph Loop task directories to keep (older ones are automatically deleted) */
  historyLimit: number;
}

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'bug-fix',
    name: 'Bug Fix',
    description: 'Report and fix a bug',
    content: `Fix this bug:

**Location:** \${text:location}

**Error message or symptom:**
\${textarea:error}

**Expected behavior:**
\${textarea:expected}

**Actual behavior:**
\${textarea:actual}

**Steps to reproduce:**
\${textarea:steps}

**Write regression test:** \${checkbox:write_test=true}`,
  },
  {
    id: 'documentation',
    name: 'Documentation',
    description: 'Write or update documentation',
    content: `Write documentation:

**Target:** \${text:target}

**Type:** \${select:type:README,API reference,inline comments,usage guide,architecture overview=README}

**Audience:** \${select:audience:developers,end users,contributors,all=developers}

**Areas to cover:**
\${textarea:areas}`,
  },
  {
    id: 'feature-implementation',
    name: 'Feature Implementation',
    description: 'Implement a new feature',
    content: `Implement this feature:

**Feature:** \${text:feature_name}

**Use case:**
\${textarea:use_case}

**Requirements:**
\${textarea:requirements}

**Acceptance criteria:**
\${textarea:criteria}

**Include tests:** \${checkbox:include_tests=true}`,
  },
  {
    id: 'refactoring',
    name: 'Refactoring',
    description: 'Refactor existing code',
    content: `Refactor this code:

**Target:** \${text:target}

**Problems with current code:**
\${textarea:problems}

**Goal:** \${select:goal:improve readability,reduce complexity,improve performance,extract reusable code,improve testability=improve readability}

**Constraints:**
\${textarea:constraints}`,
  },
  {
    id: 'testing',
    name: 'Testing',
    description: 'Write tests for code',
    content: `Write tests:

**Target:** \${text:target}

**Test type:** \${select:type:unit tests,integration tests,end-to-end tests=unit tests}

**Scenarios to cover:**
\${textarea:scenarios}

**Edge cases:**
\${textarea:edge_cases}`,
  },
  {
    id: 'explain-project',
    name: 'Explain this project',
    description: 'Get a comprehensive overview of the current project',
    content: `Please analyze this project and provide a comprehensive overview including:

1. **Project Purpose**: What is this project designed to do?
2. **Technology Stack**: What languages, frameworks, and tools are used?
3. **Architecture**: How is the code organized? What are the main components?
4. **Key Features**: What are the main functionalities implemented?
5. **Development Status**: What appears to be completed vs. in progress?
6. **Notable Patterns**: Any interesting design patterns or approaches?

Base your analysis on the project files, configuration, and code structure.`,
    isQuickAction: true,
  },
  {
    id: 'code-review',
    name: 'Review Code',
    description: 'Create a comprehensive code review plan',
    content: `Please use the /code-reviewer skill to analyze code.

**Scope:** \${select:scope:Entire codebase,Specific directory,Single file,Changed files only=Entire codebase}

**Directory/File Path (if applicable):** \${text:path=}

**Priority Focus:** \${select:priority:All areas,Performance,Security,Maintainability,Testing,Architecture=All areas}

**Depth:** \${select:depth:Quick scan,Standard review,Deep analysis=Standard review}

**Additional Concerns (optional):** \${textarea:concerns=}

Provide a detailed plan with prioritized recommendations for improving code quality.`,
    isQuickAction: true,
  },
  {
    id: 'expert-developer',
    name: 'Expert Developer',
    description: 'Use expert developer for implementation',
    content: `Please use the /expert-developer skill for development.

**Task:** \${select:task_type:Implement current plan,Custom task=Implement current plan}

**Custom Task Description (if applicable):** \${textarea:custom_task=}

**Approach:** \${select:approach:Best practices focus,Performance optimized,Security hardened,Maintainability first=Best practices focus}

**Testing Strategy:** \${select:testing:Full TDD,Write tests after,Minimal tests=Full TDD}

Remember to follow all best practices and produce production-ready code.`,
    isQuickAction: true,
  },
];

export interface AnthropicProfileConfig {
  runtime: 'claude-binary' | 'sdk';
  /** Only when runtime=sdk */
  authMode?: 'api-key' | 'pro-plan';
  /** Only when authMode=api-key */
  apiKey?: string;
}

export interface OpencodeProfileConfig {
  /** Optional path to opencode config file */
  configPath?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  provider: 'anthropic' | 'opencode';
  isDefault: boolean;
  anthropicConfig?: AnthropicProfileConfig;
  opencodeConfig?: OpencodeProfileConfig;
}

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  id: 'default',
  name: 'Claude Binary',
  provider: 'anthropic',
  isDefault: true,
  anthropicConfig: { runtime: 'claude-binary' },
};

export interface McpServerConfig {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  enabled: boolean;              // Whether server is active
  type: 'stdio' | 'http';        // Connection type

  // For stdio type
  command?: string;              // Executable command
  args?: string[];               // Command arguments
  env?: Record<string, string>;  // Environment variables

  // For http type
  url?: string;                  // Server URL
  headers?: Record<string, string>; // HTTP headers

  // Common settings
  description?: string;          // User description
  autoApproveTools?: boolean;    // Auto-approve all tools from this server (default: true)
}

export interface McpSettings {
  enabled: boolean;              // Master toggle
  servers: McpServerConfig[];    // Server configurations
}

export interface SlackSettings {
  /** Bot Token (xoxb-...) for Slack Web API */
  botToken: string;
  /** App Token (xapp-...) for Slack Socket Mode */
  appToken: string;
  /** Default channel ID for notifications */
  defaultChannelId: string;
  /** Master enable/disable toggle */
  enabled: boolean;
}

export interface EmailSettings {
  /** Master enable/disable toggle */
  enabled: boolean;
  /** SMTP server hostname */
  smtpHost: string;
  /** SMTP server port */
  smtpPort: number;
  /** Use TLS (true=465) or STARTTLS (false=587) */
  smtpSecure: boolean;
  /** SMTP authentication username */
  smtpUser: string;
  /** SMTP authentication password */
  smtpPassword: string;
  /** From address for sent emails */
  fromAddress: string;
  /** Default recipient when none is specified */
  defaultRecipient: string;
}

export interface GlobalSettings {
  maxConcurrentAgents: number;
  claudePermissions: ClaudePermissions;
  agentPromptTemplate: string;
  sendWithCtrlEnter: boolean;
  historyLimit: number;
  enableDesktopNotifications: boolean;
  appendSystemPrompt: string;
  claudeMdMaxSizeKB: number;
  /** Agent execution limits (turns, budget) */
  agentLimits: AgentLimitsSettings;
  /** Agent streaming options */
  agentStreaming: AgentStreamingSettings;
  /** Prompt templates for quick message insertion */
  promptTemplates: PromptTemplate[];
  /** Ralph Loop settings for worker/reviewer iterations */
  ralphLoop: RalphLoopSettings;
  /** MCP (Model Context Protocol) server configurations */
  mcp: McpSettings;
  /** Slack integration settings */
  slack: SlackSettings;
  /** Email notification settings */
  email: EmailSettings;
  /** Enable Chrome browser usage in Claude agents */
  chromeEnabled: boolean;
  /** Base directory for Inventify-generated projects */
  inventifyFolder: string;
  /** Docker sandboxed execution settings */
  docker: DockerSettings;
  /** Agent execution profiles (provider + runtime config) */
  agentProfiles: AgentProfile[];
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  maxConcurrentAgents: 3,
  claudePermissions: {
    dangerouslySkipPermissions: false,
    allowedTools: [],
    allowRules: [
      'Read',
      'Task',
      'Glob',
      'Grep',
      'Bash(npm run:*)',
      'Bash(npm test:*)',
      'Bash(npm install)',
      'Bash(node:*)',
      'Bash(tsc:*)',
      'Bash(go run:*)',
      'Bash(go build:*)',
      'Bash(go test:*)',
      'Bash(go mod:*)',
      'Bash(cargo run:*)',
      'Bash(cargo build:*)',
      'Bash(cargo test:*)',
      'Bash(cargo check:*)',
      'Bash(git status)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git branch:*)',
      'WebSearch',
      'WebFetch',
    ],
    askRules: [],
    denyRules: [],
    defaultMode: 'plan',
  },
  agentPromptTemplate: DEFAULT_AGENT_PROMPT_TEMPLATE,
  sendWithCtrlEnter: true,
  historyLimit: 25,
  enableDesktopNotifications: false,
  appendSystemPrompt: `* ALWAYS use tasks instead of todos
* ALWAYS generate mermaidjs diagrams when explaining code or when generating a plan`,
  claudeMdMaxSizeKB: 50,
  agentLimits: {
    maxTurns: 0,       // 0 = unlimited
  },
  agentStreaming: {
    includePartialMessages: false,
    noSessionPersistence: false,
  },
  promptTemplates: DEFAULT_PROMPT_TEMPLATES,
  ralphLoop: {
    defaultMaxTurns: 5,
    defaultWorkerModel: 'claude-opus-4-6',
    defaultReviewerModel: 'claude-sonnet-4-6',
    defaultWorkerSystemPrompt: `# Worker Agent Instructions

You are a software development worker agent. Your role is to implement the requested changes or features with precision and thoroughness.

## Key Principles:
- Focus on completing the specific task assigned
- Write clean, maintainable code following project conventions
- Include appropriate error handling and edge cases
- Create or update tests to verify your implementation
- Document any significant design decisions or trade-offs

## Process:
1. Analyze the task requirements thoroughly
2. Implement the solution step by step
3. Test your implementation
4. Verify all changes work as expected
5. Provide a clear summary of what was accomplished

Remember: Quality over speed. It's better to do the job right than to rush and create technical debt.`,
    defaultReviewerSystemPrompt: `# Reviewer Agent Instructions

You are a code review agent. Your role is to critically evaluate the worker's implementation for correctness, quality, and completeness.

## Review Criteria:
- Does the implementation fully address the requirements?
- Is the code clean, readable, and maintainable?
- Are there appropriate tests with good coverage?
- Are edge cases and error scenarios handled?
- Does it follow project conventions and best practices?
- Are there any security concerns or performance issues?

## Feedback Guidelines:
- Be specific and constructive in your feedback
- Point out both issues and good practices
- Suggest concrete improvements when identifying problems
- Focus on the most important issues first

Your goal is to ensure high-quality deliverables. Be thorough but fair in your assessment.`,
    historyLimit: 5,
  },
  mcp: {
    enabled: true,
    servers: [],
  },
  slack: {
    enabled: false,
    botToken: '',
    appToken: '',
    defaultChannelId: '',
  },
  email: {
    enabled: false,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPassword: '',
    fromAddress: '',
    defaultRecipient: '',
  },
  chromeEnabled: false,
  inventifyFolder: '',
  docker: {
    enabled: false,
    baseImage: 'claudito-agent:latest',
    resourceLimits: { cpus: 2.0, memoryMb: 4096 },
    networkMode: 'bridge',
  },
  agentProfiles: [{ ...DEFAULT_AGENT_PROFILE }],
};

// Update type that allows partial nested objects for incremental updates
export interface SettingsUpdate {
  maxConcurrentAgents?: number;
  claudePermissions?: Partial<ClaudePermissions>;
  agentPromptTemplate?: string;
  sendWithCtrlEnter?: boolean;
  historyLimit?: number;
  enableDesktopNotifications?: boolean;
  appendSystemPrompt?: string;
  claudeMdMaxSizeKB?: number;
  agentLimits?: Partial<AgentLimitsSettings>;
  agentStreaming?: Partial<AgentStreamingSettings>;
  promptTemplates?: PromptTemplate[];
  ralphLoop?: Partial<RalphLoopSettings>;
  mcp?: Partial<McpSettings>;
  slack?: Partial<SlackSettings>;
  email?: Partial<EmailSettings>;
  chromeEnabled?: boolean;
  inventifyFolder?: string;
  docker?: Partial<DockerSettings>;
  agentProfiles?: AgentProfile[];
}

export interface SettingsRepository {
  get(): Promise<GlobalSettings>;
  update(settings: SettingsUpdate): Promise<GlobalSettings>;
}

export interface FileSystemAdapter {
  readFileSync(filePath: string, encoding: BufferEncoding): string;
  writeFileSync(filePath: string, data: string): void;
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string, options: { recursive: boolean }): void;
  /** Optional so existing adapters keep working; used for atomic saves. */
  renameSync?(oldPath: string, newPath: string): void;
}

const defaultFileSystem: FileSystemAdapter = {
  readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
  writeFileSync: (filePath, data) => fs.writeFileSync(filePath, data),
  existsSync: (filePath) => fs.existsSync(filePath),
  mkdirSync: (dirPath, options) => fs.mkdirSync(dirPath, options),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
};

export class FileSettingsRepository implements SettingsRepository {
  private settings: GlobalSettings;
  private readonly filePath: string;
  private readonly fileSystem: FileSystemAdapter;

  constructor(dataDir: string, fileSystem: FileSystemAdapter = defaultFileSystem) {
    this.fileSystem = fileSystem;
    this.ensureDataDir(dataDir);
    this.filePath = path.join(dataDir, 'settings.json');
    this.settings = this.loadFromFile();
  }

  private ensureDataDir(dataDir: string): void {
    if (!this.fileSystem.existsSync(dataDir)) {
      this.fileSystem.mkdirSync(dataDir, { recursive: true });
    }
  }

  private loadFromFile(): GlobalSettings {
    if (!this.fileSystem.existsSync(this.filePath)) {
      return { ...DEFAULT_SETTINGS };
    }

    try {
      const data = this.fileSystem.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(data) as Partial<GlobalSettings>;
      return this.mergeWithDefaults(parsed);
    } catch {
      // Falling back to defaults is the only way to keep the app usable, but the
      // unreadable file must not be overwritten by the next save — it holds the
      // only copy of the user's tokens. Move it aside so it can be recovered.
      this.preserveCorruptSettings();
      return { ...DEFAULT_SETTINGS };
    }
  }

  private preserveCorruptSettings(): void {
    if (!this.fileSystem.renameSync) {
      return;
    }

    try {
      this.fileSystem.renameSync(this.filePath, `${this.filePath}.corrupt`);
    } catch {
      // Best effort — defaults are already in place.
    }
  }

  /**
   * Drops model ids that are no longer supported so the caller falls back to the
   * current default.
   *
   * This used to hold a hand-maintained OLD_MODEL_IDS list, which had drifted:
   * it listed `claude-sonnet-4-5-20250929`, a model that is still in
   * SUPPORTED_MODELS. Picking Sonnet 4.5 for a Ralph Loop therefore looked like
   * it saved, then silently reverted to the default on the next read. Deriving
   * from SUPPORTED_MODELS keeps the two from disagreeing again.
   */
  private migrateOldModelId(modelId: string | undefined): string | undefined {
    if (modelId && !isValidModel(modelId)) {
      return undefined;
    }

    return modelId;
  }

  private mergeTemplates(existingTemplates: PromptTemplate[] | undefined): PromptTemplate[] {
    if (!Array.isArray(existingTemplates)) {
      return [...DEFAULT_PROMPT_TEMPLATES];
    }

    const defaultsById = new Map(DEFAULT_PROMPT_TEMPLATES.map(t => [t.id, t]));

    // Update existing default templates to latest content, keep user templates as-is
    const merged = existingTemplates.map(t => {
      const defaultVersion = defaultsById.get(t.id);

      if (defaultVersion) {
        defaultsById.delete(t.id);
        return { ...defaultVersion };
      }

      return t;
    });

    // Add any missing defaults
    for (const missing of defaultsById.values()) {
      merged.push({ ...missing });
    }

    return merged;
  }

  private mergeProfiles(existingProfiles: AgentProfile[] | undefined): AgentProfile[] {
    if (!Array.isArray(existingProfiles) || existingProfiles.length === 0) {
      return [{ ...DEFAULT_AGENT_PROFILE }];
    }

    // Ensure exactly one default
    const hasDefault = existingProfiles.some(p => p.isDefault);

    if (!hasDefault) {
      existingProfiles[0]!.isDefault = true;
    }

    return existingProfiles;
  }

  private mergePermissions(parsed?: Partial<ClaudePermissions>): ClaudePermissions {
    return {
      dangerouslySkipPermissions: parsed?.dangerouslySkipPermissions ?? DEFAULT_SETTINGS.claudePermissions.dangerouslySkipPermissions,
      allowedTools: parsed?.allowedTools ?? DEFAULT_SETTINGS.claudePermissions.allowedTools,
      allowRules: parsed?.allowRules ?? DEFAULT_SETTINGS.claudePermissions.allowRules,
      askRules: parsed?.askRules ?? DEFAULT_SETTINGS.claudePermissions.askRules,
      denyRules: parsed?.denyRules ?? DEFAULT_SETTINGS.claudePermissions.denyRules,
      defaultMode: parsed?.defaultMode ?? DEFAULT_SETTINGS.claudePermissions.defaultMode,
    };
  }

  private mergeRalphLoopSettings(parsed?: Partial<RalphLoopSettings>): RalphLoopSettings {
    return {
      defaultMaxTurns: parsed?.defaultMaxTurns ?? DEFAULT_SETTINGS.ralphLoop.defaultMaxTurns,
      defaultWorkerModel: this.migrateOldModelId(parsed?.defaultWorkerModel) ?? DEFAULT_SETTINGS.ralphLoop.defaultWorkerModel,
      defaultReviewerModel: this.migrateOldModelId(parsed?.defaultReviewerModel) ?? DEFAULT_SETTINGS.ralphLoop.defaultReviewerModel,
      defaultWorkerSystemPrompt: parsed?.defaultWorkerSystemPrompt ?? DEFAULT_SETTINGS.ralphLoop.defaultWorkerSystemPrompt,
      defaultReviewerSystemPrompt: parsed?.defaultReviewerSystemPrompt ?? DEFAULT_SETTINGS.ralphLoop.defaultReviewerSystemPrompt,
      historyLimit: parsed?.historyLimit ?? DEFAULT_SETTINGS.ralphLoop.historyLimit,
    };
  }

  private mergeDockerSettings(parsed?: Partial<DockerSettings>): DockerSettings {
    return {
      enabled: parsed?.enabled ?? DEFAULT_SETTINGS.docker.enabled,
      baseImage: parsed?.baseImage ?? DEFAULT_SETTINGS.docker.baseImage,
      resourceLimits: {
        cpus: parsed?.resourceLimits?.cpus ?? DEFAULT_SETTINGS.docker.resourceLimits.cpus,
        memoryMb: parsed?.resourceLimits?.memoryMb ?? DEFAULT_SETTINGS.docker.resourceLimits.memoryMb,
      },
      networkMode: parsed?.networkMode ?? DEFAULT_SETTINGS.docker.networkMode,
    };
  }

  private mergeSlackSettings(parsed?: Partial<SlackSettings>): SlackSettings {
    return {
      enabled: parsed?.enabled ?? DEFAULT_SETTINGS.slack.enabled,
      botToken: parsed?.botToken ?? DEFAULT_SETTINGS.slack.botToken,
      appToken: parsed?.appToken ?? DEFAULT_SETTINGS.slack.appToken,
      defaultChannelId: parsed?.defaultChannelId ?? DEFAULT_SETTINGS.slack.defaultChannelId,
    };
  }

  private mergeEmailSettings(parsed?: Partial<EmailSettings>): EmailSettings {
    return {
      enabled: parsed?.enabled ?? DEFAULT_SETTINGS.email.enabled,
      smtpHost: parsed?.smtpHost ?? DEFAULT_SETTINGS.email.smtpHost,
      smtpPort: parsed?.smtpPort ?? DEFAULT_SETTINGS.email.smtpPort,
      smtpSecure: parsed?.smtpSecure ?? DEFAULT_SETTINGS.email.smtpSecure,
      smtpUser: parsed?.smtpUser ?? DEFAULT_SETTINGS.email.smtpUser,
      smtpPassword: parsed?.smtpPassword ?? DEFAULT_SETTINGS.email.smtpPassword,
      fromAddress: parsed?.fromAddress ?? DEFAULT_SETTINGS.email.fromAddress,
      defaultRecipient: parsed?.defaultRecipient ?? DEFAULT_SETTINGS.email.defaultRecipient,
    };
  }

  private mergeScalarDefaults(parsed: Partial<GlobalSettings>): Pick<GlobalSettings,
    'maxConcurrentAgents' | 'agentPromptTemplate' | 'sendWithCtrlEnter' | 'historyLimit' |
    'enableDesktopNotifications' | 'appendSystemPrompt' | 'claudeMdMaxSizeKB' |
    'chromeEnabled' | 'inventifyFolder'> {
    return {
      maxConcurrentAgents: parsed.maxConcurrentAgents ?? DEFAULT_SETTINGS.maxConcurrentAgents,
      agentPromptTemplate: parsed.agentPromptTemplate ?? DEFAULT_SETTINGS.agentPromptTemplate,
      sendWithCtrlEnter: parsed.sendWithCtrlEnter ?? DEFAULT_SETTINGS.sendWithCtrlEnter,
      historyLimit: parsed.historyLimit ?? DEFAULT_SETTINGS.historyLimit,
      enableDesktopNotifications: parsed.enableDesktopNotifications ?? DEFAULT_SETTINGS.enableDesktopNotifications,
      appendSystemPrompt: parsed.appendSystemPrompt ?? DEFAULT_SETTINGS.appendSystemPrompt,
      claudeMdMaxSizeKB: parsed.claudeMdMaxSizeKB ?? DEFAULT_SETTINGS.claudeMdMaxSizeKB,
      chromeEnabled: parsed.chromeEnabled ?? DEFAULT_SETTINGS.chromeEnabled,
      inventifyFolder: parsed.inventifyFolder ?? DEFAULT_SETTINGS.inventifyFolder,
    };
  }

  private mergeWithDefaults(parsed: Partial<GlobalSettings>): GlobalSettings {
    return {
      ...this.mergeScalarDefaults(parsed),
      claudePermissions: this.mergePermissions(parsed.claudePermissions),
      agentLimits: {
        maxTurns: parsed.agentLimits?.maxTurns ?? DEFAULT_SETTINGS.agentLimits.maxTurns,
      },
      agentStreaming: {
        includePartialMessages: parsed.agentStreaming?.includePartialMessages ?? DEFAULT_SETTINGS.agentStreaming.includePartialMessages,
        noSessionPersistence: parsed.agentStreaming?.noSessionPersistence ?? DEFAULT_SETTINGS.agentStreaming.noSessionPersistence,
      },
      promptTemplates: this.mergeTemplates(parsed.promptTemplates),
      ralphLoop: this.mergeRalphLoopSettings(parsed.ralphLoop),
      mcp: {
        enabled: parsed.mcp?.enabled ?? DEFAULT_SETTINGS.mcp.enabled,
        servers: parsed.mcp?.servers ?? DEFAULT_SETTINGS.mcp.servers,
      },
      slack: this.mergeSlackSettings(parsed.slack),
      email: this.mergeEmailSettings(parsed.email),
      docker: this.mergeDockerSettings(parsed.docker),
      agentProfiles: this.mergeProfiles(parsed.agentProfiles),
    };
  }

  private saveToFile(): void {
    const data = JSON.stringify(this.settings, null, 2);

    // Atomic when the adapter supports it: a half-written settings.json parses as
    // invalid, and loadFromFile() then silently substitutes DEFAULT_SETTINGS —
    // losing Slack/e-mail credentials, docker config and agent profiles, which the
    // next save would make permanent.
    if (this.fileSystem.renameSync) {
      const tempPath = `${this.filePath}.tmp`;
      this.fileSystem.writeFileSync(tempPath, data);
      this.fileSystem.renameSync(tempPath, this.filePath);
      return;
    }

    this.fileSystem.writeFileSync(this.filePath, data);
  }

  get(): Promise<GlobalSettings> {
    return Promise.resolve({ ...this.settings });
  }

  private updateCoreScalars(updates: SettingsUpdate): void {
    if (updates.maxConcurrentAgents !== undefined) {
      this.settings.maxConcurrentAgents = Math.max(1, updates.maxConcurrentAgents);
    }

    if (updates.agentPromptTemplate !== undefined) {
      this.settings.agentPromptTemplate = updates.agentPromptTemplate;
    }

    if (updates.sendWithCtrlEnter !== undefined) {
      this.settings.sendWithCtrlEnter = updates.sendWithCtrlEnter;
    }

    if (updates.historyLimit !== undefined) {
      this.settings.historyLimit = Math.max(5, Math.min(100, updates.historyLimit));
    }

    if (updates.enableDesktopNotifications !== undefined) {
      this.settings.enableDesktopNotifications = updates.enableDesktopNotifications;
    }

    if (updates.appendSystemPrompt !== undefined) {
      this.settings.appendSystemPrompt = updates.appendSystemPrompt;
    }
  }

  private updateExtendedScalars(updates: SettingsUpdate): void {
    if (updates.claudeMdMaxSizeKB !== undefined) {
      this.settings.claudeMdMaxSizeKB = Math.max(10, Math.min(500, updates.claudeMdMaxSizeKB));
    }

    if (updates.chromeEnabled !== undefined) {
      this.settings.chromeEnabled = updates.chromeEnabled;
    }

    if (updates.inventifyFolder !== undefined) {
      this.settings.inventifyFolder = updates.inventifyFolder;
    }

    if (updates.promptTemplates !== undefined) {
      this.settings.promptTemplates = updates.promptTemplates;
    }

    if (updates.agentProfiles !== undefined) {
      this.settings.agentProfiles = updates.agentProfiles;
    }
  }

  private updateObjectFields(updates: SettingsUpdate): void {
    if (updates.claudePermissions) {
      this.settings.claudePermissions = { ...this.settings.claudePermissions, ...updates.claudePermissions };
    }

    if (updates.agentStreaming) {
      this.settings.agentStreaming = { ...this.settings.agentStreaming, ...updates.agentStreaming };
    }

    if (updates.mcp) {
      this.settings.mcp = { ...this.settings.mcp, ...updates.mcp };
    }

    if (updates.slack) {
      this.settings.slack = { ...this.settings.slack, ...updates.slack };
    }

    if (updates.email) {
      this.settings.email = { ...this.settings.email, ...updates.email };
    }
  }

  private updateRalphLoopFields(ralphLoop: Partial<RalphLoopSettings>): void {
    this.settings.ralphLoop = { ...this.settings.ralphLoop, ...ralphLoop };
    this.settings.ralphLoop.defaultMaxTurns = Math.max(1, this.settings.ralphLoop.defaultMaxTurns);
    this.settings.ralphLoop.historyLimit = Math.max(1, Math.min(50, this.settings.ralphLoop.historyLimit));
  }

  private updateAgentLimits(agentLimits: Partial<AgentLimitsSettings>): void {
    this.settings.agentLimits = { ...this.settings.agentLimits, ...agentLimits };
    this.settings.agentLimits.maxTurns = Math.max(0, this.settings.agentLimits.maxTurns);
  }

  private updateDockerFields(docker: Partial<DockerSettings>): void {
    this.settings.docker = {
      ...this.settings.docker,
      ...docker,
      resourceLimits: {
        ...this.settings.docker.resourceLimits,
        ...(docker.resourceLimits || {}),
      },
    };
    this.settings.docker.resourceLimits.cpus = Math.max(0.5, Math.min(16, this.settings.docker.resourceLimits.cpus));
    this.settings.docker.resourceLimits.memoryMb = Math.max(512, Math.min(32768, this.settings.docker.resourceLimits.memoryMb));
  }

  update(updates: SettingsUpdate): Promise<GlobalSettings> {
    this.updateCoreScalars(updates);
    this.updateExtendedScalars(updates);
    this.updateObjectFields(updates);

    if (updates.agentLimits) {
      this.updateAgentLimits(updates.agentLimits);
    }

    if (updates.ralphLoop) {
      this.updateRalphLoopFields(updates.ralphLoop);
    }

    if (updates.docker) {
      this.updateDockerFields(updates.docker);
    }

    this.saveToFile();
    return Promise.resolve({ ...this.settings });
  }
}
