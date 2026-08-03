import { StreamHandler } from '../../../src/agents/stream-handler';
import { AgentMessage, ContextUsage, WaitingStatus, PermissionRequest } from '../../../src/agents/types';
import { getLogger } from '../../../src/utils';

jest.mock('../../../src/utils/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('StreamHandler', () => {
  let handler: StreamHandler;
  let messages: AgentMessage[];
  let waitingStatuses: WaitingStatus[];
  let contextUsages: ContextUsage[];
  let errors: Error[];
  let sessionIds: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    const logger = getLogger('test');
    handler = new StreamHandler(logger, 'test-project', 'test-session');
    messages = [];
    waitingStatuses = [];
    contextUsages = [];
    errors = [];
    sessionIds = [];

    handler.on('message', (msg: AgentMessage) => messages.push(msg));
    handler.on('waitingForInput', (status: WaitingStatus) => waitingStatuses.push(status));
    handler.on('contextUsage', (usage: ContextUsage) => contextUsages.push(usage));
    handler.on('error', (err: Error) => errors.push(err));
    handler.on('sessionId', (id: string) => sessionIds.push(id));
  });

  describe('processLine', () => {
    it('should ignore empty lines', () => {
      handler.processLine('');
      handler.processLine('   ');
      expect(messages).toHaveLength(0);
    });

    it('should emit plain text for non-JSON lines', () => {
      handler.processLine('Hello World');

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stdout');
      expect(messages[0]!.content).toBe('Hello World');
    });

    it('should emit plain text for non-object JSON', () => {
      handler.processLine('"just a string"');

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stdout');
    });

    it('should handle malformed JSON gracefully', () => {
      handler.processLine('{invalid json}');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stdout');
    });

    it('should log error for unhandled event types', () => {
      handler.processLine(JSON.stringify({ type: 'unknown_type' }));
      // Should not crash, no message emitted
      expect(errors).toHaveLength(0);
    });
  });

  describe('system events', () => {
    it('should emit sessionId event on init with session ID (no user-facing message)', () => {
      handler.processLine(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc',
      }));

      expect(messages).toHaveLength(0);
      expect(sessionIds).toEqual(['sess-abc']);
    });

    it('should handle init without session ID', () => {
      handler.processLine(JSON.stringify({
        type: 'system',
        subtype: 'init',
      }));

      // No message and no sessionId event without a session ID
      expect(messages).toHaveLength(0);
      expect(sessionIds).toHaveLength(0);
    });

    it('should handle status compacting', () => {
      handler.processLine(JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('status_change');
    });

    it('should handle compact subtype', () => {
      handler.processLine(JSON.stringify({
        type: 'system',
        subtype: 'compact',
        content: 'Compacted to save tokens',
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('compaction');
      expect(messages[0]!.content).toBe('Compacted to save tokens');
    });

    it('should handle compact_boundary subtype', () => {
      handler.processLine(JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('compaction');
    });
  });

  describe('assistant message events', () => {
    it('should emit text content from assistant message', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello from Claude' },
          ],
        },
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stdout');
      expect(messages[0]!.content).toBe('Hello from Claude');
    });

    it('should deduplicate cumulative text', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }));

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      }));

      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toBe('Hello');
      expect(messages[1]!.content).toBe(' world');
    });

    it('should emit full text when content does not start with previous', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First message' }] },
      }));

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Completely different' }] },
      }));

      expect(messages[1]!.content).toBe('Completely different');
    });

    it('should not emit when text has no new content', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Same' }] },
      }));

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Same' }] },
      }));

      expect(messages).toHaveLength(1);
    });

    it('should emit tool_use for regular tools', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/test.ts' },
          }],
        },
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('tool_use');
      expect(messages[0]!.toolInfo?.name).toBe('Read');
    });

    it('should deduplicate tool use by ID', () => {
      const event = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/test.ts' },
          }],
        },
      });

      handler.processLine(event);
      handler.processLine(event);

      const toolMessages = messages.filter(m => m.type === 'tool_use');
      expect(toolMessages).toHaveLength(1);
    });

    it('should ignore tool_use without ID', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Read',
            input: {},
          }],
        },
      }));

      expect(messages).toHaveLength(0);
    });

    it('should skip empty content blocks', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: { content: [] },
      }));

      expect(messages).toHaveLength(0);
    });

    it('should skip when message has no content', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {},
      }));

      expect(messages).toHaveLength(0);
    });

    it('should update context usage from assistant message', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hi' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }));

      expect(contextUsages).toHaveLength(1);
      expect(contextUsages[0]!.inputTokens).toBe(100);
      expect(contextUsages[0]!.outputTokens).toBe(50);
    });
  });

  describe('special tool handling', () => {
    it('should emit exitPlanMode for ExitPlanMode tool', () => {
      const exitPlanModeEvents: string[] = [];
      handler.on('exitPlanMode', (content: string) => exitPlanModeEvents.push(content));

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-exit-1',
            name: 'ExitPlanMode',
            input: { planContent: 'My plan' },
          }],
        },
      }));

      expect(exitPlanModeEvents).toHaveLength(1);
      expect(exitPlanModeEvents[0]).toBe('My plan');
    });

    it('should extract plan from allowedPrompts', () => {
      const exitPlanModeEvents: string[] = [];
      handler.on('exitPlanMode', (content: string) => exitPlanModeEvents.push(content));

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-exit-2',
            name: 'ExitPlanMode',
            input: {
              allowedPrompts: [
                { tool: 'Bash', prompt: 'run tests' },
                { tool: 'Edit', prompt: 'modify files' },
              ],
            },
          }],
        },
      }));

      expect(exitPlanModeEvents[0]).toContain('Bash: run tests');
      expect(exitPlanModeEvents[0]).toContain('Edit: modify files');
    });

    it('should emit plan_mode message for EnterPlanMode tool', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-enter-1',
            name: 'EnterPlanMode',
            input: {},
          }],
        },
      }));

      const planModeMessages = messages.filter(m => m.type === 'plan_mode');
      expect(planModeMessages).toHaveLength(1);
      expect(planModeMessages[0]!.planModeInfo?.action).toBe('enter');
    });

    it('should emit enterPlanMode event for EnterPlanMode tool', () => {
      let enterPlanModeCount = 0;
      handler.on('enterPlanMode', () => { enterPlanModeCount++; });

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-enter-evt-1',
            name: 'EnterPlanMode',
            input: {},
          }],
        },
      }));

      expect(enterPlanModeCount).toBe(1);
    });

    it('should prevent duplicate EnterPlanMode in same turn', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-enter-1',
            name: 'EnterPlanMode',
            input: {},
          }],
        },
      }));

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-enter-2',
            name: 'EnterPlanMode',
            input: {},
          }],
        },
      }));

      const planModeMessages = messages.filter(m => m.type === 'plan_mode');
      expect(planModeMessages).toHaveLength(1);
    });

    it('should emit tool_use and waitingForInput for AskUserQuestion', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-ask-1',
            name: 'AskUserQuestion',
            input: { question: 'What color?', option_1: 'Red' },
          }],
        },
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('tool_use');
      expect(waitingStatuses).toHaveLength(1);
      expect(waitingStatuses[0]!.isWaiting).toBe(true);
    });

    it('should ignore AskUserQuestion without input or toolId', () => {
      // Access the private method directly since processToolUseBlock guards on id
      (handler as unknown as { handleAskUserQuestionTool: (input?: unknown, id?: string) => void })
        .handleAskUserQuestionTool(undefined, undefined);

      expect(messages).toHaveLength(0);
      expect(waitingStatuses).toHaveLength(0);
    });
  });

  describe('user message events', () => {
    it('should emit tool results from user messages', () => {
      handler.processLine(JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'File contents here',
            is_error: false,
          }],
        },
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('tool_result');
      expect(messages[0]!.toolInfo?.status).toBe('completed');
    });

    it('should emit failed tool results', () => {
      handler.processLine(JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'Error occurred',
            is_error: true,
          }],
        },
      }));

      expect(messages[0]!.toolInfo?.status).toBe('failed');
    });

    it('should skip user messages without content', () => {
      handler.processLine(JSON.stringify({
        type: 'user',
        message: {},
      }));

      expect(messages).toHaveLength(0);
    });

    it('should skip tool_result for AskUserQuestion tools', () => {
      // First, emit AskUserQuestion tool_use to register the tool ID
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-tool-skip',
            name: 'AskUserQuestion',
            input: { question: 'Pick one' },
          }],
        },
      }));

      const toolUseMessages = messages.filter(m => m.type === 'tool_use');
      expect(toolUseMessages).toHaveLength(1);
      messages.length = 0;

      // Now simulate the tool_result with is_error:true (normal for AskUserQuestion)
      handler.processLine(JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'ask-tool-skip',
            content: 'Answer questions?',
            is_error: true,
          }],
        },
      }));

      // Should NOT emit a tool_result — the frontend handles the lifecycle
      expect(messages).toHaveLength(0);
    });
  });

  describe('API streaming events', () => {
    it('should handle content_block_delta with text', () => {
      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { text: 'Hello' },
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe('Hello');
    });

    it('should accumulate partial JSON', () => {
      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { partial_json: '{"key":' },
      }));

      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { partial_json: '"value"}' },
      }));

      // No message until content_block_stop
      expect(messages).toHaveLength(0);
    });

    it('should emit tool message on content_block_stop with accumulated JSON', () => {
      // Set up a tool use via content_block_start
      handler.processLine(JSON.stringify({
        type: 'content_block_start',
        content_block: {
          toolUse: { id: 'tool-1', name: 'Edit' },
        },
      }));

      // Accumulate partial JSON
      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { partial_json: '{"file":"test.ts"}' },
      }));

      // Stop the block
      handler.processLine(JSON.stringify({ type: 'content_block_stop' }));

      const toolMsgs = messages.filter(m => m.type === 'tool_use');
      expect(toolMsgs).toHaveLength(1);
      expect(toolMsgs[0]!.toolInfo?.name).toBe('Edit');
    });

    it('should handle content_block_stop with invalid JSON', () => {
      handler.processLine(JSON.stringify({
        type: 'content_block_start',
        content_block: { toolUse: { id: 'tool-1', name: 'Read' } },
      }));

      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { partial_json: '{invalid' },
      }));

      handler.processLine(JSON.stringify({ type: 'content_block_stop' }));

      // No tool message emitted due to invalid JSON
      const toolMsgs = messages.filter(m => m.type === 'tool_use');
      expect(toolMsgs).toHaveLength(0);
    });

    it('should ignore content_block_delta without delta', () => {
      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
      }));
      expect(messages).toHaveLength(0);
    });

    it('should handle message_start with usage', () => {
      handler.processLine(JSON.stringify({
        type: 'message_start',
        message: {
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      }));

      expect(contextUsages).toHaveLength(1);
      expect(contextUsages[0]!.totalTokens).toBe(300);
    });

    it('should handle message_delta with usage', () => {
      handler.processLine(JSON.stringify({
        type: 'message_delta',
        usage: { input_tokens: 300, output_tokens: 150 },
      }));

      expect(contextUsages).toHaveLength(1);
    });

    it('should handle message_stop (no-op)', () => {
      handler.processLine(JSON.stringify({ type: 'message_stop' }));
      expect(messages).toHaveLength(0);
    });
  });

  describe('error events', () => {
    it('should emit error with message', () => {
      handler.processLine(JSON.stringify({
        type: 'error',
        error: { message: 'Rate limit exceeded' },
      }));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('Rate limit exceeded');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stderr');
    });

    it('should use Unknown error when no message', () => {
      handler.processLine(JSON.stringify({
        type: 'error',
        error: {},
      }));

      expect(errors[0]!.message).toBe('Unknown error');
    });
  });

  describe('result events', () => {
    it('should emit waitingForInput on success result', () => {
      handler.processLine(JSON.stringify({
        type: 'result',
        subtype: 'success',
      }));

      expect(waitingStatuses).toHaveLength(1);
      expect(waitingStatuses[0]).toEqual({ isWaiting: true, version: 1 });
    });

    it('should emit sessionNotFound for session errors', () => {
      const sessionNotFoundEvents: string[] = [];
      handler.on('sessionNotFound', (sessionId: string) => sessionNotFoundEvents.push(sessionId));

      handler.processLine(JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ['No conversation found with session ID: abc-123'],
      }));

      expect(sessionNotFoundEvents).toHaveLength(1);
      expect(sessionNotFoundEvents[0]).toBe('abc-123');
    });

    it('should handle tool failure errors', () => {
      handler.processLine(JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ["ERROR: Tool use failed 'Edit' (ID: tool-1): File not found"],
      }));

      const toolResults = messages.filter(m => m.type === 'tool_result');
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]!.toolInfo?.status).toBe('failed');
    });

    it('should emit result message for non-matching error strings', () => {
      handler.processLine(JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ['Some generic error'],
      }));

      const resultMsgs = messages.filter(m => m.type === 'result');
      expect(resultMsgs).toHaveLength(1);
      expect(resultMsgs[0]!.resultInfo?.isError).toBe(true);
    });

    it('should emit result message for error with result string', () => {
      handler.processLine(JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Error occurred during processing',
      }));

      const resultMsgs = messages.filter(m => m.type === 'result');
      expect(resultMsgs).toHaveLength(1);
    });
  });

  describe('assistant_event handling', () => {
    it('should handle ask_question with text', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'ask_question',
        text: 'Which file?',
      }));

      // waitingForInput is only emitted from AskUserQuestion tool and result handlers
      expect(waitingStatuses).toHaveLength(0);
      const questionMsgs = messages.filter(m => m.type === 'question');
      expect(questionMsgs).toHaveLength(1);
    });

    it('should handle tool_result event', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'tool_result',
        tool_use_id: 'tool-1',
        text: 'Tool output',
      }));

      const toolResults = messages.filter(m => m.type === 'tool_result');
      expect(toolResults).toHaveLength(1);
    });

    it('should handle compaction event', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'compaction',
        text: 'Context compacted',
      }));

      const compactionMsgs = messages.filter(m => m.type === 'compaction');
      expect(compactionMsgs).toHaveLength(1);
    });

    it('should handle thinking event silently', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'thinking',
      }));

      expect(messages).toHaveLength(0);
    });
  });

  describe('user_event handling', () => {
    it('should handle question user event', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Pick one', allow_text: true },
      }));

      // waitingForInput is only emitted from AskUserQuestion tool and result handlers
      expect(waitingStatuses).toHaveLength(0);
      const questionMsgs = messages.filter(m => m.type === 'question');
      expect(questionMsgs).toHaveLength(1);
    });

    it('should handle tool_use user event', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'tool_use',
        user_input: { tool_name: 'Bash', command: 'ls' },
      }));

      const toolMsgs = messages.filter(m => m.type === 'tool_use');
      expect(toolMsgs).toHaveLength(1);
    });

    it('should ignore tool_use without user_input', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'tool_use',
      }));

      expect(messages).toHaveLength(0);
    });

    it('should handle plan_mode user event', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'plan_mode',
        user_input: { action: 'enter' },
      }));

      const planMsgs = messages.filter(m => m.type === 'plan_mode');
      expect(planMsgs).toHaveLength(1);
    });
  });

  describe('permission_request handling', () => {
    it('should emit permissionRequest event', () => {
      const permEvents: PermissionRequest[] = [];
      handler.on('permissionRequest', (req: PermissionRequest) => permEvents.push(req));

      handler.processLine(JSON.stringify({
        type: 'permission_request',
        user_input: {
          tool: 'Bash',
          operation: 'execute',
          reason: 'Need to run tests',
          allow_once: false,
          allow_always: false,
          deny: false,
        },
      }));

      expect(permEvents).toHaveLength(1);
      expect(permEvents[0]!.tool).toBe('Bash');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('permission');
    });

    it('should ignore permission_request without user_input', () => {
      handler.processLine(JSON.stringify({
        type: 'permission_request',
      }));

      expect(messages).toHaveLength(0);
    });
  });

  describe('stdout/stderr events', () => {
    it('should emit stdout content', () => {
      handler.processLine(JSON.stringify({
        type: 'stdout',
        content: 'Process output',
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stdout');
      expect(messages[0]!.content).toBe('Process output');
    });

    it('should emit stderr content', () => {
      handler.processLine(JSON.stringify({
        type: 'stderr',
        content: 'Error output',
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('stderr');
    });
  });

  describe('session_not_found handling', () => {
    it('should emit sessionNotFound event', () => {
      const sessionEvents: string[] = [];
      handler.on('sessionNotFound', (id: string) => sessionEvents.push(id));

      handler.processLine(JSON.stringify({
        type: 'session_not_found',
        conversation_id: 'conv-123',
      }));

      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]).toBe('test-session');
    });
  });

  describe('status_change handling', () => {
    it('should emit status_change message', () => {
      handler.processLine(JSON.stringify({
        type: 'status_change',
        content: 'processing',
      }));

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('status_change');
      expect(messages[0]!.statusChangeInfo?.status).toBe('processing');
    });

    it('should skip when no content', () => {
      handler.processLine(JSON.stringify({
        type: 'status_change',
      }));

      expect(messages).toHaveLength(0);
    });
  });

  describe('updateContextUsage', () => {
    it('should calculate total tokens', () => {
      handler.processLine(JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 100,
          },
        },
      }));

      expect(contextUsages).toHaveLength(1);
      expect(contextUsages[0]!.totalTokens).toBe(1500);
      expect(contextUsages[0]!.cacheCreationInputTokens).toBe(200);
      expect(contextUsages[0]!.cacheReadInputTokens).toBe(100);
    });

    it('should not emit when no tokens provided', () => {
      handler.processLine(JSON.stringify({
        type: 'message_start',
        message: { usage: {} },
      }));

      expect(contextUsages).toHaveLength(0);
    });
  });

  describe('sanitizeToolInput', () => {
    it('should truncate long content fields', () => {
      const longContent = 'x'.repeat(1500);

      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Write',
            input: { content: longContent, file_path: '/test.ts' },
          }],
        },
      }));

      const toolMsg = messages.find(m => m.type === 'tool_use');
      expect(toolMsg?.toolInfo?.input?.content).toContain('... (truncated)');
      expect((toolMsg?.toolInfo?.input?.content as string).length).toBeLessThan(1100);
    });

    it('should not truncate short content', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-2',
            name: 'Write',
            input: { content: 'short', file_path: '/test.ts' },
          }],
        },
      }));

      const toolMsg = messages.find(m => m.type === 'tool_use');
      expect(toolMsg?.toolInfo?.input?.content).toBe('short');
    });
  });

  describe('reset and state', () => {
    it('should reset all state', () => {
      // Build up some state
      handler.processLine(JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 100, output_tokens: 50 } },
      }));

      expect(handler.getContextUsage()).not.toBeNull();

      handler.reset();

      expect(handler.getContextUsage()).toBeNull();
    });

    it('should set max context tokens', () => {
      handler.processLine(JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 5000, output_tokens: 1000 } },
      }));

      handler.setMaxContextTokens(200000);

      const usage = handler.getContextUsage();
      expect(usage?.maxContextTokens).toBe(200000);
      expect(usage?.percentUsed).toBe(3); // 6000/200000 * 100
    });

    it('should handle setMaxContextTokens with no usage', () => {
      handler.setMaxContextTokens(200000);
      expect(handler.getContextUsage()).toBeNull();
    });

    it('should handle setMaxContextTokens with zero max', () => {
      handler.processLine(JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 100, output_tokens: 50 } },
      }));

      handler.setMaxContextTokens(0);

      expect(handler.getContextUsage()?.percentUsed).toBe(0);
    });
  });

  describe('question option extraction', () => {
    it('should extract allow_text option', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: {
          question: 'Pick:',
          allow_text: true,
          option_1: 'Choice A',
          option_2: 'Choice B',
        },
      }));

      const questionMsg = messages.find(m => m.type === 'question');
      expect(questionMsg?.questionInfo?.options).toEqual(
        expect.arrayContaining([
          { label: 'Enter custom text', value: 'text' },
          { label: 'Choice A', value: 'option_1' },
          { label: 'Choice B', value: 'option_2' },
        ])
      );
    });
  });

  describe('AskUserQuestion deduplication', () => {
    it('should suppress user_event question when AskUserQuestion tool already emitted', () => {
      // First: AskUserQuestion tool via assistant message
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-tool-1',
            name: 'AskUserQuestion',
            input: { question: 'Which color?', option_1: 'Red', option_2: 'Blue' },
          }],
        },
      }));

      // Then: user_event question for the same question
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Which color?', option_1: 'Red', option_2: 'Blue' },
      }));

      // Should only have the tool_use message, not a duplicate question message
      const toolUseMessages = messages.filter(m => m.type === 'tool_use');
      const questionMessages = messages.filter(m => m.type === 'question');
      expect(toolUseMessages).toHaveLength(1);
      expect(questionMessages).toHaveLength(0);
    });

    it('should suppress assistant_event ask_question when AskUserQuestion tool already emitted', () => {
      // First: AskUserQuestion tool
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-tool-2',
            name: 'AskUserQuestion',
            input: { question: 'Pick a file' },
          }],
        },
      }));

      // Then: assistant_event ask_question
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'ask_question',
        text: 'Pick a file',
      }));

      const questionMessages = messages.filter(m => m.type === 'question');
      expect(questionMessages).toHaveLength(0);
    });

    it('should not emit extra waitingForInput from user_event when AskUserQuestion already emitted', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-tool-3',
            name: 'AskUserQuestion',
            input: { question: 'Choose' },
          }],
        },
      }));

      // 1 waiting from AskUserQuestion tool
      expect(waitingStatuses).toHaveLength(1);

      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Choose' },
      }));

      // No extra waiting event from user_event (only AskUserQuestion + result emit waiting)
      expect(waitingStatuses).toHaveLength(1);
    });

    it('should deduplicate repeated user_event question emissions', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Same question' },
      }));

      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Same question' },
      }));

      const questionMessages = messages.filter(m => m.type === 'question');
      expect(questionMessages).toHaveLength(1);
    });

    it('should deduplicate repeated assistant_event ask_question emissions', () => {
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'ask_question',
        text: 'Repeated question',
      }));

      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'ask_question',
        text: 'Repeated question',
      }));

      const questionMessages = messages.filter(m => m.type === 'question');
      expect(questionMessages).toHaveLength(1);
    });

    it('should allow different questions from user_event after dedup', () => {
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'First question' },
      }));

      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Different question' },
      }));

      const questionMessages = messages.filter(m => m.type === 'question');
      expect(questionMessages).toHaveLength(2);
    });

    it('should not duplicate AskUserQuestion when both assistant and content_block_stop fire', () => {
      // Path 1: assistant event with cumulative content (tool_use block)
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-dup-1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
          }],
        },
      }));

      // Path 2: content_block_start + delta + stop for the same tool
      handler.processLine(JSON.stringify({
        type: 'content_block_start',
        content_block: {
          toolUse: { id: 'ask-dup-1', name: 'AskUserQuestion' },
        },
      }));

      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { partial_json: '{"questions":[{"question":"Pick one","options":[{"label":"A"}]}]}' },
      }));

      handler.processLine(JSON.stringify({ type: 'content_block_stop' }));

      // Should only emit ONE tool_use for AskUserQuestion
      const toolUseMessages = messages.filter(m => m.type === 'tool_use');
      expect(toolUseMessages).toHaveLength(1);
      expect(toolUseMessages[0]!.toolInfo?.name).toBe('AskUserQuestion');

      // Should only emit ONE waitingForInput
      expect(waitingStatuses).toHaveLength(1);
    });

    it('should not duplicate tool from content_block_stop when assistant already emitted it', () => {
      // Simulate: assistant event arrives first with a regular tool
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-dedup-1',
            name: 'Read',
            input: { file_path: '/test.ts' },
          }],
        },
      }));

      // Then content_block_stop fires for same tool
      handler.processLine(JSON.stringify({
        type: 'content_block_start',
        content_block: {
          toolUse: { id: 'tool-dedup-1', name: 'Read' },
        },
      }));

      handler.processLine(JSON.stringify({
        type: 'content_block_delta',
        delta: { partial_json: '{"file_path":"/test.ts"}' },
      }));

      handler.processLine(JSON.stringify({ type: 'content_block_stop' }));

      // Should only have ONE tool_use message
      const toolUseMessages = messages.filter(m => m.type === 'tool_use');
      expect(toolUseMessages).toHaveLength(1);
    });

    it('should skip assistant_event tool_result for AskUserQuestion tools', () => {
      // Register an AskUserQuestion tool
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-result-1',
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Test?' }] },
          }],
        },
      }));

      // Simulate assistant_event tool_result for the same tool
      handler.processLine(JSON.stringify({
        type: 'assistant_event',
        assistant_event_type: 'tool_result',
        tool_use_id: 'ask-result-1',
        content: 'some result',
      }));

      // Should NOT emit a tool_result message for this tool
      const toolResultMessages = messages.filter(m => m.type === 'tool_result');
      expect(toolResultMessages).toHaveLength(0);
    });

    it('should reset dedup state on system init', () => {
      // Emit a question
      handler.processLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'ask-tool-4',
            name: 'AskUserQuestion',
            input: { question: 'Q1' },
          }],
        },
      }));

      // Reset via system init
      handler.processLine(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'new-session',
      }));

      // After reset, user_event question should emit again
      handler.processLine(JSON.stringify({
        type: 'user_event',
        user_event_type: 'question',
        user_input: { question: 'Q2' },
      }));

      const questionMessages = messages.filter(m => m.type === 'question');
      expect(questionMessages).toHaveLength(1);
    });
  });
  /**
   * A rate limit used to be logged and nothing else. From the browser that was
   * indistinguishable from a hang — spinner running, no message, for minutes — so
   * the chat looked broken and users resent or restarted, neither of which helps.
   */
  describe('rate_limit_event', () => {
    it('tells the user a rate limit was hit, with the wait', () => {
      handler.processLine(JSON.stringify({
        type: 'rate_limit_event',
        retry_after_ms: 42000,
      }));

      const system = messages.filter(m => m.type === 'system');
      expect(system).toHaveLength(1);
      expect(system[0]!.content).toContain('42');
      // Says not to resend — resending is the natural but wrong reaction.
      expect(system[0]!.content).toContain('다시 보내지 않아도');
    });

    it('still explains itself when no retry delay is given', () => {
      handler.processLine(JSON.stringify({ type: 'rate_limit_event' }));

      const system = messages.filter(m => m.type === 'system');
      expect(system).toHaveLength(1);
      expect(system[0]!.content).toContain('한도');
    });
  });
});
