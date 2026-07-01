import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const SEBD = 'SEBD';
const AIRWALL_COLLISION_FILE_COUNT = 8;

interface AirWallInstance {
  id: string;
  desc: string;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
  files: string[];
}

interface AirWallCollisionResult {
  fileName: string;
  source: string;
  url: string;
  cached: boolean;
}

interface MultipartPart {
  name: string;
  filename?: string;
  data: Buffer;
}

interface UploadedAirWallFile {
  fileName: string;
  relativePath: string;
  displayName: string;
  path: string;
}

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

function parseXmlAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) != null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function parseFiniteNumber(raw: string | undefined, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`AirWallTable 字段 ${name} 不是有效数字`);
  return n;
}

function parseAirWallTableXml(xml: string): AirWallInstance[] {
  const rows: AirWallInstance[] = [];
  const re = /<m_vecAirWall\b([^>]*?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) != null) {
    const attrs = parseXmlAttributes(match[1]);
    if (!attrs.Id) continue;

    const files: string[] = [];
    for (let i = 1; i <= AIRWALL_COLLISION_FILE_COUNT; i++) {
      const file = (attrs[`CollisionFile${i}`] ?? '').trim();
      if (file) files.push(file);
    }
    if (!files.length) continue;

    rows.push({
      id: attrs.Id,
      desc: attrs.Desc ?? '',
      pos: {
        x: parseFiniteNumber(attrs.PosX, 'PosX'),
        y: parseFiniteNumber(attrs.PosY, 'PosY'),
        z: parseFiniteNumber(attrs.PosZ, 'PosZ'),
      },
      rot: {
        x: parseFiniteNumber(attrs.RotX, 'RotX'),
        y: parseFiniteNumber(attrs.RotY, 'RotY'),
        z: parseFiniteNumber(attrs.RotZ, 'RotZ'),
        w: parseFiniteNumber(attrs.RotW, 'RotW'),
      },
      files,
    });
  }
  return rows;
}

function parseAirWallTable(xmlPath: string): AirWallInstance[] {
  return parseAirWallTableXml(fs.readFileSync(xmlPath, 'utf-8'));
}

function resolveInside(baseDir: string, relPath: string): string | null {
  const full = path.resolve(baseDir, relPath);
  const relative = path.relative(baseDir, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

function parseContentDispositionValue(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  const re = /(?:^|;)\s*([A-Za-z0-9_*.-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) != null) {
    values[match[1].toLowerCase()] = match[2];
  }
  return values;
}

function parseMultipartBody(contentType: string | string[] | undefined, body: Buffer): MultipartPart[] {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(header ?? '');
  const boundaryValue = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundaryValue) throw new Error('缺少 multipart boundary');

  const boundaryText = `--${boundaryValue}`;
  const boundary = Buffer.from(boundaryText, 'utf-8');
  let cursor = body.indexOf(boundary);
  if (cursor < 0) throw new Error('multipart 数据格式错误');
  cursor += boundary.length;

  const parts: MultipartPart[] = [];
  while (cursor < body.length) {
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;

    const headerEnd = body.indexOf('\r\n\r\n', cursor, 'utf-8');
    if (headerEnd < 0) break;
    const headerText = body.subarray(cursor, headerEnd).toString('utf-8');
    cursor = headerEnd + 4;

    const nextBoundary = body.indexOf(`\r\n${boundaryText}`, cursor, 'utf-8');
    if (nextBoundary < 0) throw new Error('multipart 数据未正常结束');
    const data = body.subarray(cursor, nextBoundary);
    cursor = nextBoundary + 2 + boundary.length;

    const headers: Record<string, string> = {};
    for (const line of headerText.split(/\r\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disposition = parseContentDispositionValue(headers['content-disposition'] ?? '');
    if (!disposition.name) continue;
    parts.push({
      name: disposition.name,
      filename: disposition.filename,
      data,
    });
  }

  return parts;
}

function sanitizeUploadRelPath(raw: string): string | null {
  const clean = raw.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean || clean.includes('\0')) return null;
  const segments = clean.split('/').filter(Boolean);
  if (!segments.length || segments.some((seg) => seg === '.' || seg === '..')) return null;
  return segments.join('/');
}

function sanitizeUploadFileName(raw: string, fallback: string): string {
  const rel = sanitizeUploadRelPath(raw);
  return rel?.split('/').pop() || fallback;
}

function normalizeUploadKey(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function uploadMatchKeys(file: UploadedAirWallFile): string[] {
  const rel = normalizeUploadKey(file.relativePath);
  const segments = rel.split('/').filter(Boolean);
  const strippedRoot = segments.length > 1 ? segments.slice(1).join('/') : rel;
  const base = segments[segments.length - 1] ?? rel;
  return [...new Set([rel, strippedRoot, base, normalizeUploadKey(file.fileName)])];
}

function pickWindowsPath(kind: 'airwall-table' | 'airwall-bin-dir'):
  | { ok: true; path: string | null }
  | { ok: false; error: string } {
  if (process.platform !== 'win32') {
    return { ok: false, error: '本地选择窗口目前仅支持 Windows' };
  }

  const pickerScript =
    kind === 'airwall-table'
      ? `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $owner.ShowInTaskbar = $false
        $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $owner.Size = New-Object System.Drawing.Size(1, 1)
        $owner.Opacity = 0
        $owner.Show()
        $owner.Activate()
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = '选择 AirWallTable.xml'
        $dialog.Filter = 'XML files (*.xml)|*.xml|All files (*.*)|*.*'
        $dialog.CheckFileExists = $true
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
          [Console]::WriteLine($dialog.FileName)
        } else {
          [Console]::WriteLine('__CANCELLED__')
        }
        $owner.Dispose()
      `
      : `
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $owner.ShowInTaskbar = $false
        $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $owner.Size = New-Object System.Drawing.Size(1, 1)
        $owner.Opacity = 0
        $owner.Show()
        $owner.Activate()
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = '选择空气墙 bin 目录'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
          [Console]::WriteLine($dialog.SelectedPath)
        } else {
          [Console]::WriteLine('__CANCELLED__')
        }
        $owner.Dispose()
      `;

  const script = `
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
    ${pickerScript}
  `;

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf-8',
      timeout: 600_000,
      windowsHide: false,
    },
  );

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '本地选择窗口打开失败').trim();
    return { ok: false, error: detail };
  }

  const picked = result.stdout.trim();
  if (!picked || picked === '__CANCELLED__') return { ok: true, path: null };
  return { ok: true, path: picked };
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

  function convertAirWallTable(inputPath: string, binDirOverride?: string):
    | {
        ok: true;
        source: string;
        binDir: string;
        airwalls: Array<AirWallInstance & { collisions: AirWallCollisionResult[] }>;
      }
    | { ok: false; error: string } {
    const absInput = path.resolve(inputPath);
    if (!fs.existsSync(absInput)) {
      return { ok: false, error: `空气墙配置不存在: ${absInput}` };
    }
    if (!fs.statSync(absInput).isFile()) {
      return { ok: false, error: `空气墙配置不是文件: ${absInput}` };
    }

    const tableDir = path.dirname(absInput);
    const binDir = binDirOverride?.trim() ? path.resolve(binDirOverride) : path.join(tableDir, 'bin');
    if (!fs.existsSync(binDir) || !fs.statSync(binDir).isDirectory()) {
      return { ok: false, error: `空气墙 bin 目录不存在: ${binDir}` };
    }

    let rows: AirWallInstance[];
    try {
      rows = parseAirWallTable(absInput);
    } catch (ex) {
      return { ok: false, error: ex instanceof Error ? ex.message : '空气墙配置解析失败' };
    }

    const airwalls: Array<AirWallInstance & { collisions: AirWallCollisionResult[] }> = [];
    for (const row of rows) {
      const collisions: AirWallCollisionResult[] = [];
      for (const fileName of row.files) {
        const binPath = resolveInside(binDir, fileName);
        if (!binPath) {
          return { ok: false, error: `空气墙文件路径越界: ${fileName}` };
        }
        const converted = convertInput(binPath);
        if (!converted.ok) {
          return { ok: false, error: `空气墙 ${row.id} (${fileName}) 转换失败: ${converted.error}` };
        }
        collisions.push({
          fileName,
          source: converted.source,
          url: converted.url,
          cached: converted.cached,
        });
      }
      airwalls.push({ ...row, collisions });
    }

    return {
      ok: true,
      source: absInput,
      binDir,
      airwalls,
    };
  }

  function convertUploadedAirWallTable(
    tableName: string,
    xmlBuffer: Buffer,
    uploads: Array<{ fileName: string; relativePath: string; data: Buffer }>,
  ):
    | {
        ok: true;
        source: string;
        binDir: string;
        airwalls: Array<AirWallInstance & { collisions: AirWallCollisionResult[] }>;
      }
    | { ok: false; error: string } {
    if (!uploads.length) {
      return { ok: false, error: '请先选择空气墙 bin 目录' };
    }

    const safeTableName = sanitizeUploadFileName(tableName, 'AirWallTable.xml');
    const uploadRoot = path.join(cacheRoot, 'upload', crypto.randomUUID(), 'airwall');
    const tablePath = path.join(uploadRoot, safeTableName);
    const binRoot = path.join(uploadRoot, 'bin');
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(tablePath, xmlBuffer);

    let rows: AirWallInstance[];
    try {
      rows = parseAirWallTableXml(xmlBuffer.toString('utf-8'));
    } catch (ex) {
      return { ok: false, error: ex instanceof Error ? ex.message : '空气墙配置解析失败' };
    }

    const saved: UploadedAirWallFile[] = [];
    for (const upload of uploads) {
      const rel = sanitizeUploadRelPath(upload.relativePath || upload.fileName);
      if (!rel) return { ok: false, error: `空气墙文件路径无效: ${upload.relativePath || upload.fileName}` };

      const target = path.resolve(binRoot, rel);
      const relativeToRoot = path.relative(binRoot, target);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        return { ok: false, error: `空气墙文件路径越界: ${rel}` };
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, upload.data);
      saved.push({
        fileName: upload.fileName,
        relativePath: rel,
        displayName: rel,
        path: target,
      });
    }

    const uploadedRoots = new Set(saved.map((file) => file.relativePath.split('/')[0]).filter(Boolean));
    const binDirLabel = uploadedRoots.size === 1 ? [...uploadedRoots][0] : '已选择的 bin 目录';
    const airwalls: Array<AirWallInstance & { collisions: AirWallCollisionResult[] }> = [];

    for (const row of rows) {
      const collisions: AirWallCollisionResult[] = [];
      for (const fileName of row.files) {
        const requestKey = normalizeUploadKey(fileName);
        const matches = saved.filter((file) => uploadMatchKeys(file).includes(requestKey));
        const uniqueMatches = [...new Map(matches.map((file) => [file.path, file])).values()];
        if (!uniqueMatches.length) {
          return { ok: false, error: `空气墙 ${row.id} 缺少 bin 文件: ${fileName}` };
        }
        if (uniqueMatches.length > 1) {
          return { ok: false, error: `空气墙 ${row.id} 的 bin 文件名不唯一: ${fileName}` };
        }
        const upload = uniqueMatches[0];
        const converted = convertInput(upload.path);
        if (!converted.ok) {
          return { ok: false, error: `空气墙 ${row.id} (${fileName}) 转换失败: ${converted.error}` };
        }
        collisions.push({
          fileName,
          source: upload.displayName,
          url: converted.url,
          cached: converted.cached,
        });
      }
      airwalls.push({ ...row, collisions });
    }

    return {
      ok: true,
      source: safeTableName,
      binDir: binDirLabel,
      airwalls,
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

    if (url === '/api/pick-airwall-table' && req.method === 'POST') {
      const result = pickWindowsPath('airwall-table');
      if (!result.ok) {
        sendJson(res, 500, { error: result.error });
        return;
      }
      sendJson(res, 200, { path: result.path });
      return;
    }

    if (url === '/api/pick-airwall-bin-dir' && req.method === 'POST') {
      const result = pickWindowsPath('airwall-bin-dir');
      if (!result.ok) {
        sendJson(res, 500, { error: result.error });
        return;
      }
      sendJson(res, 200, { path: result.path });
      return;
    }

    if (url === '/api/airwalls' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const payload = JSON.parse(body.toString('utf-8')) as { path?: string; binDir?: string };
        if (!payload.path) {
          sendJson(res, 400, { error: '缺少 path 参数' });
          return;
        }
        const result = convertAirWallTable(payload.path, payload.binDir);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        sendJson(res, 200, result);
      } catch (ex) {
        sendJson(res, 400, { error: ex instanceof Error ? ex.message : '空气墙请求解析失败' });
      }
      return;
    }

    if (url === '/api/airwalls-upload' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const parts = parseMultipartBody(req.headers['content-type'], body);
        const table = parts.find((part) => part.name === 'table' && part.filename);
        if (!table) {
          sendJson(res, 400, { error: '请选择 AirWallTable.xml' });
          return;
        }

        const binPathParts = parts.filter((part) => part.name === 'binPaths' && !part.filename);
        const binFileParts = parts.filter((part) => part.name === 'binFiles' && part.filename);
        const uploads = binFileParts.map((part, index) => ({
          fileName: sanitizeUploadFileName(part.filename ?? '', `collision_${index}.bin`),
          relativePath: binPathParts[index]?.data.toString('utf-8') ?? part.filename ?? `collision_${index}.bin`,
          data: part.data,
        }));

        const result = convertUploadedAirWallTable(table.filename ?? 'AirWallTable.xml', table.data, uploads);
        if (!result.ok) {
          sendJson(res, 400, { error: result.error });
          return;
        }
        sendJson(res, 200, result);
      } catch (ex) {
        sendJson(res, 400, { error: ex instanceof Error ? ex.message : '空气墙上传请求解析失败' });
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
