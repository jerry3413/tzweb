#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_EMAIL, resolveRiviooApiBase, runReviewDownload } from './src/rivioo-client.mjs';
import { LocalJobStore } from './src/local-store.mjs';

// 目录规划：
// - public/ 放浏览器后台页面。
// - data/reviews/jobs.json 是本地任务记录库。
// - data/reviews/files/ 保存从 Rivioo 下载回来的 CSV/XLSX 文件。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const publicDir = path.join(repoRoot, 'public');
const dataDir = path.join(repoRoot, 'data/reviews');
const filesDir = path.join(dataDir, 'files');
const preferredPort = Number.parseInt(process.env.PORT || '3000', 10);
const execFileAsync = promisify(execFile);

const store = new LocalJobStore({ dataDir });
let apiBase = null;

// 服务启动前先做两件事：
// 准备本地存储目录，并识别 Rivioo 当前后端接口地址。
await mkdir(filesDir, { recursive: true });
await store.init();
apiBase = await resolveRiviooApiBase({ refresh: true });

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error.message
    });
  }
});

// 本地开发时 3000 端口经常被其他项目占用。
// 自动尝试后续端口，比直接报错更符合后台工具的使用预期。
const activePort = await listenWithPortFallback(server, preferredPort);
console.log(`Review backend running at http://localhost:${activePort}`);
console.log(`Rivioo API resolved at startup: ${apiBase}`);
console.log(`Local data directory: ${dataDir}`);

// 这个 MVP 直接使用 Node 内置 HTTP 服务，减少框架依赖。
// 路由职责保持清晰：配置、任务、本地文件、静态页面。
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      apiBase,
      dataDir,
      defaultEmail: process.env.RIVIOO_EMAIL || DEFAULT_EMAIL
    });
    return;
  }

  if (url.pathname === '/api/config/refresh' && req.method === 'POST') {
    // 手动刷新接口地址：如果 Rivioo 运行中更换后端，产品/管理员不必重启本地服务。
    apiBase = await resolveRiviooApiBase({ refresh: true });
    sendJson(res, 200, { apiBase });
    return;
  }

  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    sendJson(res, 200, {
      jobs: store.list().map(jobForApi)
    });
    return;
  }

  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    const body = await readJson(req);
    const job = await createDownloadJob(body);
    sendJson(res, 202, {
      job: jobForApi(job)
    });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'GET') {
    const job = store.get(jobMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: 'Job not found.' });
      return;
    }
    sendJson(res, 200, { job: jobForApi(job) });
    return;
  }

  const revealMatch = url.pathname.match(/^\/api\/reveal\/([^/]+)$/);
  if (revealMatch && req.method === 'POST') {
    const filename = url.searchParams.get('filename');
    if (!filename) {
      sendJson(res, 400, { error: 'Missing filename.' });
      return;
    }

    await revealJobFile(res, revealMatch[1], filename);
    return;
  }

  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/([^/]+)$/);
  if (fileMatch && req.method === 'GET') {
    await sendJobFile(res, fileMatch[1], fileMatch[2]);
    return;
  }

  await sendStatic(url.pathname, res);
}

// 先立即创建本地任务，再在后台执行 Rivioo 下载。
// 浏览器可以快速拿到任务 ID 并轮询进度，不需要等一个很长的请求结束。
async function createDownloadJob(body) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'queued',
    progress: 0,
    currentStep: 'Queued',
    createdAt: now,
    updatedAt: now,
    input: {
      url: body.url,
      platform: body.platform,
      appId: body.appId,
      count: body.count || 1000,
      country: body.country || '',
      language: body.language || 'en',
      sort: body.sort || 'newest',
      format: body.format || 'csv',
      email: body.email || process.env.RIVIOO_EMAIL || DEFAULT_EMAIL
    },
    apiBase
  };

  await store.create(job);
  // 后台执行并记录结果：成功和失败都会写进 jobs.json，避免任务异常导致服务崩溃。
  runJob(job).catch(async (error) => {
    await store.update(job.id, {
      status: 'failed',
      progress: job.progress || 0,
      currentStep: 'Failed',
      error: error.message
    });
  });

  return job;
}

// 任务状态流：
// queued -> running -> completed
// queued -> running -> failed
// 状态刻意保持简单，方便当前下载后台和未来分析页面共同使用。
async function runJob(job) {
  await store.update(job.id, {
    status: 'running',
    progress: 1,
    currentStep: 'Starting'
  });

  const result = await runReviewDownload({
    ...job.input,
    id: job.id,
    outputDir: filesDir,
    apiBase,
    timeoutMs: 180000,
    onProgress(status) {
      // Rivioo 在抓取评论时会返回进度。
      // 把进度保存到本地，浏览器刷新后仍能看到当前任务状态。
      store.update(job.id, {
        status: 'running',
        progress: status.progress ?? job.progress ?? 0,
        currentStep: status.currentStep || status.status || 'Running',
        app: status.app || job.app,
        warning: status.warning || job.warning
      }).catch((error) => {
        console.error(`Failed to update job ${job.id}:`, error);
      });
    }
  });

  await store.update(job.id, {
    status: 'completed',
    progress: 100,
    currentStep: 'Completed',
    result,
    app: result.app,
    warning: result.warning,
    completedAt: new Date().toISOString()
  });
}

// 把内部任务记录转换成浏览器可用的记录。
// 重点是隐藏本地绝对路径，只给浏览器返回可点击的下载 URL。
function jobForApi(job) {
  const result = job.result || null;
  const downloads = result?.downloads?.map((item) => ({
    ...item,
    url: item.skipped ? null : `/api/files/${job.id}/${encodeURIComponent(item.filename)}`,
    revealUrl: item.skipped ? null : `/api/reveal/${job.id}?filename=${encodeURIComponent(item.filename)}`
  })) || [];

  return {
    ...job,
    result: result ? {
      ...result,
      downloads
    } : null
  };
}

// 提供已完成任务里的 CSV/XLSX 文件下载。
// 路径检查用于防止构造 URL 读取无关的本地文件。
async function sendJobFile(res, jobId, filename) {
  const resolved = await resolveJobDownload(res, jobId, filename);
  if (!resolved) return;

  const { resolvedPath } = resolved;

  res.writeHead(200, {
    'content-type': contentTypeFor(resolvedPath),
    'content-disposition': `attachment; filename="${path.basename(resolvedPath)}"`
  });
  createReadStream(resolvedPath).pipe(res);
}

// “查看原文件”按产品语义打开本地保存位置，而不是在浏览器里再开一个预览页。
// 这里调用 macOS 的 open -R：打开 Finder 并选中目标文件，方便用户直接查看真实文件。
async function revealJobFile(res, jobId, filename) {
  const resolved = await resolveJobDownload(res, jobId, filename);
  if (!resolved) return;

  await execFileAsync('open', ['-R', resolved.resolvedPath]);
  sendJson(res, 200, {
    ok: true,
    path: resolved.resolvedPath
  });
}

// 所有本地文件操作都先走同一套校验：任务存在、文件属于任务、路径仍在 data/reviews/files 下。
// 这样下载、预览、Finder 定位不会各自复制一套安全判断。
async function resolveJobDownload(res, jobId, filename) {
  const job = store.get(jobId);
  if (!job?.result?.downloads) {
    sendJson(res, 404, { error: 'File not found.' });
    return null;
  }

  const decoded = decodeURIComponent(filename);
  const download = job.result.downloads.find((item) => item.filename === decoded && !item.skipped);
  if (!download) {
    sendJson(res, 404, { error: 'File not found.' });
    return null;
  }

  const resolvedPath = path.resolve(download.path);
  const safeRoot = path.resolve(filesDir);
  if (!resolvedPath.startsWith(`${safeRoot}${path.sep}`)) {
    sendJson(res, 403, { error: 'Invalid file path.' });
    return null;
  }

  await access(resolvedPath);
  return { job, download, resolvedPath };
}

// 从 public/ 提供本地后台页面。
// 静态页面和 /api 分开，后续分析页面可以按普通前端文件继续添加。
async function sendStatic(pathname, res) {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const resolvedPath = path.resolve(publicDir, `.${normalized}`);
  const safeRoot = path.resolve(publicDir);

  if (!resolvedPath.startsWith(`${safeRoot}${path.sep}`)) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return;
  }

  try {
    await access(resolvedPath);
    res.writeHead(200, {
      'content-type': contentTypeFor(resolvedPath)
    });
    createReadStream(resolvedPath).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

// 读取浏览器提交的 JSON 请求体。
// 当前只接收小表单数据，这一版不需要复杂的流式解析。
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

// 统一 API 响应格式，前端处理起来更简单。
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

// 预览页会展示用户下载回来的原始评论文本。
// 所有内容都先转义，避免评论里夹带 HTML 影响本地后台页面。
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

// 浏览器下载需要正确的文件类型。
// CSV 应作为文本打开，XLSX 应作为电子表格文件打开。
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return types[ext] || 'application/octet-stream';
}

async function listenWithPortFallback(httpServer, startPort) {
  const maxAttempts = 20;

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidatePort = startPort + offset;
    try {
      await listenOnce(httpServer, candidatePort);
      return candidatePort;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || offset === maxAttempts - 1) {
        throw error;
      }
    }
  }

  throw new Error('没有可用端口启动本地后台。');
}

function listenOnce(httpServer, candidatePort) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      httpServer.off('listening', handleListening);
      reject(error);
    };

    const handleListening = () => {
      httpServer.off('error', handleError);
      resolve();
    };

    httpServer.once('error', handleError);
    httpServer.once('listening', handleListening);
    httpServer.listen(candidatePort);
  });
}
