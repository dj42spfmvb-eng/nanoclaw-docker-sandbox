import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  downloadMediaMessage,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.ogg',
  '.wav',
  '.mp4',
  '.m4a',
  '.webm',
  '.aac',
  '.wma',
  '.opus',
]);

async function whisperTranscribe(inputFile: string): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', inputFile, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 60_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 120_000 },
    );

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      /* best effort cleanup */
    }
  }
}

async function transcribeWithWhisperCpp(
  audioBuffer: Buffer,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);
    return await whisperTranscribe(tmpOgg);
  } finally {
    try {
      fs.unlinkSync(tmpOgg);
    } catch {
      /* best effort cleanup */
    }
  }
}

/**
 * Transcribe an audio/video file on disk using local whisper.cpp.
 * Used by the IPC transcribe_audio handler for host-side transcription.
 */
export async function transcribeAudioFile(
  filePath: string,
): Promise<{ transcript: string } | { error: string }> {
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      error: `Unsupported format "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    };
  }

  const transcript = await whisperTranscribe(filePath);
  if (!transcript) {
    return { error: 'Transcription produced no output' };
  }

  return { transcript };
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      console.error('Failed to download audio message');
      return FALLBACK_MESSAGE;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeWithWhisperCpp(buffer);

    if (!transcript) {
      return FALLBACK_MESSAGE;
    }

    console.log(`Transcribed voice message: ${transcript.length} chars`);
    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return FALLBACK_MESSAGE;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
