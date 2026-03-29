import fs from 'fs';
import path from 'path';

import { execFile } from 'child_process';

import {
  ASSISTANT_NAME,
  BACKUP_INTERVAL_MS,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  MODEL_ALIASES,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writePermissionsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteRegisteredGroup,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function updateGroupConfig(
  jid: string,
  updates: { containerConfig?: import('./types.js').ContainerConfig },
): void {
  const group = registeredGroups[jid];
  if (!group) {
    logger.warn({ jid }, 'Cannot update config: group not registered');
    return;
  }

  if (updates.containerConfig) {
    const existingMounts = group.containerConfig?.additionalMounts || [];
    const newMounts = updates.containerConfig.additionalMounts || [];

    group.containerConfig = {
      ...group.containerConfig,
      ...updates.containerConfig,
      additionalMounts: [...existingMounts, ...newMounts],
    };
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);
  logger.info({ jid, name: group.name }, 'Group config updated');
}

function unregisterGroup(jid: string): void {
  const group = registeredGroups[jid];
  if (!group) {
    logger.warn({ jid }, 'Cannot unregister: group not found');
    return;
  }
  if (group.isMain) {
    logger.warn({ jid, name: group.name }, 'Cannot unregister the main group');
    return;
  }

  delete registeredGroups[jid];
  deleteRegisteredGroup(jid);
  logger.info({ jid, name: group.name }, 'Group unregistered (data preserved)');
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

// Pattern to detect @opus, @sonnet, @haiku override in message content
const MODEL_OVERRIDE_PATTERN = /@(opus|sonnet|haiku)\b\s*/i;

/**
 * Resolve which model to use for this invocation.
 * Priority: user override keyword in any message (last match wins) → group config → undefined (SDK default).
 * If a keyword override is found, it is stripped from the message content.
 *
 * Security: model overrides are only allowed from the main group or from
 * is_from_me messages. Other senders in non-main groups cannot escalate to
 * expensive models.
 */
/** @internal — exported for testing */
export function resolveModel(
  messages: NewMessage[],
  group: RegisteredGroup,
  opts?: { isScheduledTask?: boolean },
): string | undefined {
  if (messages.length === 0) return resolveGroupModel(group);

  // Scheduled tasks use group default — don't parse overrides from task prompts
  if (opts?.isScheduledTask) return resolveGroupModel(group);

  const isMain = group.isMain === true;

  // Scan all messages for override; last match wins
  let resolvedModel: string | undefined;
  for (const msg of messages) {
    const match = msg.content.match(MODEL_OVERRIDE_PATTERN);
    if (match) {
      const alias = match[1].toLowerCase();
      const model = MODEL_ALIASES[alias];
      if (model) {
        // Security: only allow overrides from main group or own messages
        if (!isMain && !msg.is_from_me) {
          logger.warn(
            { alias, group: group.name, sender: msg.sender },
            'Model override denied: only allowed from main group or own messages',
          );
          // Strip the keyword anyway so agent doesn't see it
          msg.content = msg.content.replace(MODEL_OVERRIDE_PATTERN, '').trim();
          continue;
        }
        msg.content = msg.content.replace(MODEL_OVERRIDE_PATTERN, '').trim();
        resolvedModel = model;
        logger.info(
          { model, alias, group: group.name },
          'Model override from message',
        );
      } else {
        logger.warn(
          { alias, group: group.name },
          'Unknown model alias in override, ignoring',
        );
      }
    }
  }

  return resolvedModel || resolveGroupModel(group);
}

function resolveGroupModel(group: RegisteredGroup): string | undefined {
  const groupModel = group.containerConfig?.model;
  if (!groupModel) return undefined;
  return MODEL_ALIASES[groupModel.toLowerCase()] || groupModel;
}

/**
 * Detect a model override in messages without modifying them.
 * Used in the piping path to check if a model swap is needed.
 * Returns the resolved model ID, or undefined if no override found.
 * Respects the same security constraints as resolveModel.
 */
/** @internal — exported for testing */
export function detectModelOverride(
  messages: NewMessage[],
  group: RegisteredGroup,
): string | undefined {
  const isMain = group.isMain === true;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const match = msg.content.match(MODEL_OVERRIDE_PATTERN);
    if (match) {
      const alias = match[1].toLowerCase();
      const model = MODEL_ALIASES[alias];
      if (model && (isMain || msg.is_from_me)) {
        return model;
      }
    }
  }
  return undefined;
}

/**
 * Strip model override keywords from message text.
 * Returns the stripped text.
 */
/** @internal — exported for testing */
export function stripModelOverride(text: string): string {
  return text.replace(MODEL_OVERRIDE_PATTERN, '').trim();
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Resolve model before formatting (may strip @model keyword from last message)
  const model = resolveModel(missedMessages, group);

  // Track model in queue so piping path can detect model swap requests
  queue.setModel(chatJid, model);

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Extract sender from the last message (the one that triggered the agent)
  const lastMessage = missedMessages[missedMessages.length - 1];
  const sender = lastMessage.sender;
  const senderName = lastMessage.sender_name;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      model: model || 'default',
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    sender,
    senderName,
    model,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  sender?: string,
  senderName?: string,
  model?: string,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update permissions snapshot
  writePermissionsSnapshot(
    group.folder,
    isMain,
    Object.entries(registeredGroups).map(([jid, g]) => ({ jid, group: g })),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        sender,
        senderName,
        model,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Check for model override in the incoming messages
          const requestedModel = detectModelOverride(messagesToSend, group);
          const currentModel = queue.getModel(chatJid);

          // If a different model is requested and container is idle, swap it
          if (
            requestedModel &&
            requestedModel !== currentModel &&
            queue.isIdle(chatJid)
          ) {
            logger.info(
              {
                chatJid,
                currentModel: currentModel || 'default',
                requestedModel,
              },
              'Model swap: stopping idle container for model change',
            );
            // Close the idle container — messages will be re-fetched from DB
            // when the new container spawns via enqueueMessageCheck
            queue.requestModelSwap(chatJid);
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          // Strip model override keywords before formatting
          for (const msg of messagesToSend) {
            msg.content = stripModelOverride(msg.content);
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function ensureContainerSystemRunning(): Promise<void> {
  await ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function runBackup(): void {
  const script = path.join(process.cwd(), 'scripts', 'backup.sh');
  execFile('bash', [script], (err, stdout, stderr) => {
    if (err) logger.error({ err, stderr }, 'Backup failed');
    else logger.info('Scheduled backup completed');
  });
}

function startBackupScheduler(): void {
  const BACKUP_STARTUP_DELAY_MS = 5 * 60 * 1000;
  setTimeout(() => {
    runBackup();
    setInterval(runBackup, BACKUP_INTERVAL_MS);
  }, BACKUP_STARTUP_DELAY_MS);
}

async function main(): Promise<void> {
  await ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendMedia: async (jid, hostPath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel || !channel.sendMedia) {
        logger.warn({ jid }, 'Channel does not support sendMedia');
        return;
      }
      await channel.sendMedia(jid, hostPath, caption);
    },
    sendVoice: async (jid, hostPath) => {
      const channel = findChannel(channels, jid);
      if (!channel || !channel.sendVoice) {
        logger.warn({ jid }, 'Channel does not support sendVoice');
        return;
      }
      await channel.sendVoice(jid, hostPath);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    updateGroupConfig,
    unregisterGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startBackupScheduler();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
