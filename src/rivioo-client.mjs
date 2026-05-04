import dns from 'node:dns';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Rivioo 的后端地址从它的线上首页里动态识别。
// 这样即使 Rivioo 更换后端域名，我们的下载器也不至于马上失效。
dns.setDefaultResultOrder('ipv4first');

const RIVIOO_HOME = 'https://www.rivioo.app/';
const FALLBACK_API_BASE = 'https://rivioo-api.up.railway.app/api';
const DEFAULT_EMAIL = 'local@download.invalid';

// 缓存已经识别出的 API 地址，避免一次页面会话或一次脚本运行中反复请求 Rivioo 首页。
let cachedApiBase = null;

export { DEFAULT_EMAIL };

// 业务目的：开始下载前，先找到 Rivioo 当前正在使用的后端接口。
// 这样满足“运行时自动获取最新后端接口”的要求，而不是只依赖写死的地址。
export async function resolveRiviooApiBase({ refresh = false } = {}) {
  if (process.env.RIVIOO_API_BASE) {
    cachedApiBase = trimTrailingSlash(process.env.RIVIOO_API_BASE);
    return cachedApiBase;
  }

  if (cachedApiBase && !refresh) {
    return cachedApiBase;
  }

  try {
    const response = await fetch(RIVIOO_HOME, {
      headers: {
        'user-agent': 'tzweb-rivioo-local-downloader/0.1'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const apiBase = extractApiBase(html);
    if (!apiBase) {
      throw new Error('API_BASE not found in Rivioo homepage.');
    }

    cachedApiBase = trimTrailingSlash(apiBase);
    return cachedApiBase;
  } catch (error) {
    // 如果 Rivioo 首页短暂不可用，使用兜底地址让本地后台仍可尝试工作。
    // 正常情况下仍优先使用实时识别出来的地址。
    cachedApiBase = FALLBACK_API_BASE;
    return cachedApiBase;
  }
}

// Rivioo 前端目前会在页面脚本里声明 API_BASE。
// 这里解析的是公开页面上的配置，不是私有接口；如果页面结构变化，优先改这一处。
export function extractApiBase(html) {
  const apiBaseMatch = html.match(/const\s+API_BASE\s*=\s*isProduction\s*\?\s*['"]([^'"]+)['"]/);
  if (apiBaseMatch?.[1]) return apiBaseMatch[1];

  const railwayApiMatch = html.match(/['"](https:\/\/[^'"]*rivioo[^'"]*\/api)['"]/i);
  if (railwayApiMatch?.[1]) return railwayApiMatch[1];

  return null;
}

// 给命令行脚本使用的轻量参数解析器。
// 网页后台不依赖它，网页后台接收浏览器提交的 JSON。
export function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    if (withoutPrefix === 'help' || withoutPrefix === 'h') {
      args.help = true;
      continue;
    }

    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      args[camelKey(withoutPrefix.slice(0, equalsIndex))] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const key = camelKey(withoutPrefix);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

// 把“商店 URL”或“平台 + App ID”统一成 Rivioo 查询需要的格式。
// 所有入口都先经过这里，避免每个地方各自解析。
export function resolveTarget(args) {
  const url = args.url || args._?.[0];
  if (url) {
    const parsed = parseStoreUrl(url);
    if (!parsed) {
      throw new Error('Could not parse app store URL. Provide a Google Play or App Store app URL.');
    }
    return parsed;
  }

  if (args.platform && args.appId) {
    return {
      store: normalizeStore(args.platform),
      appId: args.appId,
      country: null
    };
  }

  throw new Error('Missing target app. Pass --url, or pass both --platform and --app-id.');
}

// 这一版只支持两个最核心的商店链接格式：
// Google Play 包名链接，以及 App Store 的数字 track ID 链接。
export function parseStoreUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'play.google.com' && url.pathname.endsWith('/apps/details')) {
    const appId = url.searchParams.get('id');
    if (!appId) return null;
    return {
      store: 'android',
      appId,
      country: url.searchParams.get('gl')
    };
  }

  if ((hostname === 'apps.apple.com' || hostname === 'itunes.apple.com') && url.pathname.includes('/app/')) {
    const segments = url.pathname.split('/').filter(Boolean);
    const appIndex = segments.findIndex((segment) => segment.toLowerCase() === 'app');
    const idSegment = segments.find((segment) => /^id\d+$/i.test(segment));
    if (appIndex === -1 || !idSegment) return null;

    const possibleCountry = segments[appIndex - 1];
    const country = /^[a-z]{2}$/i.test(possibleCountry || '') ? possibleCountry : null;

    return {
      store: 'ios',
      appId: idSegment.slice(2),
      country
    };
  }

  return null;
}

// 国家码会影响 Rivioo 读取哪个地区商店、哪一批评论。
export function normalizeCountry(country) {
  const value = String(country).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(value)) {
    throw new Error('Country must be a two-letter country code, for example us or cn.');
  }
  return value;
}

export function parsePositiveInt(value, name) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

// Rivioo 的语言筛选以数组形式提交。
// 目前把 all 映射为 en，是因为 Rivioo 自己的前端也是这样组织导出参数的。
export function parseLanguages(value) {
  const languages = String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (languages.length === 0) {
    throw new Error('Language must not be empty.');
  }

  if (languages.includes('all')) {
    return ['en'];
  }

  for (const language of languages) {
    if (!/^[a-z]{2}$/.test(language)) {
      throw new Error('Language values must be two-letter language codes, for example en or fr.');
    }
  }

  return languages;
}

// CSV 方便后续程序解析，XLSX 方便人工用 Excel 查看。
// 两种格式共用同一条下载流程，不拆成两个产品功能。
export function parseFormats(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === 'both' || normalized === 'all') return ['csv', 'xlsx'];

  const formats = normalized
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (formats.length === 0) {
    throw new Error('Format must be csv, xlsx, or both.');
  }

  for (const format of formats) {
    if (!['csv', 'xlsx'].includes(format)) {
      throw new Error('Format must be csv, xlsx, or both.');
    }
  }

  return [...new Set(formats)];
}

// 排序选项保持和 Rivioo 的参数名一致，后续排查接口问题时更直观。
export function mapSortOption(value) {
  const mapping = {
    newest: 'newest',
    oldest: 'oldest',
    rating: 'rating',
    helpful: 'helpful'
  };

  const mapped = mapping[String(value).toLowerCase()];
  if (!mapped) {
    throw new Error('Sort must be newest, oldest, rating, or helpful.');
  }
  return mapped;
}

// lookup 会把商店里的 App 标识转换成完整 App 信息：
// 名称、图标、商店 ID、支持的平台，以及启动导出所需字段。
export async function lookupApp(target, country, apiBase) {
  const url = new URL(`${apiBase}/search/lookup`);
  url.searchParams.set('appId', target.appId);
  url.searchParams.set('store', target.store);
  url.searchParams.set('country', country);

  const response = await fetchJson(url, { method: 'GET' });
  if (!response.result) {
    throw new Error('Rivioo lookup did not return an app result.');
  }
  return response.result;
}

// 继承 Rivioo 的产品限制：App Store 最多 500 条，Google Play 最多 10,000 条。
// 在本地先做上限处理，避免用户填更大数字后出现不可预期结果。
export function capReviewCount(count, app) {
  const stores = Array.isArray(app.stores) ? app.stores : [];
  const isIosOnly = stores.includes('ios') && !stores.includes('android');

  if (isIosOnly && count > 500) {
    return {
      count: 500,
      warning: '导出限制：App Store 单次最多导出 500 条评论，本次已自动按 500 条处理。'
    };
  }

  if (count > 10000) {
    return {
      count: 10000,
      warning: '导出限制：Google Play 单次最多导出 10,000 条评论，本次已自动按 10,000 条处理。'
    };
  }

  return { count, warning: null };
}

// 这个请求体基本复刻 Rivioo 前端发给后端的参数。
// 集中在一个函数里，方便以后对照 Rivioo 变化做调整。
export function buildExportPayload({ jobId, app, maxReviews, sortBy, languages, country, formats, email }) {
  return {
    jobId,
    email,
    appId: app.appId ?? null,
    bundleId: app.bundleId ?? null,
    trackId: app.trackId ?? null,
    appName: app.name,
    appTitle: app.name,
    appUrl: app.storeUrls?.ios || '',
    stores: app.stores,
    maxReviews,
    sortBy,
    languages,
    countries: [country],
    formats
  };
}

// 通知 Rivioo 创建导出任务。
// 文件不会立刻生成，所以调用方后面还要轮询任务状态。
export async function startExport(payload, apiBase) {
  const response = await fetchJson(`${apiBase}/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (response.status !== 'started') {
    throw new Error(`Rivioo export did not start. Response status: ${response.status || 'unknown'}`);
  }

  return response;
}

// Rivioo 的导出是异步的。
// 这里一直等到远端任务生成可下载文件，同时把进度传给命令行或网页界面。
export async function waitForCompletion(jobId, apiBase, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const pollMs = options.pollMs ?? 3000;
  const onProgress = options.onProgress || (() => {});
  const deadline = Date.now() + timeoutMs;
  let lastProgress = null;

  while (Date.now() < deadline) {
    const status = await getExportStatus(jobId, apiBase);

    if (status.progress !== lastProgress) {
      lastProgress = status.progress;
      onProgress(status);
    }

    if (status.status === 'completed' && status.fileIds) {
      return status;
    }

    if (status.status === 'failed') {
      throw new Error(status.errorMessage || 'Rivioo export failed.');
    }

    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for Rivioo export after ${timeoutMs}ms.`);
}

// 状态查询单独封装，后续如果要在后台展示更细的任务诊断，不需要重复写请求逻辑。
export async function getExportStatus(jobId, apiBase) {
  return fetchJson(`${apiBase}/export/status/${encodeURIComponent(jobId)}`, {
    method: 'GET'
  });
}

// 把 Rivioo 生成的文件下载到本地。
// 后续分析功能应该读取本地文件，而不是每次重新请求 Rivioo。
export async function downloadFiles({ fileIds, formats, email, outputDir, app, country, apiBase }) {
  const downloads = [];
  await mkdir(outputDir, { recursive: true });

  for (const format of formats) {
    const fileId = fileIds?.[format];
    if (!fileId) {
      downloads.push({
        format,
        skipped: true,
        reason: `Rivioo did not return a ${format} file id.`
      });
      continue;
    }

    const url = new URL(`${apiBase}/download/${encodeURIComponent(fileId)}`);
    url.searchParams.set('email', email);

    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Download failed for ${format}: HTTP ${response.status} ${body.slice(0, 200)}`);
    }

    const filename = getDownloadFilename(response, app, country, format);
    const filePath = path.join(outputDir, filename);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, bytes);

    downloads.push({
      format,
      fileId,
      filename,
      path: filePath,
      bytes: bytes.length
    });
  }

  if (!downloads.some((item) => !item.skipped)) {
    throw new Error('No files were downloaded.');
  }

  return downloads;
}

// 一次完整的评论下载流程。
// 命令行和网页后台都调用它，保证 Rivioo 导出的规则只有这一份实现。
export async function runReviewDownload(options) {
  const apiBase = options.apiBase || await resolveRiviooApiBase({ refresh: options.refreshApiBase });
  const target = resolveTarget(options);
  const country = normalizeCountry(options.country || target.country || 'us');
  const requestedCount = parsePositiveInt(options.count || options.maxReviews || '1000', 'count');
  const sortBy = mapSortOption(options.sort || 'newest');
  const languages = parseLanguages(options.language || 'en');
  const formats = parseFormats(options.format || 'csv');
  const email = options.email || process.env.RIVIOO_EMAIL || DEFAULT_EMAIL;

  options.onProgress?.({
    status: 'lookup',
    progress: 2,
    currentStep: '正在识别目标 App'
  });

  const app = await lookupApp(target, country, apiBase);
  const cap = capReviewCount(requestedCount, app);
  const jobId = options.jobId || randomUUID();
  const payload = buildExportPayload({
    jobId,
    app,
    maxReviews: cap.count,
    sortBy,
    languages,
    country,
    formats,
    email
  });

  options.onProgress?.({
    status: 'starting',
    progress: 4,
    currentStep: '正在创建导出任务',
    app,
    warning: cap.warning
  });

  await startExport(payload, apiBase);
  const status = await waitForCompletion(jobId, apiBase, {
    timeoutMs: options.timeoutMs || 180000,
    onProgress: options.onProgress
  });

  options.onProgress?.({
    status: 'downloading',
    progress: 98,
    currentStep: '正在保存到本地'
  });

  const downloads = await downloadFiles({
    fileIds: status.fileIds,
    formats,
    email,
    outputDir: options.outputDir,
    app,
    country,
    apiBase
  });

  return {
    id: options.id || jobId,
    generatedAt: new Date().toISOString(),
    apiBase,
    app,
    target,
    country,
    languages,
    sortBy,
    requestedCount,
    effectiveCount: cap.count,
    exportedCount: status.reviewCount ?? null,
    riviooJobId: jobId,
    warning: cap.warning,
    downloads
  };
}

// 文件名来自外部数据，需要移除可能破坏本地文件系统或路径处理的字符。
export function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

// 接受常见的平台叫法，并统一成 Rivioo 需要的 store 值。
function normalizeStore(platform) {
  const value = String(platform).toLowerCase();
  if (['ios', 'appstore', 'app-store', 'apple'].includes(value)) return 'ios';
  if (['android', 'googleplay', 'google-play', 'play'].includes(value)) return 'android';
  throw new Error('Platform must be ios or android.');
}

// 优先使用 Rivioo 返回的文件名，因为里面带有任务时间戳。
// 如果响应里没有文件名，就生成一个可读的本地文件名。
function getDownloadFilename(response, app, country, format) {
  const disposition = response.headers.get('content-disposition');
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match?.[1]) {
    return sanitizeFilename(decodeURIComponent(match[1]));
  }

  const appName = sanitizeFilename(app.name || 'app');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${appName}_${country}_${timestamp}.${format}`;
}

// Rivioo 的 API 正常应返回 JSON。
// 如果没有返回 JSON，错误信息里保留一小段响应内容，方便定位问题。
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Rivioo returned non-JSON response: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`Rivioo request failed: HTTP ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  }

  return json;
}

// 把命令行参数名从 --output-dir 这类格式转换成 outputDir。
function camelKey(key) {
  return key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

// 统一接口地址格式，避免后面拼接 /search、/export、/download 时出现双斜杠。
function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
