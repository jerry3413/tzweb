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
import { TemplateStore } from './src/template-store.mjs';
import { AnalysisStore } from './src/analysis-store.mjs';
import { runReviewAnalysis } from './src/deepseek-client.mjs';

// 目录规划：
// - public/ 放浏览器后台页面。
// - data/reviews/jobs.json 是本地任务记录库。
// - data/reviews/files/ 保存从 Rivioo 下载回来的 CSV/XLSX 文件。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = __dirname;
const publicDir = path.join(repoRoot, 'public');
const dataDir = path.join(repoRoot, 'data/reviews');
const filesDir = path.join(dataDir, 'files');
// 模板和分析相关目录：分析阶段的核心存储路径。
const templatesSourceDir = path.join(repoRoot, 'templates');
const templatesDataDir = path.join(repoRoot, 'data', 'templates');
const analysisDir = path.join(repoRoot, 'data', 'analysis');
const preferredPort = Number.parseInt(process.env.PORT || '3000', 10);
const execFileAsync = promisify(execFile);

const store = new LocalJobStore({ dataDir });
const templateStore = new TemplateStore({ dataDir: templatesDataDir, sourceDir: templatesSourceDir });
const analysisStore = new AnalysisStore({ dataDir: analysisDir });
let apiBase = null;

// 服务启动前先做两件事：
// 准备本地存储目录，并识别 Rivioo 当前后端接口地址。
await mkdir(filesDir, { recursive: true });
await mkdir(path.join(analysisDir, 'results'), { recursive: true });
await store.init();
await templateStore.init();
await analysisStore.init();
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

  // 删除下载任务及其关联文件。
  if (jobMatch && req.method === 'DELETE') {
    const deleted = await store.delete(jobMatch[1]);
    if (!deleted) {
      sendJson(res, 404, { error: '任务不存在。' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // ===== 模板管理接口 =====

  // 列出所有模板的索引信息（不包含完整维度数据，减少列表接口响应体积）。
  if (url.pathname === '/api/templates' && req.method === 'GET') {
    sendJson(res, 200, { templates: templateStore.list() });
    return;
  }

  // 创建自定义模板：用户基于需求新建的分析维度框架。
  if (url.pathname === '/api/templates' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const template = await templateStore.create(body);
      sendJson(res, 201, { template });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 获取单个模板的完整定义，包含所有维度和标签。
  const templateIdMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
  if (templateIdMatch && req.method === 'GET') {
    const template = await templateStore.get(templateIdMatch[1]);
    if (!template) {
      sendJson(res, 404, { error: '模板不存在。' });
      return;
    }
    sendJson(res, 200, { template });
    return;
  }

  // 更新自定义模板：修改维度、标签、描述等。
  // 内置模板不允许直接修改，需要先创建副本。
  if (templateIdMatch && req.method === 'PUT') {
    const body = await readJson(req);
    try {
      const template = await templateStore.update(templateIdMatch[1], body);
      if (!template) {
        sendJson(res, 404, { error: '模板不存在。' });
        return;
      }
      sendJson(res, 200, { template });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 删除自定义模板。内置模板不允许删除。
  if (templateIdMatch && req.method === 'DELETE') {
    try {
      const deleted = await templateStore.delete(templateIdMatch[1]);
      if (!deleted) {
        sendJson(res, 404, { error: '模板不存在。' });
        return;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 将内置模板重置为源码版本，用于撤回之前编辑导致的偏离。
  const resetMatch = url.pathname.match(/^\/api\/templates\/([^/]+)\/reset$/);
  if (resetMatch && req.method === 'POST') {
    try {
      const template = await templateStore.resetBuiltIn(resetMatch[1]);
      sendJson(res, 200, { template });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // ===== 评论解析接口 =====

  // 列出所有分析任务（只返回元数据，不包含完整分类结果）。
  if (url.pathname === '/api/analysis' && req.method === 'GET') {
    sendJson(res, 200, { analyses: analysisStore.list().map(analysisForApi) });
    return;
  }

  // 创建分析任务：前端提交 App 选择、模板、API Key 等参数。
  // 任务立即返回 202，后台异步调用 DeepSeek 执行解析。
  if (url.pathname === '/api/analysis' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const analysis = await createAnalysisJob(body);
      sendJson(res, 202, { analysis: analysisForApi(analysis) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 获取单个分析任务的元数据。
  const analysisMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)$/);
  if (analysisMatch && req.method === 'GET') {
    const analysis = analysisStore.get(analysisMatch[1]);
    if (!analysis) {
      sendJson(res, 404, { error: '分析任务不存在。' });
      return;
    }
    sendJson(res, 200, { analysis: analysisForApi(analysis) });
    return;
  }

  // 获取完整分析结果（数据量较大，按需加载）。
  const resultsMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/results$/);
  if (resultsMatch && req.method === 'GET') {
    const results = await analysisStore.loadResults(resultsMatch[1]);
    if (!results) {
      sendJson(res, 404, { error: '分析结果不存在，可能任务尚未完成。' });
      return;
    }
    sendJson(res, 200, results);
    return;
  }

  // 人工重新分配低置信度评论：将某条评论归类到指定维度/标签。
  const lowConfMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/low-confidence\/([^/]+)$/);
  if (lowConfMatch && req.method === 'PUT') {
    const body = await readJson(req);
    try {
      await reassignLowConfidence(lowConfMatch[1], lowConfMatch[2], body);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 批量标记低置信度评论：一次性将多条评论归类到指定维度/标签。
  const lowConfBatchMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/low-confidence\/batch$/);
  if (lowConfBatchMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const count = await batchReassignLowConfidence(lowConfBatchMatch[1], body);
      sendJson(res, 200, { ok: true, count });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 人工确认时新增标签：写入分析结果和源模板。
  const addTagMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/tags$/);
  if (addTagMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const tag = await addTagToTemplateAndResults(addTagMatch[1], body);
      sendJson(res, 201, { tag });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // AI 建议标签确认：创建新标签并分配给评论。
  const suggestedConfirmMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/suggested\/confirm$/);
  if (suggestedConfirmMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await confirmSuggestedTag(suggestedConfirmMatch[1], body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // AI 建议标签忽略：移除该建议分类。
  const suggestedIgnoreMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/suggested\/ignore$/);
  if (suggestedIgnoreMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await ignoreSuggestedTag(suggestedIgnoreMatch[1], body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 删除分析任务及其结果文件。
  if (analysisMatch && req.method === 'DELETE') {
    const deleted = await analysisStore.delete(analysisMatch[1]);
    if (!deleted) {
      sendJson(res, 404, { error: '分析任务不存在。' });
      return;
    }
    sendJson(res, 200, { ok: true });
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

// ===== 评论解析辅助函数 =====

// 创建分析任务：验证参数、创建任务记录、后台启动 DeepSeek 解析。
async function createAnalysisJob(body) {
  const { downloadJobIds, templateId, deepseekApiKey, confidenceThreshold = 0.6, parallelTasks = 20, model = 'deepseek-chat', temperature, maxTokens, systemPrompt, userPromptTemplate } = body;

  if (!templateId) throw new Error('请选择分析模板。');
  if (!Array.isArray(downloadJobIds) || downloadJobIds.length === 0) throw new Error('请选择至少一个下载任务。');
  if (!deepseekApiKey) throw new Error('请输入 DeepSeek API Key。');

  // 加载模板
  const template = await templateStore.get(templateId);
  if (!template) throw new Error('模板不存在。');

  // 验证下载任务：必须都是已完成状态，且属于同一个 App
  const jobs = downloadJobIds.map((id) => store.get(id));
  const missing = jobs.some((j) => !j);
  if (missing) throw new Error('部分下载任务不存在。');

  const notCompleted = jobs.filter((j) => j.status !== 'completed');
  if (notCompleted.length > 0) throw new Error(`以下任务未完成：${notCompleted.map((j) => j.id).join(', ')}`);

  // 验证是否属于同一 App
  const appNames = new Set(jobs.map((j) => (j.app || j.result?.app)?.name || ''));
  if (appNames.size > 1) throw new Error('所选下载任务属于不同 App，请只选择同一 App 的下载记录。');

  // 收集 CSV 文件路径
  const csvFilePaths = [];
  for (const job of jobs) {
    const downloads = job.result?.downloads || [];
    for (const dl of downloads) {
      if (dl.format === 'csv' && !dl.skipped && dl.path) {
        csvFilePaths.push(dl.path);
      }
    }
  }
  if (csvFilePaths.length === 0) throw new Error('所选任务没有可用的 CSV 文件。');

  // 提取 App 信息
  const appJob = jobs[0];
  const app = appJob.app || appJob.result?.app || {};

  const id = randomUUID();
  const now = new Date().toISOString();
  const analysis = {
    id,
    status: 'queued',
    progress: 0,
    currentStep: 'Queued',
    createdAt: now,
    updatedAt: now,
    templateId,
    templateName: template.name,
    downloadJobIds,
    app: {
      name: app.name || '',
      developer: app.developer || '',
      icon: app.icon || ''
    },
    config: { parallelTasks, model, confidenceThreshold, temperature: temperature ?? 0.1, maxTokens: maxTokens || 8192 },
    customPrompt: (systemPrompt || userPromptTemplate) ? { systemPrompt, userPromptTemplate } : undefined,
    deepseekApiKey, // 只在服务端存储，不返回给前端
    summary: null,
    error: null
  };

  await analysisStore.create(analysis);

  // 后台执行 DeepSeek 解析，不阻塞 HTTP 响应
  runAnalysisJob(analysis, template, csvFilePaths).catch(async (error) => {
    await analysisStore.update(analysis.id, {
      status: 'failed',
      progress: analysis.progress || 0,
      currentStep: 'Failed',
      error: error.message
    });
  });

  return analysis;
}

// 将分析任务记录转换为前端可用的格式。
// 关键：deepseekApiKey 绝对不返回给浏览器。
function analysisForApi(analysis) {
  const { deepseekApiKey, ...rest } = analysis;
  return rest;
}

// 后台执行完整的 DeepSeek 分析流程。
// 进度更新通过 onProgress 回调写入 analysisStore，
// 浏览器轮询 /api/analysis 即可看到实时进度。
async function runAnalysisJob(analysis, template, csvFilePaths) {
  await analysisStore.update(analysis.id, {
    status: 'running',
    progress: 1,
    currentStep: 'Starting'
  });

  const results = await runReviewAnalysis({
    analysisId: analysis.id,
    template,
    csvFilePaths,
    apiKey: analysis.deepseekApiKey,
    model: analysis.config?.model || 'deepseek-chat',
    confidenceThreshold: analysis.config?.confidenceThreshold ?? 0.6,
    parallelTasks: analysis.config?.parallelTasks || 20,
    temperature: analysis.config?.temperature,
    maxTokens: analysis.config?.maxTokens,
    systemPrompt: analysis.customPrompt?.systemPrompt,
    userPromptTemplate: analysis.customPrompt?.userPromptTemplate,
    onProgress(status) {
      analysisStore.update(analysis.id, {
        status: 'running',
        progress: status.progress || 0,
        currentStep: status.currentStep || 'Running',
        summary: {
          totalReviews: status.totalReviews || (analysis.summary?.totalReviews || 0),
          classifiedCount: 0,
          lowConfidenceCount: 0,
          errorCount: status.completedBatches ? 0 : 0
        }
      }).catch((error) => {
        console.error(`更新分析任务进度失败 ${analysis.id}:`, error);
      });
    }
  });

  // 保存完整结果到 results/{id}.json
  await analysisStore.saveResults(analysis.id, results);

  // 更新任务元数据为已完成
  await analysisStore.update(analysis.id, {
    status: 'completed',
    progress: 100,
    currentStep: 'Completed',
    summary: results.summary,
    completedAt: results.summary.completedAt
  });
}

// 人工重新分配低置信度评论：更新 results 文件中的分类信息。
async function reassignLowConfidence(analysisId, reviewId, body) {
  const { dimensionId, tagId, dimensionName, tagName } = body;
  if (!dimensionId || !tagId) throw new Error('请同时提供 dimensionId 和 tagId。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const review = (results.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) throw new Error('评论不存在。');

  // 更新该评论的分类为人工指定的维度/标签
  review.classifications = [{
    dimensionId,
    tagId,
    dimensionName: dimensionName || '',
    tagName: tagName || '',
    confidence: 1,
    manuallyAssigned: true
  }];
  review.isLowConfidence = false;

  // 重新计算统计
  const { calculateDimensionStats } = await import('./src/deepseek-client.mjs');
  // 动态导入不适用，直接重算

  // 更新 summary
  const revs = results.reviews || [];
  const lowCount = revs.filter((r) => r.isLowConfidence).length;
  const classifiedCount = revs.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;

  if (results.summary) {
    results.summary.lowConfidenceCount = lowCount;
    results.summary.classifiedCount = classifiedCount;
  }

  // 重新计算维度统计
  results.dimensionStats = recalcDimensionStats(results.reviews, results.template);

  await analysisStore.saveResults(analysisId, results);

  // 同步更新元数据中的 summary
  await analysisStore.update(analysisId, {
    summary: results.summary
  });
}

// 批量标记低置信度评论：将多条评论一次性归类到指定维度/标签。
async function batchReassignLowConfidence(analysisId, body) {
  const { reviewIds, dimensionId, tagId, dimensionName, tagName } = body;
  if (!reviewIds || !Array.isArray(reviewIds) || reviewIds.length === 0) {
    throw new Error('请提供至少一条评论 ID。');
  }
  if (!dimensionId || !tagId) throw new Error('请同时提供 dimensionId 和 tagId。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const idSet = new Set(reviewIds);
  let matched = 0;
  for (const review of (results.reviews || [])) {
    if (!idSet.has(review.reviewId)) continue;
    review.classifications = [{
      dimensionId,
      tagId,
      dimensionName: dimensionName || '',
      tagName: tagName || '',
      confidence: 1,
      manuallyAssigned: true
    }];
    review.isLowConfidence = false;
    matched++;
  }

  // 更新 summary
  const revs = results.reviews || [];
  const lowCount = revs.filter((r) => r.isLowConfidence).length;
  const classifiedCount = revs.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;
  if (results.summary) {
    results.summary.lowConfidenceCount = lowCount;
    results.summary.classifiedCount = classifiedCount;
  }

  // 重新计算维度统计
  results.dimensionStats = recalcDimensionStats(results.reviews, results.template);

  await analysisStore.saveResults(analysisId, results);
  await analysisStore.update(analysisId, { summary: results.summary });

  return matched;
}

// 人工确认时新增标签：同时写入分析结果的模板快照和源模板文件。
async function addTagToTemplateAndResults(analysisId, body) {
  const { dimensionId, tagName } = body;
  if (!dimensionId || !tagName) throw new Error('请提供 dimensionId 和 tagName。');

  const tagId = `tag-manual-${randomUUID()}`;

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  // 在结果的模板快照中添加新标签
  const dim = (results.template?.dimensions || []).find((d) => d.id === dimensionId);
  if (!dim) throw new Error('维度不存在。');
  if (!dim.tags) dim.tags = [];
  dim.tags.push({ id: tagId, name: tagName });

  await analysisStore.saveResults(analysisId, results);

  // 同时更新源模板（如果是自定义模板）
  const analysis = analysisStore.get(analysisId);
  if (analysis) {
    try {
      await templateStore.update(analysis.templateId, {
        dimensions: results.template.dimensions
      });
    } catch {
      // 源模板可能为内置模板，更新失败不影响结果
    }
  }

  return { id: tagId, name: tagName, dimensionId };
}

// 确认 AI 建议的标签：在模板中创建新标签，并将评论的 suggested 分类转为正式分类。
async function confirmSuggestedTag(analysisId, body) {
  const { reviewId, dimensionName, tagName } = body;
  if (!reviewId || !dimensionName || !tagName) throw new Error('请提供 reviewId、dimensionName 和 tagName。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  // 在模板快照中查找或创建维度/标签
  const template = results.template;
  if (!template) throw new Error('模板快照不存在。');

  let dim = (template.dimensions || []).find((d) => d.name === dimensionName);
  if (!dim) {
    // 维度也不存在，同时创建维度和标签
    const dimId = `dim-manual-${randomUUID()}`;
    dim = { id: dimId, name: dimensionName, productMeaning: '', tags: [] };
    if (!template.dimensions) template.dimensions = [];
    template.dimensions.push(dim);
  }

  let tagId;
  if (dimensionName === '无意义内容') {
    tagId = '_meaningless';
  } else {
    const existingTag = (dim.tags || []).find((t) => t.name === tagName);
    if (existingTag) {
      tagId = existingTag.id;
    } else {
      tagId = `tag-manual-${randomUUID()}`;
      if (!dim.tags) dim.tags = [];
      dim.tags.push({ id: tagId, name: tagName });
    }
  }

  // 更新评论分类：将 suggested 标记移除，dimensionId/tagId 补全
  const review = (results.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) throw new Error('评论不存在。');

  for (const c of (review.classifications || [])) {
    if (c.suggested && c.dimensionName === dimensionName && c.tagName === tagName) {
      delete c.suggested;
      c.dimensionId = dim.id;
      c.tagId = tagId;
      c.manuallyAssigned = true;
    }
  }

  // 重新判断 isLowConfidence：是否还有未确认的 suggested 分类
  const hasRemainingSuggestions = (review.classifications || []).some((c) => c.suggested);
  if (!hasRemainingSuggestions) {
    review.isLowConfidence = false;
  }

  // 更新统计
  const revs = results.reviews || [];
  const lowCount = revs.filter((r) => r.isLowConfidence).length;
  const classifiedCount = revs.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;
  if (results.summary) {
    results.summary.lowConfidenceCount = lowCount;
    results.summary.classifiedCount = classifiedCount;
  }
  results.dimensionStats = recalcDimensionStats(results.reviews, results.template);

  await analysisStore.saveResults(analysisId, results);

  // 同步更新源模板
  const analysis = analysisStore.get(analysisId);
  if (analysis) {
    try {
      await templateStore.update(analysis.templateId, {
        dimensions: results.template.dimensions
      });
    } catch {
      // 源模板可能为内置模板，更新失败不影响结果
    }
  }

  return { ok: true, dimensionId: dim.id, tagId };
}

// 忽略 AI 建议的标签：移除该 suggested 分类，重新判断评论状态。
async function ignoreSuggestedTag(analysisId, body) {
  const { reviewId, dimensionName, tagName } = body;
  if (!reviewId) throw new Error('请提供 reviewId。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const review = (results.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) throw new Error('评论不存在。');

  // 移除匹配的 suggested 分类
  review.classifications = (review.classifications || []).filter((c) => {
    if (c.suggested && c.dimensionName === dimensionName && c.tagName === tagName) return false;
    return true;
  });

  // 重新判断 isLowConfidence
  const hasRemainingSuggestions = (review.classifications || []).some((c) => c.suggested);
  if (!hasRemainingSuggestions) {
    // 无剩余建议，按置信度阈值判断
    const threshold = results.summary?.confidenceThreshold || 0.6;
    const hasHighEnough = (review.classifications || []).some((c) => c.confidence >= threshold);
    review.isLowConfidence = !hasHighEnough && review.classifications.length > 0;
    if (review.classifications.length === 0) review.isLowConfidence = true;
  }

  // 更新统计
  const revs = results.reviews || [];
  const lowCount = revs.filter((r) => r.isLowConfidence).length;
  const classifiedCount = revs.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;
  if (results.summary) {
    results.summary.lowConfidenceCount = lowCount;
    results.summary.classifiedCount = classifiedCount;
  }
  results.dimensionStats = recalcDimensionStats(results.reviews, results.template);

  await analysisStore.saveResults(analysisId, results);

  return { ok: true };
}

// 重新计算维度/标签统计分布。
// 在人工重新分配后用于更新 results.dimensionStats。
function recalcDimensionStats(reviews, template) {
  const stats = (template?.dimensions || []).map((dim) => {
    const tagCounts = new Map();
    for (const tag of (dim.tags || [])) {
      tagCounts.set(tag.id, 0);
    }

    let dimCount = 0;
    for (const review of (reviews || [])) {
      if (review.isLowConfidence) continue;
      for (const c of (review.classifications || [])) {
        if (c.dimensionId === dim.id) {
          tagCounts.set(c.tagId, (tagCounts.get(c.tagId) || 0) + 1);
          dimCount += 1;
        }
      }
    }

    return {
      dimensionId: dim.id,
      dimensionName: dim.name,
      count: dimCount,
      tags: Array.from(tagCounts.entries()).map(([tagId, count]) => {
        const tag = (dim.tags || []).find((t) => t.id === tagId);
        return { tagId, tagName: tag?.name || '', count };
      }).filter((t) => t.count > 0).sort((a, b) => b.count - a.count)
    };
  });

  // 统计无意义内容
  const meaninglessTagCounts = new Map();
  let meaninglessCount = 0;
  for (const review of (reviews || [])) {
    if (review.isLowConfidence) continue;
    for (const c of (review.classifications || [])) {
      if (c.dimensionId === '_meaningless') {
        meaninglessTagCounts.set(c.tagName, (meaninglessTagCounts.get(c.tagName) || 0) + 1);
        meaninglessCount += 1;
      }
    }
  }
  if (meaninglessCount > 0) {
    stats.push({
      dimensionId: '_meaningless',
      dimensionName: '无意义',
      count: meaninglessCount,
      tags: Array.from(meaninglessTagCounts.entries()).map(([tagName, count]) => ({
        tagId: '_meaningless',
        tagName,
        count
      })).sort((a, b) => b.count - a.count)
    });
  }

  return stats.filter((dim) => dim.count > 0);
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
