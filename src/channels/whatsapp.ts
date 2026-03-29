import { exec } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// Create proxy agent from environment if available
const proxyUrl =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY;
const waProxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

/**
 * Fetch the latest WhatsApp Web client revision from sw.js via the proxy.
 * Baileys' fetchLatestWaWebVersion uses Node's fetch which ignores HTTP_PROXY.
 */
function fetchVersionViaProxy(): Promise<[number, number, number] | undefined> {
  return new Promise((resolve) => {
    const req = https.request(
      'https://web.whatsapp.com/sw.js',
      { agent: waProxyAgent },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          const match = data.match(/client_revision[^0-9]*(\d+)/);
          if (match) {
            resolve([2, 3000, parseInt(match[1], 10)]);
          } else {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

async function fetchWaVersion(): Promise<[number, number, number] | undefined> {
  if (waProxyAgent) {
    return fetchVersionViaProxy();
  }
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
    version: undefined,
  }));
  return version;
}

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';

import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const version = await fetchWaVersion();
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
      agent: waProxyAgent,
      fetchAgent: waProxyAgent,
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable
          const chatJid = await this.translateJid(rawJid);

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // PDF attachment handling
            if (normalized?.documentMessage?.mimetype === 'application/pdf') {
              try {
                // Helper: attempt download with reuploadRequest so Baileys can
                // refresh expired CDN URLs (returns 404 if URL has expired).
                const tryDownload = () =>
                  downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger, reuploadRequest: this.sock.updateMediaMessage },
                  );

                let buffer: Buffer | null = null;
                try {
                  buffer = (await tryDownload()) as Buffer;
                } catch (firstErr: any) {
                  // One retry after a short delay in case of transient CDN issue
                  logger.warn(
                    { err: firstErr, jid: chatJid },
                    'PDF download failed, retrying in 2s...',
                  );
                  await new Promise((r) => setTimeout(r, 2000));
                  buffer = (await tryDownload()) as Buffer;
                }

                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const attachDir = path.join(groupDir, 'attachments');
                fs.mkdirSync(attachDir, { recursive: true });
                const filename = path.basename(
                  normalized.documentMessage.fileName ||
                    `doc-${Date.now()}.pdf`,
                );
                const filePath = path.join(attachDir, filename);
                fs.writeFileSync(filePath, buffer);
                const sizeKB = Math.round(buffer.length / 1024);
                const pdfRef = `[PDF: attachments/${filename} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${filename}`;
                const caption = normalized.documentMessage.caption || '';
                content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;
                logger.info(
                  { jid: chatJid, filename },
                  'Downloaded PDF attachment',
                );
              } catch (err) {
                logger.warn(
                  { err, jid: chatJid },
                  'Failed to download PDF attachment after retry',
                );
                // Surface failure to agent so it can ask user to resend
                content = '[PDF - download failed, please resend the file]';
              }
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            // but allow voice messages through for transcription, and imageMessages for download
            if (!content && !isVoiceMessage(msg) && !normalized.imageMessage)
              continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            // For media messages (voice, image, document) sent by the bot in shared
            // number mode, there is no text prefix — use fromMe as the signal instead,
            // since the bot is the only process sending outbound media on this session.
            const isOutboundMedia =
              fromMe &&
              (isVoiceMessage(msg) ||
                !!normalized.imageMessage ||
                !!normalized.documentMessage);
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`) || isOutboundMedia;

            // Download and save incoming images
            let finalContent = content;
            if (normalized.imageMessage) {
              try {
                const group = groups[chatJid];
                const incomingDir = path.join(
                  GROUPS_DIR,
                  group.folder,
                  'incoming',
                );
                fs.mkdirSync(incomingDir, { recursive: true });
                const ext = (normalized.imageMessage.mimetype || '').includes(
                  'png',
                )
                  ? 'png'
                  : 'jpg';
                const safeId = (msg.key.id || 'img')
                  .replace(/[^a-zA-Z0-9_-]/g, '')
                  .slice(0, 12);
                const filename = `${Date.now()}-${safeId}.${ext}`;
                const filepath = path.join(incomingDir, filename);
                const buffer = await downloadMediaMessage(
                  msg,
                  'buffer',
                  {},
                  { logger, reuploadRequest: this.sock.updateMediaMessage },
                );
                fs.writeFileSync(filepath, buffer as Buffer);
                const containerPath = `/workspace/group/incoming/${filename}`;
                finalContent = `[Image: ${containerPath}]${content ? '\n' + content : ''}`;
                logger.info(
                  { chatJid, filename, bytes: (buffer as Buffer).length },
                  'Incoming image saved',
                );
              } catch (err) {
                logger.warn(
                  { err, chatJid },
                  'Failed to download incoming image',
                );
                finalContent = finalContent || '[Image - download failed]';
              }
            }
            if (isVoiceMessage(msg)) {
              try {
                const transcript = await transcribeAudioMessage(msg, this.sock);
                if (transcript) {
                  finalContent = `[Voice: ${transcript}]`;
                  logger.info(
                    { chatJid, length: transcript.length },
                    'Transcribed voice message',
                  );
                } else {
                  finalContent = '[Voice Message - transcription unavailable]';
                }
              } catch (err) {
                logger.error({ err }, 'Voice transcription error');
                finalContent = '[Voice Message - transcription failed]';
              }
            }

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content: finalContent,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendVoice(jid: string, hostPath: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, hostPath }, 'WA disconnected, voice not queued');
      return;
    }
    try {
      const audio = await fs.promises.readFile(hostPath);
      await this.sock.sendMessage(jid, {
        audio,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      });
      logger.info({ jid, bytes: audio.length }, 'Voice note sent');
    } catch (err) {
      logger.warn({ jid, hostPath, err }, 'Failed to send voice note');
    }
  }

  async sendMedia(
    jid: string,
    hostPath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, hostPath }, 'WA disconnected, media not queued');
      return;
    }
    try {
      const image = await fs.promises.readFile(hostPath);
      const content: { image: Buffer; caption?: string } = { image };
      if (caption) content.caption = caption;
      await this.sock.sendMessage(jid, content);
      logger.info({ jid, bytes: image.length }, 'Media sent');
    } catch (err) {
      logger.warn({ jid, hostPath, err }, 'Failed to send media');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => {
  const authDir = path.join(STORE_DIR, 'auth');
  if (!fs.existsSync(path.join(authDir, 'creds.json'))) {
    logger.warn(
      'WhatsApp: credentials not found. Run /add-whatsapp to authenticate.',
    );
    return null;
  }
  return new WhatsAppChannel(opts);
});
