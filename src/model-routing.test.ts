import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  MODEL_ALIASES: {
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  },
  TRIGGER_PATTERN: /^@Andy\b/i,
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  CREDENTIAL_PROXY_PORT: 3001,
  BACKUP_INTERVAL_MS: 86400000,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Stub out heavy dependencies that index.ts imports
vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: vi.fn(),
}));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
}));
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));
vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
  PROXY_BIND_HOST: '0.0.0.0',
}));
vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getAllChats: vi.fn(() => []),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRegisteredGroup: vi.fn(),
  getRouterState: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setRouterState: vi.fn(),
  setSession: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
}));
vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));
vi.mock('./router.js', () => ({
  escapeXml: vi.fn(),
  formatMessages: vi.fn(),
  findChannel: vi.fn(),
  formatOutbound: vi.fn(),
}));
vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(),
  isTriggerAllowed: vi.fn(),
  loadSenderAllowlist: vi.fn(),
  shouldDropMessage: vi.fn(),
}));
vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));
vi.mock('./group-queue.js', () => ({
  GroupQueue: class {
    setProcessMessagesFn = vi.fn();
    enqueueMessageCheck = vi.fn();
    sendMessage = vi.fn();
    closeStdin = vi.fn();
    registerProcess = vi.fn();
    notifyIdle = vi.fn();
    shutdown = vi.fn();
    setModel = vi.fn();
    getModel = vi.fn();
    isIdle = vi.fn();
    requestModelSwap = vi.fn();
  },
}));
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test'),
  resolveGroupIpcPath: vi.fn(() => '/tmp/test-ipc'),
}));

import {
  resolveModel,
  detectModelOverride,
  stripModelOverride,
} from './index.js';
import type { NewMessage, RegisteredGroup } from './types.js';

function makeMessage(
  content: string,
  overrides?: Partial<NewMessage>,
): NewMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    chat_jid: 'test@g.us',
    sender: '1234567890@s.whatsapp.net',
    sender_name: 'Test User',
    content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function makeGroup(overrides?: Partial<RegisteredGroup>): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    isMain: true,
    ...overrides,
  };
}

describe('resolveModel', () => {
  it('detects @opus and returns opus model ID', () => {
    const msgs = [makeMessage('@opus what is 2+2')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
  });

  it('detects @haiku and returns haiku model ID', () => {
    const msgs = [makeMessage('@haiku hello')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('detects @sonnet and returns sonnet model ID', () => {
    const msgs = [makeMessage('@sonnet test')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-sonnet-4-6');
  });

  it('is case insensitive', () => {
    const msgs = [makeMessage('@OPUS test')];
    const group = makeGroup();
    expect(resolveModel(msgs, group)).toBe('claude-opus-4-6');

    const msgs2 = [makeMessage('@Haiku test')];
    expect(resolveModel(msgs2, group)).toBe('claude-haiku-4-5-20251001');
  });

  it('strips the override keyword from message content', () => {
    const msgs = [makeMessage('@opus what is 2+2')];
    const group = makeGroup();
    resolveModel(msgs, group);
    expect(msgs[0].content).toBe('what is 2+2');
  });

  it('last override wins in a batch', () => {
    const msgs = [makeMessage('@haiku msg1'), makeMessage('@opus msg2')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
    expect(msgs[0].content).toBe('msg1');
    expect(msgs[1].content).toBe('msg2');
  });

  it('detects override that is not the last message', () => {
    const msgs = [makeMessage('@opus question'), makeMessage('follow up')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
    expect(msgs[0].content).toBe('question');
    expect(msgs[1].content).toBe('follow up');
  });

  it('falls back to group config model', () => {
    const msgs = [makeMessage('hello')];
    const group = makeGroup({ containerConfig: { model: 'haiku' } });
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-haiku-4-5-20251001');
  });

  it('falls back to group config with full model ID', () => {
    const msgs = [makeMessage('hello')];
    const group = makeGroup({ containerConfig: { model: 'claude-opus-4-6' } });
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
  });

  it('returns undefined when no override and no group config', () => {
    const msgs = [makeMessage('hello')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBeUndefined();
  });

  it('returns group default for empty messages', () => {
    const group = makeGroup({ containerConfig: { model: 'opus' } });
    const model = resolveModel([], group);
    expect(model).toBe('claude-opus-4-6');
  });

  it('ignores unknown aliases', () => {
    const msgs = [makeMessage('@gpt4 hello')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBeUndefined();
    // Content should not be modified for unknown aliases
    expect(msgs[0].content).toBe('@gpt4 hello');
  });

  it('works with trigger prefix before override', () => {
    const msgs = [makeMessage('@Andy @opus test')];
    const group = makeGroup();
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
    expect(msgs[0].content).toBe('@Andy test');
  });

  // Security: scheduled tasks
  it('ignores overrides for scheduled tasks', () => {
    const msgs = [makeMessage('@opus do something')];
    const group = makeGroup({ containerConfig: { model: 'haiku' } });
    const model = resolveModel(msgs, group, { isScheduledTask: true });
    expect(model).toBe('claude-haiku-4-5-20251001');
    // Content should not be modified
    expect(msgs[0].content).toBe('@opus do something');
  });

  // Security: non-main group, non-owner sender
  it('denies override from non-owner in non-main group', () => {
    const msgs = [makeMessage('@opus question', { is_from_me: false })];
    const group = makeGroup({ isMain: false });
    const model = resolveModel(msgs, group);
    expect(model).toBeUndefined();
    // Content should still be stripped (keyword removed even if denied)
    expect(msgs[0].content).toBe('question');
  });

  // Security: non-main group, owner message allowed
  it('allows override from is_from_me in non-main group', () => {
    const msgs = [makeMessage('@opus question', { is_from_me: true })];
    const group = makeGroup({ isMain: false });
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
  });

  // Security: main group allows any sender
  it('allows override from any sender in main group', () => {
    const msgs = [makeMessage('@opus question', { is_from_me: false })];
    const group = makeGroup({ isMain: true });
    const model = resolveModel(msgs, group);
    expect(model).toBe('claude-opus-4-6');
  });
});

describe('detectModelOverride', () => {
  it('detects override without modifying messages', () => {
    const msgs = [makeMessage('@opus what is 2+2')];
    const group = makeGroup();
    const model = detectModelOverride(msgs, group);
    expect(model).toBe('claude-opus-4-6');
    // Content should NOT be modified
    expect(msgs[0].content).toBe('@opus what is 2+2');
  });

  it('returns undefined when no override', () => {
    const msgs = [makeMessage('hello')];
    const group = makeGroup();
    expect(detectModelOverride(msgs, group)).toBeUndefined();
  });

  it('returns last match', () => {
    const msgs = [makeMessage('@haiku msg1'), makeMessage('@opus msg2')];
    const group = makeGroup();
    expect(detectModelOverride(msgs, group)).toBe('claude-opus-4-6');
  });

  // Security: denies non-owner in non-main group
  it('denies override from non-owner in non-main group', () => {
    const msgs = [makeMessage('@opus question', { is_from_me: false })];
    const group = makeGroup({ isMain: false });
    expect(detectModelOverride(msgs, group)).toBeUndefined();
  });

  it('allows override from is_from_me in non-main group', () => {
    const msgs = [makeMessage('@opus question', { is_from_me: true })];
    const group = makeGroup({ isMain: false });
    expect(detectModelOverride(msgs, group)).toBe('claude-opus-4-6');
  });
});

describe('stripModelOverride', () => {
  it('strips @opus keyword', () => {
    expect(stripModelOverride('@opus what is 2+2')).toBe('what is 2+2');
  });

  it('strips @haiku keyword', () => {
    expect(stripModelOverride('@haiku hello')).toBe('hello');
  });

  it('strips @sonnet keyword', () => {
    expect(stripModelOverride('@sonnet test')).toBe('test');
  });

  it('returns unchanged text when no keyword', () => {
    expect(stripModelOverride('hello world')).toBe('hello world');
  });

  it('is case insensitive', () => {
    expect(stripModelOverride('@OPUS test')).toBe('test');
  });

  it('preserves trigger prefix', () => {
    expect(stripModelOverride('@Andy @opus test')).toBe('@Andy test');
  });
});
