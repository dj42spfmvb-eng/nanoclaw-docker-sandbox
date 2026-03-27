import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type ImageEditOp =
  | 'resize'
  | 'resize_wh'
  | 'rotate'
  | 'flip_h'
  | 'flip_v'
  | 'crop'
  | 'thumbnail'
  | 'convert'
  | 'grayscale';

export interface ImageEditOperation {
  inputPath: string;
  outputPath: string;
  operation: ImageEditOp;
  maxDimension?: number;
  width?: number;
  height?: number;
  degrees?: number;
  format?: string;
}

export interface ImageEditResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
  backend?: string;
}

interface ImageEditBackend {
  readonly name: string;
  readonly supportedOps: ReadonlySet<ImageEditOp>;
  isAvailable(): Promise<boolean>;
  execute(op: ImageEditOperation): Promise<ImageEditResult>;
}

// Allowlisted output formats to prevent ImageMagick scripting abuse (MSL, MVG, etc.)
const SAFE_OUTPUT_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.tiff',
  '.tif',
  '.bmp',
  '.webp',
]);

function validateOutputPath(outputPath: string): string | null {
  const ext = path.extname(outputPath).toLowerCase();
  if (!SAFE_OUTPUT_EXTENSIONS.has(ext)) {
    return `Unsupported output format "${ext}". Allowed: ${[...SAFE_OUTPUT_EXTENSIONS].join(', ')}`;
  }
  return null;
}

// ─── SipsBackend (macOS built-in, always available) ──────────────────────────

class SipsBackend implements ImageEditBackend {
  readonly name = 'sips';
  readonly supportedOps: ReadonlySet<ImageEditOp> = new Set([
    'resize',
    'resize_wh',
    'rotate',
    'flip_h',
    'flip_v',
    'crop',
    'convert',
  ]);
  private _available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    try {
      await execFileAsync('/usr/bin/sips', ['--version']);
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  async execute(op: ImageEditOperation): Promise<ImageEditResult> {
    const fmtErr = validateOutputPath(op.outputPath);
    if (fmtErr) return { ok: false, error: fmtErr, backend: 'sips' };

    fs.mkdirSync(path.dirname(op.outputPath), { recursive: true });
    let args: string[];

    switch (op.operation) {
      case 'resize':
        if (!op.maxDimension)
          return { ok: false, error: 'resize requires max_dimension' };
        args = [
          '-Z',
          String(op.maxDimension),
          op.inputPath,
          '--out',
          op.outputPath,
        ];
        break;
      case 'resize_wh':
        if (!op.width || !op.height)
          return { ok: false, error: 'resize_wh requires width and height' };
        args = [
          '-z',
          String(op.height),
          String(op.width),
          op.inputPath,
          '--out',
          op.outputPath,
        ];
        break;
      case 'rotate':
        if (!op.degrees)
          return { ok: false, error: 'rotate requires degrees (90/180/270)' };
        if (![90, 180, 270].includes(op.degrees))
          return { ok: false, error: 'degrees must be 90, 180, or 270' };
        args = ['-r', String(op.degrees), op.inputPath, '--out', op.outputPath];
        break;
      case 'flip_h':
        args = ['-f', 'horizontal', op.inputPath, '--out', op.outputPath];
        break;
      case 'flip_v':
        args = ['-f', 'vertical', op.inputPath, '--out', op.outputPath];
        break;
      case 'crop':
        if (!op.width || !op.height)
          return { ok: false, error: 'crop requires width and height' };
        args = [
          '-c',
          String(op.height),
          String(op.width),
          op.inputPath,
          '--out',
          op.outputPath,
        ];
        break;
      case 'convert': {
        if (!op.format) return { ok: false, error: 'convert requires format' };
        const fmtMap: Record<string, string> = {
          jpg: 'jpeg',
          jpeg: 'jpeg',
          png: 'png',
          tiff: 'tiff',
          bmp: 'bmp',
          gif: 'gif',
        };
        const fmt = fmtMap[op.format.toLowerCase()] || op.format.toLowerCase();
        args = ['-s', 'format', fmt, op.inputPath, '--out', op.outputPath];
        break;
      }
      default:
        return {
          ok: false,
          error: `sips: unsupported operation "${op.operation}"`,
        };
    }

    try {
      await execFileAsync('/usr/bin/sips', args);
      return { ok: true, outputPath: op.outputPath, backend: 'sips' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        backend: 'sips',
      };
    }
  }
}

// ─── ImageMagickBackend (optional, brew install imagemagick) ──────────────────

class ImageMagickBackend implements ImageEditBackend {
  readonly name = 'imagemagick';
  readonly supportedOps: ReadonlySet<ImageEditOp> = new Set([
    'resize',
    'resize_wh',
    'rotate',
    'flip_h',
    'flip_v',
    'crop',
    'thumbnail',
    'convert',
    'grayscale',
  ]);
  private _available: boolean | null = null;
  private _bin = '';

  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;
    for (const bin of [
      '/opt/homebrew/bin/magick',
      '/usr/local/bin/magick',
      '/opt/homebrew/bin/convert',
      '/usr/local/bin/convert',
    ]) {
      try {
        await execFileAsync(bin, ['--version']);
        this._bin = bin;
        this._available = true;
        return true;
      } catch {
        /* try next */
      }
    }
    this._available = false;
    return false;
  }

  async execute(op: ImageEditOperation): Promise<ImageEditResult> {
    const fmtErr = validateOutputPath(op.outputPath);
    if (fmtErr) return { ok: false, error: fmtErr, backend: 'imagemagick' };

    fs.mkdirSync(path.dirname(op.outputPath), { recursive: true });
    const bin = this._bin;
    let args: string[];

    switch (op.operation) {
      case 'resize':
        if (!op.maxDimension)
          return { ok: false, error: 'resize requires max_dimension' };
        args = [
          op.inputPath,
          '-resize',
          `${op.maxDimension}x${op.maxDimension}>`,
          op.outputPath,
        ];
        break;
      case 'resize_wh':
        if (!op.width || !op.height)
          return { ok: false, error: 'resize_wh requires width and height' };
        args = [
          op.inputPath,
          '-resize',
          `${op.width}x${op.height}!`,
          op.outputPath,
        ];
        break;
      case 'rotate':
        if (!op.degrees) return { ok: false, error: 'rotate requires degrees' };
        args = [op.inputPath, '-rotate', String(op.degrees), op.outputPath];
        break;
      case 'flip_h':
        args = [op.inputPath, '-flop', op.outputPath];
        break;
      case 'flip_v':
        args = [op.inputPath, '-flip', op.outputPath];
        break;
      case 'crop':
        if (!op.width || !op.height)
          return { ok: false, error: 'crop requires width and height' };
        args = [
          op.inputPath,
          '-gravity',
          'center',
          '-crop',
          `${op.width}x${op.height}+0+0`,
          '+repage',
          op.outputPath,
        ];
        break;
      case 'thumbnail':
        if (!op.width || !op.height)
          return { ok: false, error: 'thumbnail requires width and height' };
        args = [
          op.inputPath,
          '-thumbnail',
          `${op.width}x${op.height}^`,
          '-gravity',
          'center',
          '-extent',
          `${op.width}x${op.height}`,
          op.outputPath,
        ];
        break;
      case 'convert':
        args = [op.inputPath, op.outputPath];
        break;
      case 'grayscale':
        args = [op.inputPath, '-colorspace', 'Gray', op.outputPath];
        break;
      default:
        return {
          ok: false,
          error: `imagemagick: unsupported operation "${op.operation}"`,
        };
    }

    try {
      await execFileAsync(bin, args);
      return { ok: true, outputPath: op.outputPath, backend: 'imagemagick' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        backend: 'imagemagick',
      };
    }
  }
}

// ─── ImageEditor router ───────────────────────────────────────────────────────

export class ImageEditor {
  private readonly backends: ImageEditBackend[] = [
    new ImageMagickBackend(),
    new SipsBackend(),
  ];

  async edit(op: ImageEditOperation): Promise<ImageEditResult> {
    for (const backend of this.backends) {
      if (
        backend.supportedOps.has(op.operation) &&
        (await backend.isAvailable())
      ) {
        return backend.execute(op);
      }
    }
    const available =
      (
        await Promise.all(
          this.backends.map(async (b) => ({
            name: b.name,
            ok: await b.isAvailable(),
          })),
        )
      )
        .filter((b) => b.ok)
        .map((b) => b.name)
        .join(', ') || 'none';
    return {
      ok: false,
      error: `No backend supports "${op.operation}". Available: ${available}`,
    };
  }

  async listBackends(): Promise<
    Array<{ name: string; available: boolean; ops: string[] }>
  > {
    return Promise.all(
      this.backends.map(async (b) => ({
        name: b.name,
        available: await b.isAvailable(),
        ops: [...b.supportedOps],
      })),
    );
  }
}

export const imageEditor = new ImageEditor();
