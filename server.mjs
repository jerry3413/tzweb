#!/usr/bin/env node

import http from 'node:http';
import path from 'node:path';
import { createReadStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_EMAIL, resolveRiviooApiBase, runReviewDownload } from './src/rivioo-client.mjs';
import { LocalJobStore } from './src/local-store.mjs';
import { TemplateStore } from './src/template-store.mjs';
import { AnalysisStore } from './src/analysis-store.mjs';
import { runReviewAnalysis, analyzeBatch } from './src/deepseek-client.mjs';
import { buildCompareV2Report } from './src/compare-v2-report.mjs';
import { translateAllReviews } from './src/translate-reviews.mjs';
import { loadProviders } from './src/llm-client.mjs';

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
const compareReportsDir = path.join(repoRoot, 'data', 'compare-reports');
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
await mkdir(compareReportsDir, { recursive: true });
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

  if (url.pathname === '/api/providers' && req.method === 'GET') {
    sendJson(res, 200, loadProviders());
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

  // ===== Prompt 版本管理 =====
  // 列出所有版本（不含 promptTemplate 正文）
  if (url.pathname === '/api/prompts/versions' && req.method === 'GET') {
    try {
      const versions = getPromptVersionsList();
      sendJson(res, 200, { versions });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // 新建版本
  if (url.pathname === '/api/prompts/versions' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      if (!body.version || !body.promptTemplate) {
        sendJson(res, 400, { error: '版本号和 promptTemplate 为必填项。' });
        return;
      }
      const version = createPromptVersion(body);
      sendJson(res, 201, { version });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 单版本操作：GET / PUT / DELETE / set-current
  const promptVersionMatch = url.pathname.match(/^\/api\/prompts\/versions\/([^/]+)$/);
  if (promptVersionMatch) {
    const versionId = promptVersionMatch[1];

    if (req.method === 'GET') {
      try {
        const version = getPromptVersion(versionId);
        if (!version) {
          sendJson(res, 404, { error: 'Prompt 版本不存在。' });
          return;
        }
        sendJson(res, 200, { version });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    if (req.method === 'PUT') {
      try {
        const body = await readJson(req);
        const version = updatePromptVersion(versionId, body);
        sendJson(res, 200, { version });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (req.method === 'DELETE') {
      try {
        deletePromptVersion(versionId);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    return;
  }

  // 设为默认版本
  const setCurrentMatch = url.pathname.match(/^\/api\/prompts\/versions\/([^/]+)\/set-current$/);
  if (setCurrentMatch && req.method === 'PUT') {
    try {
      setCurrentPromptVersion(setCurrentMatch[1]);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

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
    const analysis = analysisStore.get(resultsMatch[1]);
    sendJson(res, 200, { ...results, appName: analysis?.app?.name || results?.template?.name || '' });
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

  // 批量删除标签：清除选中评论的所有分类标签。
  const batchDeleteTagsMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/reviews\/batch-delete-tags$/);
  if (batchDeleteTagsMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const count = await batchDeleteReviewTags(batchDeleteTagsMatch[1], body);
      sendJson(res, 200, { ok: true, count });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 批量添加标签：向选中评论添加同一标签。
  const batchAddTagMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/reviews\/batch-add-tag$/);
  if (batchAddTagMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await batchAddTagToReviews(batchAddTagMatch[1], body);
      sendJson(res, 200, result);
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

  // 更新已分类评论的标签：全量替换分类列表。
  const reviewClassMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/reviews\/([^/]+)$/);
  if (reviewClassMatch && req.method === 'PUT') {
    const body = await readJson(req);
    try {
      const result = await updateReviewClassifications(reviewClassMatch[1], reviewClassMatch[2], body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 单条评论 AI 重分类：对单条评论重新调用 LLM 获取分类建议。
  const reclassifyMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/reviews\/([^/]+)\/reclassify$/);
  if (reclassifyMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await reclassifySingleReview(reclassifyMatch[1], reclassifyMatch[2], body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 批量评论 AI 重分类：对多条评论批量调用 LLM 获取分类建议。
  const batchReclassifyMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/reviews\/batch-reclassify$/);
  if (batchReclassifyMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await batchReclassifyReviews(batchReclassifyMatch[1], body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // 基于手动修正记录生成 prompt 优化建议。
  const promptOptMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/prompt-optimization$/);
  if (promptOptMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const result = await generatePromptOptimization(promptOptMatch[1], body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }


  // 翻译评论原文：使用 AI 将评论翻译为目标语言，结果写回 analysis results。
  const translateMatch = url.pathname.match(/^\/api\/analysis\/([^/]+)\/translate$/);
  if (translateMatch && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const analysisId = translateMatch[1];
      const result = await runTranslation(analysisId, body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }
  // ===== 竞品对比接口 =====

  // 列出可按模板分组的已完成分析，用于对比 App 选择。
  if (url.pathname === '/api/compare/options' && req.method === 'GET') {
    const groups = buildCompareOptions();
    sendJson(res, 200, { groups });
    return;
  }

  // 生成对比报告：接收多个 analysisId，聚合各 App 的维度标签统计。
  if (url.pathname === '/api/compare/report' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const report = await buildCompareReport(body);
      sendJson(res, 200, report);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // V2 — 生成深度分析报告（用户上传高赞评论 CSV）。
  if (url.pathname === '/api/compare/v2/report' && req.method === 'POST') {
    const body = await readJson(req);
    try {
      const { analysisIds, csvData } = body;
      // 从分析任务获取 API Key
      const firstAnalysis = analysisStore.get(analysisIds[0]);
      const apiKey = firstAnalysis?.deepseekApiKey || '';
      if (!apiKey) {
        throw new Error('未找到 DeepSeek API Key，请先在解析任务中配置。');
      }
      const report = await buildCompareV2Report({
        analysisIds,
        analysisStore,
        downloadStore: store,
        csvDataMap: csvData || {},
        apiKey
      });
      const { reportId, createdAt } = saveCompareReport(report);
      sendJson(res, 200, { reportId, createdAt, ...report });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // V2 — 列出历史报告。
  if (url.pathname === '/api/compare/v2/history' && req.method === 'GET') {
    try {
      const index = readCompareReportsIndex();
      sendJson(res, 200, { reports: index });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // V2 — 加载/删除指定报告。
  const v2ReportMatch = url.pathname.match(/^\/api\/compare\/v2\/report\/([^/]+)$/);
  if (v2ReportMatch) {
    const reportId = v2ReportMatch[1];
    if (req.method === 'GET') {
      const report = loadCompareReport(reportId);
      if (!report) {
        sendJson(res, 404, { error: '报告不存在。' });
        return;
      }
      sendJson(res, 200, report);
      return;
    }
    if (req.method === 'DELETE') {
      deleteCompareReportById(reportId);
      sendJson(res, 200, { ok: true });
      return;
    }
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
// ===== Prompt 版本管理 =====

const PROMPT_VERSIONS_FILE = path.join(process.cwd(), 'data', 'prompts', 'system-prompt-versions.json');

function getPromptVersionsList() {
  try {
    const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, 'utf8'));
    return versions.map(({ version, createdAt, description, current }) => ({
      version, createdAt, description, current
    }));
  } catch {
    return [];
  }
}

function getPromptVersion(version) {
  try {
    const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, 'utf8'));
    return versions.find((v) => v.version === version) || null;
  } catch {
    return null;
  }
}

function savePromptVersions(versions) {
  writeFileSync(PROMPT_VERSIONS_FILE, JSON.stringify(versions, null, 2) + '\n');
}

function createPromptVersion(body) {
  const { version, description, promptTemplate } = body;
  if (!version || !promptTemplate) throw new Error('版本号和 promptTemplate 为必填项。');

  const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, 'utf8'));
  if (versions.find((v) => v.version === version)) {
    throw new Error(`版本 ${version} 已存在。`);
  }

  const entry = {
    version,
    createdAt: new Date().toISOString(),
    description: description || '',
    promptTemplate
  };
  versions.push(entry);
  savePromptVersions(versions);
  return { version: entry.version, createdAt: entry.createdAt, description: entry.description };
}

function updatePromptVersion(versionId, body) {
  const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, 'utf8'));
  const v = versions.find((v) => v.version === versionId);
  if (!v) throw new Error(`版本 ${versionId} 不存在。`);

  if (body.description !== undefined) v.description = body.description;
  if (body.promptTemplate !== undefined) v.promptTemplate = body.promptTemplate;
  savePromptVersions(versions);
  return { version: v.version, createdAt: v.createdAt, description: v.description, current: v.current };
}

function deletePromptVersion(versionId) {
  const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, 'utf8'));
  const v = versions.find((v) => v.version === versionId);
  if (!v) throw new Error(`版本 ${versionId} 不存在。`);
  if (v.current) throw new Error('不能删除当前默认版本，请先设置其他版本为默认。');

  const filtered = versions.filter((v) => v.version !== versionId);
  savePromptVersions(filtered);
}

function setCurrentPromptVersion(versionId) {
  const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, 'utf8'));
  const v = versions.find((v) => v.version === versionId);
  if (!v) throw new Error(`版本 ${versionId} 不存在。`);

  for (const item of versions) {
    item.current = item.version === versionId;
  }
  savePromptVersions(versions);
}

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
  const { downloadJobIds, templateId, deepseekApiKey, confidenceThreshold = 0.6, parallelTasks = 20, model = 'deepseek-chat', temperature, maxTokens, systemPrompt, userPromptTemplate, promptVersion } = body;

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
    config: { parallelTasks, model, confidenceThreshold, temperature: temperature ?? 0.1, maxTokens: maxTokens || 8192, promptVersion: promptVersion || '2.0' },
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
    promptVersion: analysis.config?.promptVersion,
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
  const { dimensionId, tagId, dimensionName, tagName, polarity } = body;
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
    polarity: polarity || '',
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
  const { reviewIds, dimensionId, tagId, dimensionName, tagName, polarity } = body;
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
      polarity: polarity || '',
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

// 批量删除标签：清除选中评论的所有分类标签，将它们移回待确认列表。
async function batchDeleteReviewTags(analysisId, body) {
  const { reviewIds, tags } = body;
  if (!reviewIds || !Array.isArray(reviewIds) || reviewIds.length === 0) {
    throw new Error('请提供至少一条评论 ID。');
  }

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  // 如果指定了 tags（选择性删除），构建过滤集合
  const tagFilter = (tags && Array.isArray(tags) && tags.length > 0)
    ? new Set(tags.map((t) => `${t.dimensionId}::${t.tagId}`))
    : null;

  const idSet = new Set(reviewIds);
  let matched = 0;
  for (const review of (results.reviews || [])) {
    if (!idSet.has(review.reviewId)) continue;
    if (tagFilter) {
      // 选择性删除：只移除匹配的标签
      const before = review.classifications.length;
      review.classifications = (review.classifications || []).filter((c) => {
        const key = `${c.dimensionId}::${c.tagId || c.tagName}`;
        return !tagFilter.has(key);
      });
      if (review.classifications.length < before) matched++;
      // 如果全部标签被删除，退回待确认
      if (review.classifications.length === 0) {
        review.isLowConfidence = true;
        review.level3 = null;
      }
    } else {
      // 全量删除：清除所有标签
      review.classifications = [];
      review.isLowConfidence = true;
      review.level3 = null;
      matched++;
    }
  }

  const revs = results.reviews || [];
  const lowCount = revs.filter((r) => r.isLowConfidence).length;
  const classifiedCount = revs.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;
  if (results.summary) {
    results.summary.lowConfidenceCount = lowCount;
    results.summary.classifiedCount = classifiedCount;
  }

  results.dimensionStats = recalcDimensionStats(results.reviews, results.template);

  await analysisStore.saveResults(analysisId, results);
  await analysisStore.update(analysisId, { summary: results.summary });

  return matched;
}

// 批量添加标签：向选中评论添加同一标签。
async function batchAddTagToReviews(analysisId, body) {
  const { reviewIds, dimensionId, tagName: rawTagName, polarity } = body;
  if (!reviewIds || !Array.isArray(reviewIds) || reviewIds.length === 0) {
    throw new Error('请提供至少一条评论 ID。');
  }
  if (!dimensionId || !rawTagName) throw new Error('请提供 dimensionId 和 tagName。');

  const tagName = cleanTagName(rawTagName);
  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  // 先在模板中查找或创建标签
  const template = results.template;
  let dim = (template?.dimensions || []).find((d) => d.id === dimensionId || cleanDimName(d.name) === cleanDimName(dimensionId));
  if (!dim) {
    dim = { id: dimensionId, name: dimensionId, productMeaning: '', tags: [] };
    if (template) {
      if (!template.dimensions) template.dimensions = [];
      template.dimensions.push(dim);
    }
  }
  let tag = (dim.tags || []).find((t) => cleanTagName(t.name) === tagName);
  let tagId;
  if (tag) {
    tagId = tag.id;
  } else {
    tagId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!dim.tags) dim.tags = [];
    dim.tags.push({ id: tagId, name: tagName });
  }

  // 同步标签到源模板
  const analysis = analysisStore.get(analysisId);
  if (analysis && template) {
    try {
      await templateStore.update(analysis.templateId, {
        dimensions: template.dimensions
      });
    } catch { /* 模板更新失败不阻塞批量操作 */ }
  }

  const idSet = new Set(reviewIds);
  let matched = 0;
  for (const review of (results.reviews || [])) {
    if (!idSet.has(review.reviewId)) continue;
    if (!review.classifications) review.classifications = [];
    const exists = review.classifications.some(
      (c) => !c.suggested && c.dimensionId === dimensionId && (c.tagId === tagId || cleanTagName(c.tagName) === tagName)
    );
    if (exists) continue;
    review.classifications.push({
      dimensionId,
      dimensionName: dim.name || dimensionId,
      tagId,
      tagName,
      polarity: polarity || '',
      confidence: 1,
      manuallyAssigned: true
    });
    review.isLowConfidence = false;
    review.level3 = null;
    matched++;
  }

  const revs = results.reviews || [];
  const lowCount = revs.filter((r) => r.isLowConfidence).length;
  const classifiedCount = revs.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;
  if (results.summary) {
    results.summary.lowConfidenceCount = lowCount;
    results.summary.classifiedCount = classifiedCount;
  }

  results.dimensionStats = recalcDimensionStats(results.reviews, results.template);

  await analysisStore.saveResults(analysisId, results);
  await analysisStore.update(analysisId, { summary: results.summary });

  return { count: matched, dimensionId, tagId, tagName };
}

// 人工确认时新增标签：同时写入分析结果的模板快照和源模板文件。
function cleanTagName(name) {
  return (name || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function cleanDimName(name) {
  return (name || '').replace(/[（(][^）)]*[）)]\s*$/g, '').trim();
}

async function addTagToTemplateAndResults(analysisId, body) {
  const { dimensionId, tagName: rawTagName } = body;
  if (!dimensionId || !rawTagName) throw new Error('请提供 dimensionId 和 tagName。');

  const tagName = cleanTagName(rawTagName);

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  // 在结果的模板快照中添加新标签
  const dim = (results.template?.dimensions || []).find((d) => d.id === dimensionId);
  if (!dim) throw new Error('维度不存在。');
  if (!dim.tags) dim.tags = [];

  // 检查是否已有同名标签（清洗掉 [极性] 前缀后比对）
  const existing = dim.tags.find((t) => cleanTagName(t.name) === tagName);
  if (existing) {
    return { id: existing.id, name: existing.name, dimensionId };
  }

  const tagId = `tag-manual-${randomUUID()}`;
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
  const { reviewId, dimensionName: rawDimName, tagName: rawTagName } = body;
  if (!reviewId || !rawDimName || !rawTagName) throw new Error('请提供 reviewId、dimensionName 和 tagName。');

  const dimensionName = cleanDimName(rawDimName);
  const tagName = cleanTagName(rawTagName);

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  // 在模板快照中查找或创建维度/标签
  const template = results.template;
  if (!template) throw new Error('模板快照不存在。');

  let dim = (template.dimensions || []).find((d) => cleanDimName(d.name) === dimensionName);
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
    const existingTag = (dim.tags || []).find((t) => cleanTagName(t.name) === tagName);
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
    if (c.suggested && cleanDimName(c.dimensionName) === dimensionName && cleanTagName(c.tagName) === tagName) {
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
    if (c.suggested && cleanDimName(c.dimensionName) === cleanDimName(dimensionName) && cleanTagName(c.tagName) === cleanTagName(tagName)) return false;
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
  // 收集所有评论中实际出现的分类，构建 tagId → tagName 映射（含自定义标签和低置信度评论中已手动确认的标签）
  const allTagNames = new Map(); // key: "dimId::tagId" → tagName
  for (const review of (reviews || [])) {
    for (const c of (review.classifications || [])) {
      if (c.suggested) continue; // 跳过 AI 建议，只统计已确认/手动分配的分类
      if (c.tagName) {
        allTagNames.set(`${c.dimensionId}::${c.tagId}`, c.tagName);
      }
    }
  }

  const stats = (template?.dimensions || []).map((dim) => {
    const tagCounts = new Map(); // tagId → count
    for (const tag of (dim.tags || [])) {
      tagCounts.set(tag.id, 0);
    }

    let dimCount = 0;
    for (const review of (reviews || [])) {
      for (const c of (review.classifications || [])) {
        if (c.suggested) continue;
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
        // 先从模板找，再从未分类评论实际数据中取（支持自定义标签）
        const templateTag = (dim.tags || []).find((t) => t.id === tagId);
        const tagName = templateTag?.name || allTagNames.get(`${dim.id}::${tagId}`) || '';
        return { tagId, tagName, count };
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

// 更新已分类评论的分类列表（全量替换），重新计算统计。
async function updateReviewClassifications(analysisId, reviewId, body) {
  const { classifications } = body;
  if (!classifications || !Array.isArray(classifications)) {
    throw new Error('请提供 classifications 数组。');
  }

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const review = (results.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) throw new Error('评论不存在。');

  // 替换分类列表，保留 suggested 标记以支持待确认流程
  review.classifications = classifications.map((c) => ({
    dimensionId: c.dimensionId || '',
    dimensionName: c.dimensionName || '',
    tagId: c.tagId || '',
    tagName: c.tagName || '',
    polarity: typeof c.polarity === 'string' && ['正向','负向','中性','需求'].includes(c.polarity) ? c.polarity : '',
    confidence: typeof c.confidence === 'number' ? c.confidence : 1,
    note: typeof c.note === 'string' ? c.note : '',
    ...(c.suggested ? { suggested: true } : { manuallyAssigned: true })
  }));

  // 重新判断 isLowConfidence：有 suggested 标记的分类说明 AI 建议尚未确认，保留在待确认列表
  const threshold = results.summary?.confidenceThreshold || 0.6;
  const hasSuggestions = review.classifications.some((c) => c.suggested);
  if (review.classifications.length === 0) {
    review.isLowConfidence = true;
  } else if (hasSuggestions) {
    review.isLowConfidence = true;
  } else {
    const hasHighEnough = review.classifications.some((c) => c.confidence >= threshold);
    review.isLowConfidence = !hasHighEnough;
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

  // 将手动分配的自定义标签同步到模板中（如果模板中不存在）
  const analysis = analysisStore.get(analysisId);
  if (analysis?.templateId) {
    await syncCustomTagsToTemplate(analysis.templateId, review.classifications);
    // 同步更新 results.template 快照，前端 datalist 依赖此数据
    const syncedTemplate = await templateStore.get(analysis.templateId);
    if (syncedTemplate) {
      results.template = syncedTemplate;
      await analysisStore.saveResults(analysisId, results);
    }
  }

  return { ok: true, review };
}

// 单条评论 AI 重分类：对单条评论调用 LLM 获取分类建议，返回给前端确认。
async function reclassifySingleReview(analysisId, reviewId, body) {
  const analysis = analysisStore.get(analysisId);
  if (!analysis) throw new Error('分析任务不存在。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const review = (results.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) throw new Error('评论不存在。');

  const template = results.template;
  if (!template) throw new Error('模板快照不存在。');

  const apiKey = body.apiKey || analysis.deepseekApiKey;
  if (!apiKey) throw new Error('未找到 API Key。');

  const providerId = body.providerId || 'deepseek';
  const model = body.model || analysis.config?.model || 'deepseek-v4-pro';
  const temperature = body.temperature ?? analysis.config?.temperature ?? 0.1;
  const maxTokens = body.maxTokens || analysis.config?.maxTokens || 8192;

  const batch = [{
    reviewId: review.reviewId,
    starRating: review.starRating || 0,
    reviewText: review.reviewText || ''
  }];

  const classified = await analyzeBatch(batch, template, apiKey, model, {
    temperature,
    maxTokens,
    providerId
  });

  // 返回第一条（也是唯一一条）的分类结果
  const result = classified[0];
  if (!result) throw new Error('AI 未返回分类结果。');

  return {
    reviewId: result.reviewId,
    classifications: result.classifications || [],
    level3: result.level3 || null
  };
}

// 批量评论 AI 重分类：对多条评论调用 LLM 获取分类建议，返回给前端确认。
async function batchReclassifyReviews(analysisId, body) {
  const analysis = analysisStore.get(analysisId);
  if (!analysis) throw new Error('分析任务不存在。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const reviewIds = body.reviewIds;
  if (!Array.isArray(reviewIds) || reviewIds.length === 0) throw new Error('未提供评论 ID。');

  const template = results.template;
  if (!template) throw new Error('模板快照不存在。');

  const apiKey = body.apiKey || analysis.deepseekApiKey;
  if (!apiKey) throw new Error('未找到 API Key。');

  const providerId = body.providerId || 'deepseek';
  const model = body.model || analysis.config?.model || 'deepseek-v4-pro';
  const temperature = body.temperature ?? analysis.config?.temperature ?? 0.1;
  const maxTokens = body.maxTokens || analysis.config?.maxTokens || 8192;

  // 从结果中取出对应评论组成 batch
  const batch = [];
  for (const rid of reviewIds) {
    const review = (results.reviews || []).find((r) => r.reviewId === rid);
    if (review) {
      batch.push({
        reviewId: review.reviewId,
        starRating: review.starRating || 0,
        reviewText: review.reviewText || ''
      });
    }
  }
  if (batch.length === 0) throw new Error('未找到有效的评论。');

  const classified = await analyzeBatch(batch, template, apiKey, model, {
    temperature,
    maxTokens,
    providerId
  });

  return {
    results: classified.map((r) => ({
      reviewId: r.reviewId,
      classifications: r.classifications || [],
      level3: r.level3 || null
    }))
  };
}

// 将评论的自定义标签同步到模板维度中。
async function syncCustomTagsToTemplate(templateId, classifications) {
  const template = await templateStore.get(templateId);
  if (!template || !Array.isArray(template.dimensions)) return;

  let changed = false;
  const dims = template.dimensions;

  for (const c of (classifications || [])) {
    if (!c.manuallyAssigned || !c.tagName) continue;
    const dim = dims.find((d) => d.id === c.dimensionId || d.name === c.dimensionName);
    if (!dim || !Array.isArray(dim.tags)) continue;
    // 检查标签是否已存在（按名称匹配）
    const exists = dim.tags.some((t) => t.name === c.tagName || t.id === c.tagId);
    if (!exists) {
      dim.tags.push({
        id: c.tagId || `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: c.tagName
      });
      changed = true;
    }
  }

  if (changed) {
    await templateStore.update(templateId, { dimensions: dims });
  }
}
// 翻译评论原文：使用 AI 将评论翻译为目标语言，结果写回 analysis results。
async function runTranslation(analysisId, body) {
  const {
    apiKey,
    providerId = 'deepseek',
    model = 'deepseek-v4-pro',
    targetLang = '简体中文',
    temperature = 0.1,
    maxTokens = 4096,
    systemPrompt: customSystemPrompt,
    scope = 'all',
    parallelTasks = 3,
    batchSize = 15,
    customApiBase
  } = body;

  if (!apiKey) throw new Error('请提供 API Key。');

  const analysis = analysisStore.get(analysisId);
  if (!analysis) throw new Error('分析任务不存在。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const allReviews = results.reviews || [];
  if (allReviews.length === 0) throw new Error('没有可翻译的评论。');

  let targetReviews;
  if (scope === 'lowconfidence') {
    targetReviews = allReviews.filter((r) => r.isLowConfidence);
  } else {
    targetReviews = allReviews.filter((r) => r.reviewText && r.reviewText.trim());
  }

  if (targetReviews.length === 0) throw new Error('没有需要翻译的评论。');

  const onProgress = (p) => {
    analysisStore.update(analysisId, {
      progress: Math.round(10 + (p.completed / p.total) * 90),
      currentStep: `翻译中 ${Math.round(p.completed / p.total * 100)}%`
    });
  };

  const translatedMap = await translateAllReviews({
    allReviews: targetReviews,
    apiKey,
    providerId,
    model,
    targetLang,
    temperature,
    maxTokens,
    systemPrompt: customSystemPrompt,
    parallelTasks,
    batchSize,
    customApiBase,
    onProgress
  });

  let translatedCount = 0;
  for (const review of allReviews) {
    const translated = translatedMap.get(review.reviewId);
    if (translated) {
      review.translatedText = translated;
      translatedCount += 1;
    }
  }

  await analysisStore.saveResults(analysisId, results);
  analysisStore.update(analysisId, {
    progress: 100,
    currentStep: `翻译完成：${translatedCount} 条`
  });

  return { translatedCount, total: targetReviews.length };
}


// 基于手动修正记录，调用 DeepSeek 生成 prompt 优化建议。
async function generatePromptOptimization(analysisId, body) {
  const { edits } = body;
  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    throw new Error('请提供至少一条修正记录。');
  }

  const analysis = analysisStore.get(analysisId);
  if (!analysis) throw new Error('分析任务不存在。');

  const results = await analysisStore.loadResults(analysisId);
  if (!results) throw new Error('分析结果不存在。');

  const template = results.template;
  if (!template) throw new Error('模板快照不存在。');

  const apiKey = analysis.deepseekApiKey;
  if (!apiKey) throw new Error('该分析任务没有 DeepSeek API Key。');

  // 获取当前使用的 system prompt
  const currentPrompt = analysis.customPrompt?.systemPrompt || '';

  // 构建维度/标签参考列表
  const dimensionsList = (template.dimensions || []).map((dim) => {
    const tags = (dim.tags || []).map((t) => `  - ${t.name}${t.productMeaning ? `：${t.productMeaning}` : ''}`).join('\n');
    return `### ${dim.name}${dim.productMeaning ? `（${dim.productMeaning}）` : ''}\n${tags}`;
  }).join('\n\n');

  // 构建修正记录摘要（限制数量避免 prompt 过长）
  const MAX_EDITS_IN_PROMPT = 30;
  const editsSlice = edits.slice(0, MAX_EDITS_IN_PROMPT);
  const editsSummary = editsSlice.map((e, i) => {
    const origTags = (e.originalClasses || []).map((c) => `${c.dimensionName} > ${c.tagName}`).join(', ') || '(无分类)';
    const newTags = (e.newClasses || []).map((c) => `${c.dimensionName} > ${c.tagName}`).join(', ') || '(清空分类)';
    return `${i + 1}. 评论文本: "${(e.reviewText || '').slice(0, 100)}"\n   变更类型: ${e.changeType || 'unknown'}\n   AI 原分类: ${origTags}\n   手动修正为: ${newTags}`;
  }).join('\n\n');

  const systemPrompt = `你是一个专业的 prompt engineering 专家。用户使用 AI 对 APP 评论进行语义分类，然后手动修正了一些分类错误。你的任务是分析这些修正记录，找出 AI 分类的系统性错误模式，并给出具体的 prompt 改进建议。

## 输出格式
请严格按以下 JSON 格式输出（不要输出其他文字）：
{
  "suggestions": [
    {
      "severity": "high|medium|low",
      "category": "标签混淆|维度遗漏|过度分类|分类不足|其他",
      "problem": "一句话描述问题",
      "affectedTags": ["标签名1", "标签名2"],
      "promptFix": "具体的 prompt 修改建议，可直接使用",
      "exampleReviews": ["示例评论片段"]
    }
  ],
  "summary": "用一句话总结主要问题和修正方向"
}

## 规则
1. 关注修正的模式/规律，不要逐条罗列修正记录
2. 同一类问题合并为一条建议
3. severity 判断标准：high=出现 5 次以上的模式问题，medium=出现 2-4 次，low=偶发
4. promptFix 要具体可操作，包含判断标准和示例，可直接添加到 prompt 中
5. 用中文输出`;

  const userPrompt = `## 模板维度/标签结构
${dimensionsList}

## 当前使用的 System Prompt
${currentPrompt || '(使用默认 prompt)'}

## 手动修正记录（共 ${edits.length} 条，以下展示前 ${editsSlice.length} 条）
${editsSummary}

请分析以上修正记录，输出 prompt 优化建议。`;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: analysis.config?.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API 请求失败 (HTTP ${response.status})：${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 返回了空响应。');
  }

  // 解析 JSON（兼容 markdown 代码块包裹）
  let jsonText = content.trim();
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // 尝试提取 JSON 对象
    const objMatch = jsonText.match(/\{[\s\S]*\}/);
    if (objMatch) {
      parsed = JSON.parse(objMatch[0]);
    } else {
      throw new Error('无法解析 DeepSeek 返回的优化建议。');
    }
  }

  return {
    suggestions: parsed.suggestions || [],
    summary: parsed.summary || ''
  };
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

// ===== 竞品对比辅助函数 =====

// 按模板分组已完成的分析任务，每组至少 2 个 App 才有对比意义。
// 从关联的下载任务中提取商店链接。
function resolveStoreUrl(analysis) {
  const downloadJobIds = analysis.downloadJobIds || [];
  for (const id of downloadJobIds) {
    const downloadJob = store.get(id);
    if (downloadJob) {
      const storeUrls = downloadJob.app?.storeUrls || {};
      const stores = downloadJob.app?.stores || [];
      // 优先返回 Google Play 链接，其次 App Store
      if (stores.includes('android') && storeUrls.android) return storeUrls.android;
      if (stores.includes('ios') && storeUrls.ios) return storeUrls.ios;
      // 回退：取任意第一个
      const first = Object.values(storeUrls)[0];
      if (first) return first;
    }
  }
  return null;
}

// ===== 对比报告持久化 =====

const compareReportsIndexPath = path.join(compareReportsDir, 'index.json');

function readCompareReportsIndex() {
  try {
    const raw = readFileSync(compareReportsIndexPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeCompareReportsIndex(index) {
  mkdirSync(compareReportsDir, { recursive: true });
  writeFileSync(compareReportsIndexPath, JSON.stringify(index, null, 2), 'utf8');
}

function saveCompareReport(report) {
  const reportId = randomUUID();
  const now = new Date().toISOString();
  const index = readCompareReportsIndex();

  const entry = {
    reportId,
    templateName: report.templateName || '',
    appNames: (report.apps || []).map((a) => a.appName),
    appCount: (report.apps || []).length,
    createdAt: now
  };

  // 保存完整报告
  writeFileSync(path.join(compareReportsDir, `${reportId}.json`), JSON.stringify({ ...report, reportId, createdAt: now }, null, 2), 'utf8');

  // 更新索引
  index.unshift(entry);
  if (index.length > 50) index.length = 50;
  writeCompareReportsIndex(index);

  return { reportId, createdAt: now };
}

function loadCompareReport(reportId) {
  const filePath = path.join(compareReportsDir, `${reportId}.json`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function deleteCompareReportById(reportId) {
  const filePath = path.join(compareReportsDir, `${reportId}.json`);
  try { unlinkSync(filePath); } catch { /* ignore */ }
  const index = readCompareReportsIndex().filter((e) => e.reportId !== reportId);
  writeCompareReportsIndex(index);
}

function buildCompareOptions() {
  const completed = analysisStore.list().filter((a) => a.status === 'completed');
  const byTemplate = new Map();

  for (const analysis of completed) {
    const key = analysis.templateId;
    if (!byTemplate.has(key)) {
      byTemplate.set(key, {
        templateId: key,
        templateName: analysis.templateName || key,
        analyses: []
      });
    }
    byTemplate.get(key).analyses.push({
      id: analysis.id,
      app: analysis.app,
      storeUrl: resolveStoreUrl(analysis),
      summary: analysis.summary,
      completedAt: analysis.completedAt
    });
  }

  return Array.from(byTemplate.values())
    .filter((g) => g.analyses.length >= 2)
    .sort((a, b) => b.analyses.length - a.analyses.length);
}

// 加载多个分析结果，聚合为维度×标签×App 对比矩阵。
async function buildCompareReport(body) {
  const { analysisIds } = body;
  if (!Array.isArray(analysisIds) || analysisIds.length < 2) {
    throw new Error('请至少选择 2 个已完成的解析任务进行对比。');
  }

  // 加载所有结果
  const results = [];
  for (const id of analysisIds) {
    const analysis = analysisStore.get(id);
    if (!analysis) throw new Error(`分析任务 ${id} 不存在。`);
    if (analysis.status !== 'completed') throw new Error(`分析任务 ${id} 尚未完成。`);

    const result = await analysisStore.loadResults(id);
    if (!result) throw new Error(`分析任务 ${id} 的结果文件不存在。`);

    // 验证同模板
    if (results.length > 0 && result.template?.id !== results[0].result.template?.id) {
      throw new Error('所选分析任务使用了不同的模板，无法对比。请选择同一模板下的 App。');
    }

    results.push({ analysis, result });
  }

  const template = results[0].result.template || {};
  const apps = results.map(({ analysis, result }) => ({
    analysisId: analysis.id,
    app: analysis.app || {},
    storeUrl: resolveStoreUrl(analysis),
    totalReviews: result.summary?.totalReviews || 0,
    classifiedCount: result.summary?.classifiedCount || 0,
    dimensionStats: result.dimensionStats || []
  }));

  // 构建标签级对比矩阵
  const dimensionComparison = [];
  const allDimIds = new Set();
  for (const app of apps) {
    for (const ds of app.dimensionStats) {
      allDimIds.add(ds.dimensionId);
    }
  }

  for (const dimId of allDimIds) {
    const dimTemplate = (template.dimensions || []).find((d) => d.id === dimId) || {};
    const dimName = dimTemplate.name || dimId;
    const productMeaning = dimTemplate.productMeaning || '';

    // 收集所有标签
    const allTags = new Map();
    for (const app of apps) {
      const ds = app.dimensionStats.find((d) => d.dimensionId === dimId);
      if (!ds) continue;
      for (const tag of (ds.tags || [])) {
        if (!allTags.has(tag.tagId)) {
          allTags.set(tag.tagId, { tagId: tag.tagId, tagName: tag.tagName, apps: [] });
        }
      }
    }

    // 填充每个 App 的标签计数 + notes
    const appTotals = apps.map((app) => {
      const ds = app.dimensionStats.find((d) => d.dimensionId === dimId);
      return ds?.count || 0;
    });

    for (const [tagId, tagEntry] of allTags) {
      tagEntry.apps = apps.map((app) => {
        const ds = app.dimensionStats.find((d) => d.dimensionId === dimId);
        const tagStat = (ds?.tags || []).find((t) => t.tagId === tagId);
        // 从原始评论中收集该标签下的所有 note（去重去空，最多20条）
        const resultItem = results.find((r) => r.analysis.id === app.analysisId);
        const reviews = resultItem?.result?.reviews || [];
        const notes = [];
        const seenNotes = new Set();
        for (const review of reviews) {
          for (const c of (review.classifications || [])) {
            if (c.dimensionId === dimId && c.tagId === tagId && c.note && !seenNotes.has(c.note)) {
              seenNotes.add(c.note);
              notes.push(c.note);
              if (notes.length >= 20) break;
            }
          }
          if (notes.length >= 20) break;
        }
        return { analysisId: app.analysisId, count: tagStat?.count || 0, notes };
      });
    }

    // 标签按总计数降序排列
    const tags = Array.from(allTags.values()).sort((a, b) => {
      const sumA = a.apps.reduce((s, x) => s + x.count, 0);
      const sumB = b.apps.reduce((s, x) => s + x.count, 0);
      return sumB - sumA;
    });

    dimensionComparison.push({
      dimensionId: dimId,
      dimensionName: dimName,
      productMeaning,
      tags,
      appTotals
    });
  }

  // 维度排序：按模板原始顺序
  const templateOrder = (template.dimensions || []).map((d) => d.id);
  dimensionComparison.sort((a, b) => {
    const ai = templateOrder.indexOf(a.dimensionId);
    const bi = templateOrder.indexOf(b.dimensionId);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  return {
    template: { name: template.name || '', dimensions: template.dimensions || [] },
    apps,
    dimensionComparison
  };
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
