const state = {
  // 页面把服务端任务列表临时放在内存里，并定时刷新。
  // 真正的任务记录仍然是后端的 data/reviews/jobs.json。
  jobs: [],
  polling: null
};

// 集中查找页面元素，后面的代码就能专注在产品行为上：
// 提交下载、展示进度、提供本地文件链接。
const els = {
  apiBase: document.querySelector('#apiBase'),
  runtimeNotice: document.querySelector('#runtimeNotice'),
  refreshApi: document.querySelector('#refreshApi'),
  form: document.querySelector('#downloadForm'),
  submitButton: document.querySelector('#submitButton'),
  reloadJobs: document.querySelector('#reloadJobs'),
  jobsTable: document.querySelector('#jobsTable')
};

init();

// 页面启动流程：加载后端配置、加载已有本地任务，然后持续刷新任务表。
async function init() {
  bindEvents();

  try {
    showRuntimeNoticeIfNeeded();
    await Promise.all([loadConfig(), loadJobs()]);
    startPolling();
  } catch (error) {
    showRuntimeNotice(error);
    renderJobs();
  }
}

function bindEvents() {
  // 表单提交只创建后台任务，任务表通过轮询更新。
  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitDownload();
  });

  els.reloadJobs.addEventListener('click', loadJobs);
  els.refreshApi.addEventListener('click', refreshApiBase);
  els.jobsTable.addEventListener('click', async (event) => {
    // 删除按钮
    const deleteBtn = event.target.closest('[data-job-id]');
    if (deleteBtn) {
      event.preventDefault();
      await deleteJob(deleteBtn.dataset.jobId);
      return;
    }
    // 查看原文件按钮
    const revealButton = event.target.closest('[data-reveal-url]');
    if (!revealButton) return;

    event.preventDefault();
    await revealLocalFile(revealButton);
  });
}

// 展示当前识别出的 Rivioo 后端地址。
// 这个依赖对产品很关键，所以保留在下载表单底部，方便排查接口变化。
async function loadConfig() {
  const data = await fetchJson('/api/config');
  els.apiBase.textContent = data.apiBase;

  const emailInput = document.querySelector('#email');
  if (!emailInput.value && data.defaultEmail) {
    emailInput.placeholder = data.defaultEmail;
  }
}

// 这个页面必须通过本地服务访问，不能直接用 file:// 打开。
// 直接打开文件时，浏览器没有 /api/config、/api/jobs 这些后端接口。
function showRuntimeNoticeIfNeeded() {
  if (window.location.protocol === 'file:') {
    showRuntimeNotice();
  }
}

function showRuntimeNotice(error) {
  if (!els.runtimeNotice) return;
  els.runtimeNotice.hidden = false;
  if (error) {
    els.runtimeNotice.textContent = `本地下载服务未连接：${error.message}。请运行 npm run dev 后打开控制台输出的 http://localhost:端口 地址。`;
  }
}

// 给产品/管理员的手动兜底操作：
// 如果 Rivioo 在本地服务运行期间更换后端地址，可以直接刷新缓存。
async function refreshApiBase() {
  els.refreshApi.disabled = true;
  try {
    const data = await fetchJson('/api/config/refresh', { method: 'POST' });
    els.apiBase.textContent = data.apiBase;
  } finally {
    els.refreshApi.disabled = false;
  }
}

// 浏览器不能直接打开本地 Finder，所以这里请求本地 Node 服务代办。
// 服务端会在 data/reviews/files 目录里定位真实文件，并让 Finder 选中它。
async function revealLocalFile(button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '正在打开...';

  try {
    await fetchJson(button.dataset.revealUrl, { method: 'POST' });
    button.textContent = '已打开';
    setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
  } catch (error) {
    button.textContent = originalText;
    button.disabled = false;
    window.alert(`打开本地文件失败：${error.message}`);
  }
}

async function deleteJob(jobId) {
  if (!window.confirm('确定要删除此下载任务及其关联文件吗？此操作不可撤销。')) return;
  try {
    await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    state.jobs = state.jobs.filter((j) => j.id !== jobId);
    renderJobs();
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
}

// 提交只负责启动任务，不等待完整 CSV/XLSX 导出结束。
// 评论下载可能耗时较长，不适合让浏览器请求一直挂着。
async function submitDownload() {
  const originalText = els.submitButton.textContent;
  els.submitButton.disabled = true;
  els.submitButton.textContent = '正在创建任务...';

  try {
    const payload = formPayload();
    const data = await fetchJson('/api/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    state.jobs = upsertJob(state.jobs, data.job);
    renderJobs();
  } catch (error) {
    // 表单级错误需要直接告诉操作者，否则只看任务表会误以为没有响应。
    window.alert(`下载任务创建失败：${error.message}`);
  } finally {
    els.submitButton.disabled = false;
    els.submitButton.textContent = originalText;
  }
}

// 把页面上的表单字段转换成 server.mjs 期望的 JSON 参数。
function formPayload() {
  const form = new FormData(els.form);
  return {
    url: form.get('url')?.trim(),
    count: Number.parseInt(form.get('count') || '1000', 10),
    country: form.get('country')?.trim().toLowerCase(),
    language: form.get('language')?.trim().toLowerCase(),
    format: form.get('format'),
    sort: form.get('sort'),
    email: form.get('email')?.trim()
  };
}

// 通过后端重新读取本地任务历史。
async function loadJobs() {
  const data = await fetchJson('/api/jobs');
  state.jobs = data.jobs || [];
  renderJobs();
}

// MVP 阶段用简单轮询就够了。
// 如果以后任务更长、多人同时使用，再换成 SSE 或 WebSocket。
function startPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(loadJobs, 1800);
}

// 每次直接重画整张任务表。
// MVP 任务量小，全量重画比逐行更新更简单，也更不容易出错。
function renderJobs() {
  if (state.jobs.length === 0) {
    els.jobsTable.innerHTML = '<tr><td colspan="7" class="empty">还没有下载任务。</td></tr>';
    return;
  }

  els.jobsTable.innerHTML = state.jobs.map((job) => `
    <tr>
      <td>${appCell(job)}</td>
      <td>${statusCell(job)}</td>
      <td>${reviewCell(job)}</td>
      <td>${inputCell(job)}</td>
      <td>${filesCell(job)}</td>
      <td>${dateCell(job.updatedAt || job.createdAt)}</td>
      <td><br><a class="action-link delete-link" data-job-id="${escapeAttr(job.id)}">删除</a></td>
    </tr>
  `).join('');
}

// App 列刻意做成图标 + 名称。
// 后续下载多个竞品时，比只看 ID 更容易扫读。
function appCell(job) {
  const app = job.app || job.result?.app;
  const name = escapeHtml(app?.name || '等待识别 App');
  const developer = escapeHtml(app?.developer || app?.stores?.join(', ') || '');
  const icon = app?.icon ? `<img class="app-icon" src="${escapeAttr(app.icon)}" alt="">` : '<div class="app-icon"></div>';

  return `
    <div class="app-cell">
      ${icon}
      <div>
        <div>${name}</div>
        <div class="muted">${developer}</div>
      </div>
    </div>
  `;
}

// 状态列同时展示本地状态、Rivioo 进度、警告和错误。
// 非技术同学不打开日志，也能大致看懂任务发生了什么。
function statusCell(job) {
  const status = escapeHtml(job.status);
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  const step = escapeHtml(stepText(job.currentStep || ''));
  const warning = job.warning ? `<div class="warning">${escapeHtml(job.warning)}</div>` : '';
  const error = job.error ? `<div class="warning">${escapeHtml(job.error)}</div>` : '';

  return `
    <span class="status-pill ${status}">${statusText(status)}</span>
    <div class="progress-track"><div class="progress-fill" style="width: ${progress}%"></div></div>
    <div class="muted">${progress}% ${step}</div>
    ${warning}
    ${error}
  `;
}

// requested 和 effective 可能不同，因为 Rivioo 对 iOS/Android 有导出上限。
// 两个都展示，避免用户以为系统静默少下载了。
function reviewCell(job) {
  const result = job.result;
  const exported = result?.exportedCount ?? '-';
  const requested = result?.requestedCount ?? job.input?.count ?? '-';
  const effective = result?.effectiveCount && result.effectiveCount !== result.requestedCount
    ? `<div class="muted">实际请求 ${result.effectiveCount}</div>`
    : '';

  return `
    <div>${exported}</div>
    <div class="muted">计划请求 ${requested}</div>
    ${effective}
  `;
}

// 输入摘要用于确认文件来自正确的国家、语言、格式和排序规则。
function inputCell(job) {
  const input = job.input || {};
  return `
    <div>${escapeHtml(input.country || '-')} / ${escapeHtml(input.language || '-')}</div>
    <div class="muted">${escapeHtml(formatText(input.format || '-'))} · ${escapeHtml(sortText(input.sort || '-'))}</div>
  `;
}

// 已完成任务展示本地文件下载链接。
// 未完成任务明确显示 Not ready，不展示空按钮。
function filesCell(job) {
  const downloads = job.result?.downloads || [];
  const realDownloads = downloads.filter((item) => !item.skipped && item.url);

  if (realDownloads.length === 0) {
    return '<span class="muted">文件未就绪</span>';
  }

  return `
    <div class="file-list">
      ${realDownloads.map((item) => `
        <a class="file-link" href="${escapeAttr(item.url)}">${escapeHtml(item.format.toUpperCase())} 下载</a>
        <button class="file-link view-link" type="button" data-reveal-url="${escapeAttr(item.revealUrl)}">查看原文件</button>
      `).join('')}
    </div>
    <div class="muted">${formatBytes(realDownloads.reduce((sum, item) => sum + (item.bytes || 0), 0))}</div>
  `;
}

function dateCell(value) {
  if (!value) return '-';
  return `<span class="muted">${new Date(value).toLocaleString('zh-CN')}</span>`;
}

// 新建任务先立即放到表格顶部，不必等下一次轮询返回。
function upsertJob(jobs, job) {
  const rest = jobs.filter((item) => item.id !== job.id);
  return [job, ...rest];
}

// 后端状态值保持英文，便于程序判断；页面展示时统一转成中文。
function statusText(status) {
  const map = {
    none: '暂无',
    idle: '待开始',
    queued: '排队中',
    running: '下载中',
    completed: '已完成',
    failed: '失败'
  };
  return map[status] || status;
}

// Rivioo 返回的进度文案可能是英文；这里做一层轻量翻译，保证后台中文化。
function stepText(step) {
  const map = {
    Queued: '已排队',
    Starting: '启动中',
    Completed: '已完成',
    Failed: '失败',
    Running: '下载中',
    'Looking up app from Rivioo': '正在识别目标 App',
    'Starting export job': '正在创建导出任务',
    'Saving export files locally': '正在保存到本地',
    'Initializing export...': '正在初始化导出',
    'Export completed!': '导出完成'
  };
  return map[step] || step || '';
}

function formatText(format) {
  const map = {
    csv: 'CSV',
    xlsx: 'XLSX',
    both: 'CSV + XLSX'
  };
  return map[format] || format;
}

function sortText(sort) {
  const map = {
    newest: '最新优先',
    oldest: '最早优先',
    rating: '高评分优先',
    helpful: '有帮助优先'
  };
  return map[sort] || sort;
}
