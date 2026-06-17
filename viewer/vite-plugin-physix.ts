import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const SEBD = 'SEBD';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function isSebdFile(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    return buf.toString('ascii') === SEBD;
  } finally {
    fs.closeSync(fd);
  }
}

function cacheKeyFor(inputPath: string, mtimeMs: number): string {
  return crypto.createHash('sha256').update(`${inputPath}:${mtimeMs}`).digest('hex').slice(0, 16);
}

function safeCachePath(cacheRoot: string, rel: string): string | null {
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.join(cacheRoot, normalized);
  if (!full.startsWith(cacheRoot)) return null;
  return full;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.gltf')) return 'model/gltf+json';
  if (filePath.endsWith('.glb')) return 'model/gltf-binary';
  if (filePath.endsWith('.bin')) return 'application/octet-stream';
  return 'application/octet-stream';
}

export function physixApiPlugin(): Plugin {
  const projectRoot = path.resolve(__dirname, '..');
  const converterExe = path.join(projectRoot, 'converter', 'build', 'physix_convert.exe');
  const converterDir = path.dirname(converterExe);
  const cacheRoot = path.join(__dirname, '.cache');
  const defaultBin = path.join(projectRoot, 'collision.bin');

  fs.mkdirSync(cacheRoot, { recursive: true });

  function convertInput(inputPath: string): { ok: true; url: string; source: string; cached: boolean } | { ok: false; error: string } {
    const absInput = path.resolve(inputPath);
    if (!fs.existsSync(absInput)) {
      return { ok: false, error: `文件不存在: ${absInput}` };
    }
    if (!isSebdFile(absInput)) {
      return { ok: false, error: '不是 PhysX SEBD 格式（文件头应为 SEBD）' };
    }
    if (!fs.existsSync(converterExe)) {
      return {
        ok: false,
        error: '转换器未编译。请运行: cd converter && cmake -B build -G Ninja && cmake --build build',
      };
    }

    const stat = fs.statSync(absInput);
    const key = cacheKeyFor(absInput, stat.mtimeMs);
    const cacheDir = path.join(cacheRoot, key);
    const outputGltf = path.join(cacheDir, 'scene.gltf');
    const outputBin = `${outputGltf}.bin`;

    if (path.resolve(outputGltf) === absInput || path.resolve(outputBin) === absInput) {
      return { ok: false, error: '内部错误：输出路径与输入冲突' };
    }

    const cached = fs.existsSync(outputGltf) && fs.existsSync(outputBin);
    if (!cached) {
      fs.mkdirSync(cacheDir, { recursive: true });
      const result = spawnSync(converterExe, ['-i', absInput, '-o', outputGltf], {
        cwd: converterDir,
        encoding: 'utf-8',
        timeout: 180_000,
        windowsHide: true,
      });
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '转换失败').trim();
        try {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        return { ok: false, error: detail };
      }
    }

    return {
      ok: true,
      url: `/cache/${key}/scene.gltf`,
      source: absInput,
      cached,
    };
  }

  function serveCache(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = req.url ?? '';
    if (!url.startsWith('/cache/')) {
      next();
      return;
    }
    const rel = decodeURIComponent(url.slice('/cache/'.length));
    const filePath = safeCachePath(cacheRoot, rel);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(filePath));
    fs.createReadStream(filePath).pipe(res);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = req.url ?? '';

    if (url === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, {
        converterReady: fs.existsSync(converterExe),
        defaultBin: fs.existsSync(defaultBin) ? defaultBin : null,
        defaultBinValid: fs.existsSync(defaultBin) && isSebdFile(defaultBin),
      });
      return;
    }

    if (url === '/api/default-collision' && req.method === 'GET') {
      if (!fs.existsSync(defaultBin)) {
        sendJson(res, 200, { url: null });
        return;
      }
      const result = convertInput(defaultBin);
      if (!result.ok) {
        sendJson(res, 500, { error: result.error });
        return;
      }
      sendJson(res, 200, { url: result.url, source: result.source, cached: result.cached });
      return;
    }

    if (url === '/api/convert' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const payload = JSON.parse(body.toString('utf-8')) as { path?: string };
        if (!payload.path) {
          sendJson(res, 400, { error: '缺少 path 参数' });
          return;
        }
        const result = convertInput(payload.path);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        sendJson(res, 200, result);
      } catch (ex) {
        sendJson(res, 400, { error: ex instanceof Error ? ex.message : '请求解析失败' });
      }
      return;
    }

    if (url === '/api/convert-upload' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        if (body.length < 4) {
          sendJson(res, 400, { error: '文件为空' });
          return;
        }
        if (body.toString('ascii', 0, 4) !== SEBD) {
          sendJson(res, 400, { error: '不是 PhysX SEBD 格式（文件头应为 SEBD）' });
          return;
        }
        const uploadId = crypto.randomUUID();
        const uploadDir = path.join(cacheRoot, 'upload', uploadId);
        const uploadBin = path.join(uploadDir, 'collision.bin');
        fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(uploadBin, body);
        const result = convertInput(uploadBin);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        sendJson(res, 200, { ...result, source: req.headers['x-filename'] ?? 'collision.bin' });
      } catch (ex) {
        sendJson(res, 500, { error: ex instanceof Error ? ex.message : '上传失败' });
      }
      return;
    }

    next();
  }

  return {
    name: 'physix-api',
    configureServer(server) {
      server.middlewares.use(serveCache);
      server.middlewares.use((req, res, next) => {
        void handleApi(req, res, next);
      });
    },
  };
}
