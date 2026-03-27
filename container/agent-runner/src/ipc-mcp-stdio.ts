/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'provision_user',
  `Register a new user/group with automatic inbox/outbox folder provisioning. Main group only.

Creates User_Library/{library_name}_Inbox and User_Library/{library_name}_Outbox on the host, registers the group, and configures container mounts (inbox=readonly, outbox=read-write).

Use available_groups.json to find the JID. The folder name must be channel-prefixed: "{channel}_{name}" (e.g., "whatsapp_kevin-fan").`,
  {
    jid: z.string().describe('The chat JID'),
    name: z.string().describe('Display name (e.g., "Kevin Fan")'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_kevin-fan")'),
    trigger: z.string().describe('Trigger word (e.g., "@LucyV")'),
    library_name: z.string().describe('Name for User_Library folders — spaces become underscores (e.g., "Kevin Fan" creates Kevin_Fan_Inbox, Kevin_Fan_Outbox)'),
    model: z.string().optional().describe('Default model for this user (opus, sonnet, haiku)'),
    requires_trigger: z.boolean().optional().describe('Whether trigger word is required (default: true)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can provision users.' }], isError: true };
    }

    const RESPONSE_TIMEOUT_MS = 15_000;
    const RESPONSE_POLL_MS = 300;
    const requestId = `provision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    writeIpcFile(TASKS_DIR, {
      type: 'provision_user',
      requestId,
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      libraryName: args.library_name,
      model: args.model,
      requiresTrigger: args.requires_trigger,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            return { content: [{ type: 'text' as const, text: `User "${args.name}" provisioned.\nInbox: ${response.inboxPath} (read-only)\nOutbox: ${response.outboxPath} (read-write)` }] };
          }
          return { content: [{ type: 'text' as const, text: `Provisioning failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }
    return { content: [{ type: 'text' as const, text: 'Provisioning timed out.' }], isError: true };
  },
);

server.tool(
  'update_group_config',
  `Update container configuration for an existing registered group. Main group only. Can add inbox/outbox mounts, change default model, or add custom mounts.`,
  {
    jid: z.string().describe('The chat JID of the registered group to update'),
    model: z.string().optional().describe('New default model (opus, sonnet, haiku)'),
    create_library_folders: z.boolean().optional().describe('If true, create User_Library inbox/outbox for this group'),
    library_name: z.string().optional().describe('Name for User_Library folders (required if create_library_folders is true)'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can update group config.' }], isError: true };
    }

    const RESPONSE_TIMEOUT_MS = 10_000;
    const RESPONSE_POLL_MS = 300;
    const requestId = `updcfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    writeIpcFile(TASKS_DIR, {
      type: 'update_group_config',
      requestId,
      jid: args.jid,
      model: args.model,
      createLibraryFolders: args.create_library_folders,
      libraryName: args.library_name,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            return { content: [{ type: 'text' as const, text: `Group config updated for ${args.jid}.` }] };
          }
          return { content: [{ type: 'text' as const, text: `Update failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }
    return { content: [{ type: 'text' as const, text: 'Update timed out.' }], isError: true };
  },
);

server.tool(
  'unregister_group',
  `Unregister a group so the agent no longer responds to messages there. Main group only. Data and folders are preserved (soft remove). The group can be re-registered later.`,
  {
    jid: z.string().describe('The chat JID of the group to unregister'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can unregister groups.' }], isError: true };
    }

    const RESPONSE_TIMEOUT_MS = 10_000;
    const RESPONSE_POLL_MS = 300;
    const requestId = `unreg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    writeIpcFile(TASKS_DIR, {
      type: 'unregister_group',
      requestId,
      jid: args.jid,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            return { content: [{ type: 'text' as const, text: `Group "${response.name}" unregistered. Data and folders are preserved.` }] };
          }
          return { content: [{ type: 'text' as const, text: `Unregister failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }
    return { content: [{ type: 'text' as const, text: 'Unregister timed out.' }], isError: true };
  },
);

server.tool(
  'send_media',
  `Send an image file to the user or group immediately while you're still running. The file must be accessible from within the container (e.g., in /workspace/group/, /workspace/extra/, or /workspace/ipc/). Supported formats: .jpg, .jpeg, .png, .gif, .webp`,
  {
    file_path: z
      .string()
      .describe(
        'Absolute container path to the image file (e.g., "/workspace/group/screenshot.png")',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption to send with the image'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'media',
      chatJid,
      containerPath: args.file_path,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Media sent.' }] };
  },
);

server.tool(
  'transcribe_audio',
  `Transcribe an audio or video file to text using whisper.cpp running on the host with hardware acceleration. Returns the transcript text.

Supported formats: .flac, .mp3, .ogg, .wav, .mp4, .m4a, .webm, .aac, .wma, .opus

The file must be accessible from within the container (e.g., in /workspace/group/, /workspace/extra/, or /workspace/project/).`,
  {
    file_path: z
      .string()
      .describe(
        'Absolute container path to the audio/video file (e.g., "/workspace/extra/icloud-inbox/recording.mp3")',
      ),
  },
  async (args) => {
    const RESPONSE_TIMEOUT_MS = 120_000;
    const RESPONSE_POLL_MS = 500;

    const requestId = `transcribe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    const data = {
      type: 'transcribe_audio',
      requestId,
      containerPath: args.file_path,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for response from host
    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(
            fs.readFileSync(responseFile, 'utf-8'),
          );
          try {
            fs.unlinkSync(responseFile);
          } catch {
            /* best effort */
          }
          if (response.status === 'success') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: response.transcript,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Transcription failed: ${response.error}`,
                },
              ],
              isError: true,
            };
          }
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error reading transcription response: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Transcription timed out after 120 seconds.',
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'send_voice_memo',
  `Generate a voice note from text using macOS text-to-speech and send it immediately as a WhatsApp voice note. The recipient will see it as a PTT (push-to-talk) audio message with a waveform. Timeout: 60 seconds.`,
  {
    text: z.string().describe('The text to convert to speech and send as a voice note'),
    voice: z.string().optional().describe('Optional macOS voice name (e.g. "Samantha", "Alex", "Karen"). Defaults to system voice.'),
  },
  async (args) => {
    const RESPONSE_TIMEOUT_MS = 60_000;
    const RESPONSE_POLL_MS = 500;

    const requestId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    const data: Record<string, string | undefined> = {
      type: 'text_to_speech',
      requestId,
      text: args.text,
      voice: args.voice || undefined,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            return { content: [{ type: 'text' as const, text: 'Voice memo sent.' }] };
          } else {
            return {
              content: [{ type: 'text' as const, text: `Voice memo failed: ${response.error}` }],
              isError: true,
            };
          }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading TTS response: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }

    return {
      content: [{ type: 'text' as const, text: 'Voice memo timed out after 60 seconds.' }],
      isError: true,
    };
  },
);

server.tool(
  'send_voice_file',
  `Send a pre-existing audio file as a WhatsApp voice note (PTT). The file must be accessible from within the container. Supported formats: .ogg, .opus, .mp3, .m4a, .aac, .wav`,
  {
    file_path: z
      .string()
      .describe('Absolute container path to the audio file (e.g., "/workspace/group/clip.ogg")'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'voice',
      chatJid,
      containerPath: args.file_path,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Voice file sent.' }] };
  },
);

server.tool(
  'edit_image',
  `Edit an image using the best available tool on the host (ImageMagick if installed, otherwise macOS sips). Input must exist in a mounted container path. Output is written to another mounted path. Timeout: 30 seconds.

Operations:
- resize: scale proportionally so longest edge <= max_dimension px
- resize_wh: resize to exact width x height (may distort)
- rotate: rotate clockwise (degrees: 90 / 180 / 270)
- flip_h: mirror horizontally
- flip_v: flip vertically
- crop: center-crop to width x height
- thumbnail: smart resize + center-crop to exact width x height (imagemagick only)
- convert: change format (jpeg / png / tiff / bmp / gif)
- grayscale: convert to black and white (imagemagick only)`,
  {
    input_path: z.string().describe('Absolute container path to source image (must exist, e.g. "/workspace/group/incoming/photo.jpg")'),
    output_path: z.string().describe('Absolute container path for output (e.g. "/workspace/group/edited/photo-small.jpg")'),
    operation: z.enum(['resize','resize_wh','rotate','flip_h','flip_v','crop','thumbnail','convert','grayscale'])
      .describe('Edit operation to perform'),
    max_dimension: z.number().optional().describe('resize: max pixels on longest edge'),
    width: z.number().optional().describe('resize_wh / crop / thumbnail: target width in pixels'),
    height: z.number().optional().describe('resize_wh / crop / thumbnail: target height in pixels'),
    degrees: z.number().optional().describe('rotate: 90, 180, or 270'),
    format: z.string().optional().describe('convert: target format (jpeg / png / tiff / bmp / gif)'),
  },
  async (args) => {
    const RESPONSE_TIMEOUT_MS = 30_000;
    const RESPONSE_POLL_MS = 300;
    const requestId = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    const opParams: Record<string, string | number> = {};
    if (args.max_dimension !== undefined) opParams.maxDimension = args.max_dimension;
    if (args.width !== undefined) opParams.width = args.width;
    if (args.height !== undefined) opParams.height = args.height;
    if (args.degrees !== undefined) opParams.degrees = args.degrees;
    if (args.format !== undefined) opParams.format = args.format;

    writeIpcFile(TASKS_DIR, {
      type: 'edit_image', requestId,
      inputPath: args.input_path, outputPath: args.output_path,
      operation: args.operation, opParams, groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            return { content: [{ type: 'text' as const, text: `Image edited (backend: ${response.backend}). Output: ${args.output_path}` }] };
          }
          return { content: [{ type: 'text' as const, text: `Edit failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }
    return { content: [{ type: 'text' as const, text: 'Image edit timed out after 30 seconds.' }], isError: true };
  },
);

server.tool(
  'list_image_backends',
  'List available image editing backends on the host and what operations each supports.',
  {},
  async () => {
    const RESPONSE_TIMEOUT_MS = 10_000;
    const RESPONSE_POLL_MS = 200;
    const requestId = `backends-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    writeIpcFile(TASKS_DIR, { type: 'list_image_backends', requestId, groupFolder, timestamp: new Date().toISOString() });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          const lines = response.backends
            .map((b: { name: string; available: boolean; ops: string[] }) =>
              `${b.available ? '✅' : '❌'} ${b.name}: ${b.available ? b.ops.join(', ') : 'not installed'}`)
            .join('\n');
          return { content: [{ type: 'text' as const, text: `Image backends:\n${lines}` }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }
    return { content: [{ type: 'text' as const, text: 'list_image_backends timed out.' }], isError: true };
  },
);

server.tool(
  'search_youtube',
  `Search YouTube for videos and return structured results. No API key needed. Returns titles, URLs, durations, channel names, view counts, and upload dates. Timeout: 15 seconds.`,
  {
    query: z.string().describe('The search query (e.g., "claude code tutorials", "typescript best practices")'),
    max_results: z.number().min(1).max(20).default(5).describe('Maximum number of results to return (1-20, default 5)'),
  },
  async (args) => {
    const RESPONSE_TIMEOUT_MS = 15_000;
    const RESPONSE_POLL_MS = 300;

    const requestId = `ytsearch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    writeIpcFile(TASKS_DIR, {
      type: 'youtube_search',
      requestId,
      query: args.query,
      maxResults: args.max_results,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            const formatted = response.results
              .map((r: { title: string; url: string; duration: string; channel: string; views: string; uploadedAt: string }, i: number) =>
                `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.duration} | ${r.channel} | ${r.views} views | ${r.uploadedAt}`)
              .join('\n\n');
            return { content: [{ type: 'text' as const, text: formatted || 'No results found.' }] };
          }
          return { content: [{ type: 'text' as const, text: `YouTube search failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }

    return { content: [{ type: 'text' as const, text: 'YouTube search timed out after 15 seconds.' }], isError: true };
  },
);

server.tool(
  'get_user_permissions',
  `Get permissions and capabilities for all registered NanoClaw users. Shows each user's name, role (main/regular), default model, whether they can override models, cross-group messaging, task management scope, and mounted directories. Main group sees all users; other groups see only themselves.`,
  {},
  async () => {
    const permissionsFile = path.join(IPC_DIR, 'user_permissions.json');

    try {
      if (!fs.existsSync(permissionsFile)) {
        return { content: [{ type: 'text' as const, text: 'No permissions data available.' }] };
      }

      const data = JSON.parse(fs.readFileSync(permissionsFile, 'utf-8'));
      const users = data.users || [];

      if (users.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No registered users found.' }] };
      }

      const formatted = users.map((u: {
        name: string;
        folder: string;
        jid: string;
        isMain: boolean;
        requiresTrigger: boolean;
        defaultModel: string | undefined;
        modelOverrideAllowed: boolean;
        crossGroupMessaging: boolean;
        crossGroupTaskManagement: boolean;
        groupRegistration: boolean;
        additionalMounts: string[];
      }) => {
        const lines = [
          `• ${u.name} (${u.isMain ? 'MAIN' : 'regular'})`,
          `  Folder: ${u.folder}`,
        ];
        if (u.jid) lines.push(`  JID: ${u.jid}`);
        lines.push(`  Trigger required: ${u.requiresTrigger ? 'yes' : 'no'}`);
        lines.push(`  Default model: ${u.defaultModel || 'sonnet (system default)'}`);
        lines.push(`  Model override (@opus/@haiku): ${u.modelOverrideAllowed ? 'yes' : 'no'}`);
        lines.push(`  Cross-group messaging: ${u.crossGroupMessaging ? 'yes' : 'no'}`);
        lines.push(`  Cross-group task management: ${u.crossGroupTaskManagement ? 'yes' : 'no'}`);
        lines.push(`  Group registration: ${u.groupRegistration ? 'yes' : 'no'}`);
        if (u.additionalMounts.length > 0) {
          lines.push(`  Additional mounts: ${u.additionalMounts.join(', ')}`);
        }
        return lines.join('\n');
      }).join('\n\n');

      return { content: [{ type: 'text' as const, text: `User Permissions:\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading permissions: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'git_commit_and_push',
  `Commit staged changes and push to the remote repository. Main group only.

This tool runs on the HOST (not inside the container), so it has full access to the git repo and credentials. The container's project mount is read-only, so you cannot run git commands directly — use this tool instead.

The host will:
1. Run \`git add .\` in the project directory (respects .gitignore)
2. Create a commit with the provided message
3. Push to the remote

Returns the commit hash, files changed count, and push result.`,
  {
    message: z.string().describe('Commit message. Keep it concise (1-2 lines). Do NOT include Co-Authored-By — the host adds that automatically.'),
    files: z.array(z.string()).optional().describe('Specific files to stage (relative to project root). If omitted, stages all changes (git add .).'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can commit and push.' }], isError: true };
    }

    const RESPONSE_TIMEOUT_MS = 90_000;
    const RESPONSE_POLL_MS = 500;
    const requestId = `git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });

    writeIpcFile(TASKS_DIR, {
      type: 'git_commit_and_push',
      requestId,
      message: args.message,
      files: args.files,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(responsesDir, `${requestId}.json`);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(responseFile)) {
        try {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          try { fs.unlinkSync(responseFile); } catch { /* best effort */ }
          if (response.status === 'success') {
            return { content: [{ type: 'text' as const, text: response.summary }] };
          }
          return { content: [{ type: 'text' as const, text: `Git operation failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_MS));
    }
    return { content: [{ type: 'text' as const, text: 'Git operation timed out (30s).' }], isError: true };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
