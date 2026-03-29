import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { imageEditor } from './image-editor.js';
import { transcribeAudioFile } from './transcription.js';
import { searchYouTube } from './youtube-search.js';
import { ContainerConfig, RegisteredGroup } from './types.js';

function sanitizeLibraryName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function resolveImageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_TYPES[ext] ?? null;
}

const VOICE_AUDIO_EXTS = new Set([
  '.ogg',
  '.opus',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
]);

function isValidVoiceFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VOICE_AUDIO_EXTS.has(ext);
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMedia: (jid: string, hostPath: string, caption?: string) => Promise<void>;
  sendVoice: (jid: string, hostPath: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  updateGroupConfig: (
    jid: string,
    updates: { containerConfig?: import('./types.js').ContainerConfig },
  ) => void;
  unregisterGroup: (jid: string) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'voice' &&
                data.chatJid &&
                data.containerPath
              ) {
                if (!isValidVoiceFile(data.containerPath as string)) {
                  logger.warn(
                    { containerPath: data.containerPath, sourceGroup },
                    'IPC voice: unsupported file extension',
                  );
                } else {
                  const targetGroup = registeredGroups[data.chatJid as string];
                  const isAuthorized =
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup);
                  if (!isAuthorized) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC voice attempt blocked',
                    );
                  } else {
                    const hostPath = resolveContainerPath(
                      data.containerPath as string,
                      sourceGroup,
                      isMain,
                      deps,
                    );
                    if (!hostPath) {
                      logger.warn(
                        { containerPath: data.containerPath, sourceGroup },
                        'IPC voice: path resolution failed',
                      );
                    } else {
                      await deps.sendVoice(data.chatJid as string, hostPath);
                      logger.info(
                        { chatJid: data.chatJid, hostPath, sourceGroup },
                        'IPC voice file sent',
                      );
                    }
                  }
                }
              } else if (
                data.type === 'media' &&
                data.chatJid &&
                data.containerPath
              ) {
                const mimeType = resolveImageMimeType(
                  data.containerPath as string,
                );
                if (!mimeType) {
                  logger.warn(
                    { containerPath: data.containerPath, sourceGroup },
                    'IPC media: unsupported file extension',
                  );
                } else {
                  const targetGroup = registeredGroups[data.chatJid as string];
                  const isAuthorized =
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup);
                  if (!isAuthorized) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC media attempt blocked',
                    );
                  } else {
                    const hostPath = resolveContainerPath(
                      data.containerPath as string,
                      sourceGroup,
                      isMain,
                      deps,
                    );
                    if (!hostPath) {
                      logger.warn(
                        { containerPath: data.containerPath, sourceGroup },
                        'IPC media: path resolution failed',
                      );
                    } else {
                      await deps.sendMedia(
                        data.chatJid as string,
                        hostPath,
                        data.caption as string | undefined,
                      );
                      logger.info(
                        { chatJid: data.chatJid, hostPath, sourceGroup },
                        'IPC media sent',
                      );
                    }
                  }
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/**
 * Translate a container-side path to the real host path using mount mappings.
 * Returns null if the path cannot be resolved safely (traversal, unmounted, etc.)
 */
function resolveContainerPath(
  containerPath: string,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): string | null {
  if (containerPath.includes('..')) return null;

  const registeredGroups = deps.registeredGroups();
  const group = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  );
  if (!group) return null;

  const projectRoot = process.cwd();
  const mappings: Array<{ containerPrefix: string; hostPath: string }> = [];

  // Group folder
  const groupDir = resolveGroupFolderPath(sourceGroup);
  mappings.push({ containerPrefix: '/workspace/group', hostPath: groupDir });

  // Project root (main only)
  if (isMain) {
    mappings.push({
      containerPrefix: '/workspace/project',
      hostPath: projectRoot,
    });
  }

  // Global directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mappings.push({
      containerPrefix: '/workspace/global',
      hostPath: globalDir,
    });
  }

  // Additional mounts
  if (group.containerConfig?.additionalMounts) {
    const validated = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const m of validated) {
      mappings.push({ containerPrefix: m.containerPath, hostPath: m.hostPath });
    }
  }

  // IPC directory
  const groupIpcDir = resolveGroupIpcPath(sourceGroup);
  mappings.push({ containerPrefix: '/workspace/ipc', hostPath: groupIpcDir });

  // Sort by prefix length descending (most specific first)
  mappings.sort((a, b) => b.containerPrefix.length - a.containerPrefix.length);

  for (const { containerPrefix, hostPath } of mappings) {
    if (
      containerPath === containerPrefix ||
      containerPath.startsWith(containerPrefix + '/')
    ) {
      const relativePath = containerPath.slice(containerPrefix.length);
      const resolved = path.resolve(hostPath, '.' + relativePath);

      // Verify resolved path is within the host mount (catches symlink escapes)
      let realResolved: string;
      try {
        realResolved = fs.realpathSync(resolved);
      } catch {
        return null; // file doesn't exist
      }

      let realHost: string;
      try {
        realHost = fs.realpathSync(hostPath);
      } catch {
        return null;
      }

      if (
        realResolved !== realHost &&
        !realResolved.startsWith(realHost + '/')
      ) {
        return null; // symlink escape
      }

      return realResolved;
    }
  }

  return null;
}

/**
 * Like resolveContainerPath but for output files that don't exist yet.
 * Resolves the parent directory (must exist) then appends the safe basename.
 */
function resolveContainerOutputPath(
  containerPath: string,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): string | null {
  if (containerPath.includes('..')) return null;
  const basename = path.basename(containerPath);
  if (!basename || basename.includes('/')) return null;
  const parentContainer = path.dirname(containerPath);

  const registeredGroups = deps.registeredGroups();
  const group = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  );
  if (!group) return null;

  const projectRoot = process.cwd();
  const mappings: Array<{ containerPrefix: string; hostPath: string }> = [];
  const groupDir = resolveGroupFolderPath(sourceGroup);
  mappings.push({ containerPrefix: '/workspace/group', hostPath: groupDir });
  if (isMain)
    mappings.push({
      containerPrefix: '/workspace/project',
      hostPath: projectRoot,
    });
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir))
    mappings.push({
      containerPrefix: '/workspace/global',
      hostPath: globalDir,
    });
  if (group.containerConfig?.additionalMounts) {
    const validated = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const m of validated)
      mappings.push({ containerPrefix: m.containerPath, hostPath: m.hostPath });
  }
  const groupIpcDir = resolveGroupIpcPath(sourceGroup);
  mappings.push({ containerPrefix: '/workspace/ipc', hostPath: groupIpcDir });
  mappings.sort((a, b) => b.containerPrefix.length - a.containerPrefix.length);

  for (const { containerPrefix, hostPath } of mappings) {
    if (
      parentContainer === containerPrefix ||
      parentContainer.startsWith(containerPrefix + '/')
    ) {
      const relParent = parentContainer.slice(containerPrefix.length);
      const hostParent = path.resolve(hostPath, '.' + relParent);
      let realHostParent: string;
      try {
        realHostParent = fs.realpathSync(hostParent);
      } catch {
        return null;
      }
      let realHost: string;
      try {
        realHost = fs.realpathSync(hostPath);
      } catch {
        return null;
      }
      if (
        realHostParent !== realHost &&
        !realHostParent.startsWith(realHost + '/')
      )
        return null;
      return path.join(realHostParent, basename);
    }
  }
  return null;
}

/**
 * Write a JSON response file atomically for IPC request-response pattern.
 */
function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  response: object,
): void {
  const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const safeId = path.basename(requestId);
  const responseFile = path.join(responsesDir, `${safeId}.json`);
  const tempFile = `${responseFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(response, null, 2));
  fs.renameSync(tempFile, responseFile);
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For transcribe_audio / text_to_speech / edit_image
    requestId?: string;
    containerPath?: string;
    text?: string;
    voice?: string;
    inputPath?: string;
    outputPath?: string;
    operation?: string;
    opParams?: Record<string, string | number>;
    // For youtube_search
    query?: string;
    maxResults?: number;
    // For git_commit_and_push
    message?: string;
    files?: string[];
    // For register_group / provision_user / update_group_config / unregister_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    libraryName?: string;
    model?: string;
    createLibraryFolders?: boolean;
    additionalMounts?: Array<{
      hostPath: string;
      containerPath?: string;
      readonly?: boolean;
    }>;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'provision_user': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized provision_user attempt blocked',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Unauthorized',
          });
        break;
      }
      if (
        !data.requestId ||
        !data.jid ||
        !data.name ||
        !data.folder ||
        !data.trigger ||
        !data.libraryName
      ) {
        logger.warn(
          { data },
          'Invalid provision_user request - missing required fields',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Missing required fields',
          });
        break;
      }
      if (!isValidGroupFolder(data.folder)) {
        logger.warn(
          { sourceGroup, folder: data.folder },
          'Invalid provision_user request - unsafe folder name',
        );
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: `Invalid folder name: ${data.folder}`,
        });
        break;
      }
      try {
        const sanitized = sanitizeLibraryName(data.libraryName);
        if (!sanitized) {
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Library name is empty after sanitization',
          });
          break;
        }
        const projectRoot = process.cwd();
        const inboxPath = path.join(
          projectRoot,
          'User_Library',
          `${sanitized}_Inbox`,
        );
        const outboxPath = path.join(
          projectRoot,
          'User_Library',
          `${sanitized}_Outbox`,
        );

        fs.mkdirSync(inboxPath, { recursive: true });
        fs.mkdirSync(outboxPath, { recursive: true });

        const containerConfig: ContainerConfig = {
          additionalMounts: [
            {
              hostPath: inboxPath,
              containerPath: `${sanitized}_Inbox`,
              readonly: true,
            },
            {
              hostPath: outboxPath,
              containerPath: `${sanitized}_Outbox`,
              readonly: false,
            },
          ],
          model: data.model || undefined,
        };

        // Defense in depth: never set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig,
          requiresTrigger: data.requiresTrigger !== false,
        });

        logger.info(
          { jid: data.jid, name: data.name, libraryName: sanitized },
          'User provisioned',
        );
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'success',
          inboxPath: `/workspace/extra/${sanitized}_Inbox`,
          outboxPath: `/workspace/extra/${sanitized}_Outbox`,
        });
      } catch (err) {
        logger.error({ err, data }, 'Failed to provision user');
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'update_group_config': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized update_group_config attempt blocked',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Unauthorized',
          });
        break;
      }
      if (!data.requestId || !data.jid) {
        logger.warn(
          { data },
          'Invalid update_group_config request - missing required fields',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Missing jid',
          });
        break;
      }
      const targetGroup = deps.registeredGroups()[data.jid];
      if (!targetGroup) {
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: `Group not registered: ${data.jid}`,
        });
        break;
      }
      try {
        const updates: { containerConfig?: ContainerConfig } = {};
        const newMounts: Array<{
          hostPath: string;
          containerPath?: string;
          readonly?: boolean;
        }> = [];

        // Create library folders if requested
        if (data.createLibraryFolders && data.libraryName) {
          const sanitized = sanitizeLibraryName(data.libraryName);
          if (!sanitized) {
            writeIpcResponse(sourceGroup, data.requestId, {
              status: 'error',
              error: 'Library name is empty after sanitization',
            });
            break;
          }
          const projectRoot = process.cwd();
          const inboxPath = path.join(
            projectRoot,
            'User_Library',
            `${sanitized}_Inbox`,
          );
          const outboxPath = path.join(
            projectRoot,
            'User_Library',
            `${sanitized}_Outbox`,
          );
          fs.mkdirSync(inboxPath, { recursive: true });
          fs.mkdirSync(outboxPath, { recursive: true });
          newMounts.push(
            {
              hostPath: inboxPath,
              containerPath: `${sanitized}_Inbox`,
              readonly: true,
            },
            {
              hostPath: outboxPath,
              containerPath: `${sanitized}_Outbox`,
              readonly: false,
            },
          );
        }

        // Append any explicitly provided mounts
        if (data.additionalMounts && Array.isArray(data.additionalMounts)) {
          newMounts.push(...data.additionalMounts);
        }

        updates.containerConfig = {
          additionalMounts: newMounts.length > 0 ? newMounts : undefined,
          model: data.model || undefined,
        };

        deps.updateGroupConfig(data.jid, updates);
        logger.info(
          { jid: data.jid, name: targetGroup.name },
          'Group config updated via IPC',
        );
        writeIpcResponse(sourceGroup, data.requestId, { status: 'success' });
      } catch (err) {
        logger.error({ err, data }, 'Failed to update group config');
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'unregister_group': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized unregister_group attempt blocked',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Unauthorized',
          });
        break;
      }
      if (!data.requestId || !data.jid) {
        logger.warn(
          { data },
          'Invalid unregister_group request - missing required fields',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Missing jid',
          });
        break;
      }
      const groupToRemove = deps.registeredGroups()[data.jid];
      if (!groupToRemove) {
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: `Group not registered: ${data.jid}`,
        });
        break;
      }
      if (groupToRemove.isMain) {
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: 'Cannot unregister the main group',
        });
        break;
      }
      try {
        deps.unregisterGroup(data.jid);
        logger.info(
          { jid: data.jid, name: groupToRemove.name },
          'Group unregistered via IPC',
        );
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'success',
          name: groupToRemove.name,
        });
      } catch (err) {
        logger.error({ err, data }, 'Failed to unregister group');
        writeIpcResponse(sourceGroup, data.requestId, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'transcribe_audio':
      if (!data.requestId || !data.containerPath) {
        logger.warn(
          { sourceGroup },
          'Invalid transcribe_audio request - missing requestId or containerPath',
        );
        break;
      }
      {
        const startTime = Date.now();
        const hostPath = resolveContainerPath(
          data.containerPath,
          sourceGroup,
          isMain,
          deps,
        );

        if (!hostPath) {
          writeIpcResponse(sourceGroup, data.requestId, {
            requestId: data.requestId,
            status: 'error',
            error: `Cannot resolve path "${data.containerPath}" - file not found or not in a mounted directory`,
          });
          logger.warn(
            { containerPath: data.containerPath, sourceGroup },
            'Transcription path resolution failed',
          );
          break;
        }

        logger.info(
          { containerPath: data.containerPath, hostPath, sourceGroup },
          'Starting host-side transcription',
        );

        const result = await transcribeAudioFile(hostPath);
        const durationMs = Date.now() - startTime;

        if ('transcript' in result) {
          writeIpcResponse(sourceGroup, data.requestId, {
            requestId: data.requestId,
            status: 'success',
            transcript: result.transcript,
            duration_ms: durationMs,
          });
          logger.info(
            {
              sourceGroup,
              chars: result.transcript.length,
              durationMs,
            },
            'Host-side transcription completed',
          );
        } else {
          writeIpcResponse(sourceGroup, data.requestId, {
            requestId: data.requestId,
            status: 'error',
            error: result.error,
          });
          logger.warn(
            { sourceGroup, error: result.error },
            'Host-side transcription failed',
          );
        }
      }
      break;

    case 'text_to_speech':
      if (!data.requestId || !data.text || !data.chatJid) {
        logger.warn(
          { sourceGroup },
          'Invalid text_to_speech request - missing fields',
        );
        break;
      }
      {
        const ttsId = path.basename(data.requestId as string);
        const ttsText = data.text as string;
        const ttsChatJid = data.chatJid as string;
        const ttsVoice = data.voice as string | undefined;

        const targetGroup = registeredGroups[ttsChatJid];
        const isAuthorized =
          isMain || (targetGroup && targetGroup.folder === sourceGroup);
        if (!isAuthorized) {
          logger.warn(
            { sourceGroup, ttsChatJid },
            'Unauthorized text_to_speech attempt blocked',
          );
          writeIpcResponse(sourceGroup, ttsId, {
            status: 'error',
            error: 'Unauthorized',
          });
          break;
        }

        const tmpDir = path.join('/tmp', `nanoclaw-tts-${ttsId}`);
        const aiffPath = path.join(tmpDir, 'out.aiff');
        const oggPath = path.join(tmpDir, 'out.ogg');

        try {
          fs.mkdirSync(tmpDir, { recursive: true });

          // Run say (macOS TTS) — use execFile to avoid shell injection
          const { execFile } = await import('child_process');
          const { promisify } = await import('util');
          const execFileAsync = promisify(execFile);

          const sayArgs: string[] = ['-o', aiffPath];
          if (ttsVoice) sayArgs.push('-v', ttsVoice);
          sayArgs.push(ttsText);
          await execFileAsync('/usr/bin/say', sayArgs);

          // Convert AIFF → OGG Opus via ffmpeg
          await execFileAsync('ffmpeg', [
            '-i',
            aiffPath,
            '-c:a',
            'libopus',
            '-ar',
            '48000',
            '-b:a',
            '32k',
            oggPath,
            '-y',
          ]);

          // Send as PTT voice note
          await deps.sendVoice(ttsChatJid, oggPath);

          writeIpcResponse(sourceGroup, ttsId, { status: 'success' });
          logger.info(
            { sourceGroup, chars: ttsText.length },
            'TTS voice memo sent',
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn({ sourceGroup, err }, 'TTS voice memo failed');
          writeIpcResponse(sourceGroup, ttsId, {
            status: 'error',
            error: errMsg,
          });
        } finally {
          // Clean up temp files
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      }
      break;

    case 'edit_image':
      if (
        !data.requestId ||
        !data.inputPath ||
        !data.outputPath ||
        !data.operation
      ) {
        logger.warn(
          { sourceGroup },
          'Invalid edit_image request - missing fields',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Missing required fields',
          });
        break;
      }
      {
        const editId = data.requestId as string;
        const hostInput = resolveContainerPath(
          data.inputPath as string,
          sourceGroup,
          isMain,
          deps,
        );
        if (!hostInput) {
          writeIpcResponse(sourceGroup, editId, {
            status: 'error',
            error: `Cannot resolve input path "${data.inputPath}"`,
          });
          break;
        }
        const hostOutput = resolveContainerOutputPath(
          data.outputPath as string,
          sourceGroup,
          isMain,
          deps,
        );
        if (!hostOutput) {
          writeIpcResponse(sourceGroup, editId, {
            status: 'error',
            error: `Cannot resolve output path "${data.outputPath}"`,
          });
          break;
        }
        const params = (data.opParams || {}) as Record<string, string | number>;
        const result = await imageEditor.edit({
          inputPath: hostInput,
          outputPath: hostOutput,
          operation: data.operation as any,
          maxDimension:
            typeof params.maxDimension === 'number'
              ? params.maxDimension
              : undefined,
          width: typeof params.width === 'number' ? params.width : undefined,
          height: typeof params.height === 'number' ? params.height : undefined,
          degrees:
            typeof params.degrees === 'number' ? params.degrees : undefined,
          format: typeof params.format === 'string' ? params.format : undefined,
        });
        if (result.ok) {
          writeIpcResponse(sourceGroup, editId, {
            status: 'success',
            outputPath: data.outputPath,
            backend: result.backend,
          });
          logger.info(
            { sourceGroup, operation: data.operation, backend: result.backend },
            'Image edited via IPC',
          );
        } else {
          writeIpcResponse(sourceGroup, editId, {
            status: 'error',
            error: result.error,
          });
          logger.warn(
            { sourceGroup, operation: data.operation, error: result.error },
            'Image edit failed',
          );
        }
      }
      break;

    case 'list_image_backends':
      if (!data.requestId) break;
      {
        const backends = await imageEditor.listBackends();
        writeIpcResponse(sourceGroup, data.requestId as string, {
          status: 'success',
          backends,
        });
      }
      break;

    case 'youtube_search':
      if (!data.requestId || !data.query) {
        logger.warn(
          { sourceGroup },
          'Invalid youtube_search request - missing requestId or query',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Missing query',
          });
        break;
      }
      {
        const result = await searchYouTube(data.query, data.maxResults ?? 5);
        if ('results' in result) {
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'success',
            results: result.results,
          });
        } else {
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: result.error,
          });
        }
      }
      break;

    case 'git_commit_and_push': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Non-main group attempted git_commit_and_push',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Unauthorized — main group only',
          });
        break;
      }
      if (!data.requestId || !data.message) {
        logger.warn(
          { sourceGroup },
          'Invalid git_commit_and_push — missing requestId or message',
        );
        if (data.requestId)
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: 'Missing commit message',
          });
        break;
      }
      {
        const projectRoot = process.cwd();
        const { execSync } = await import('child_process');
        // Prepend the directory containing the current node binary to PATH
        // so git hooks (husky) can find npm/node. launchd strips nvm paths.
        const nodeDir = path.dirname(process.execPath);
        const gitEnv = {
          ...process.env,
          PATH: `${nodeDir}:${process.env.PATH || ''}`,
        };
        // 60s timeout to allow pre-commit hooks (format, lint) to complete.
        const execGit = (cmd: string) =>
          execSync(cmd, {
            cwd: projectRoot,
            encoding: 'utf-8',
            timeout: 60_000,
            env: gitEnv,
          }).trim();

        try {
          // Stage files
          if (
            data.files &&
            Array.isArray(data.files) &&
            data.files.length > 0
          ) {
            // Validate: no path traversal
            for (const f of data.files) {
              if (f.includes('..') || path.isAbsolute(f)) {
                writeIpcResponse(sourceGroup, data.requestId, {
                  status: 'error',
                  error: `Invalid file path: ${f}`,
                });
                break;
              }
            }
            const safeFiles = (data.files as string[])
              .map((f: string) => `"${f.replace(/"/g, '\\"')}"`)
              .join(' ');
            execGit(`git add ${safeFiles}`);
          } else {
            execGit('git add .');
          }

          // Check if there's anything to commit
          const status = execGit('git status --porcelain');
          if (!status) {
            writeIpcResponse(sourceGroup, data.requestId, {
              status: 'success',
              summary: 'Nothing to commit — working tree clean.',
            });
            break;
          }

          // Commit
          const commitMsg = `${data.message}\n\nCo-Authored-By: NanoClaw Agent <noreply@nanoclaw.local>`;
          fs.writeFileSync(
            path.join(projectRoot, '.git', 'COMMIT_MSG_TMP'),
            commitMsg,
          );
          execGit('git commit -F .git/COMMIT_MSG_TMP');
          try {
            fs.unlinkSync(path.join(projectRoot, '.git', 'COMMIT_MSG_TMP'));
          } catch {
            /* best effort */
          }

          const commitHash = execGit('git rev-parse --short HEAD');
          const diffStat = execGit('git diff --stat HEAD~1');

          // Push (skip if no remote configured)
          let pushResult: string;
          try {
            pushResult = execGit('git push origin main');
            pushResult = 'Pushed to origin remote.';
          } catch (pushErr) {
            pushResult = `Push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`;
          }

          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'success',
            summary: `Committed ${commitHash}.\n\n${diffStat}\n\n${pushResult}`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ err: errMsg }, 'git_commit_and_push failed');
          writeIpcResponse(sourceGroup, data.requestId, {
            status: 'error',
            error: errMsg,
          });
        }
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
