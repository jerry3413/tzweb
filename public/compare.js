// 竞品对比页面：同模板多 App 维度标签对比矩阵。
// 沿用 app.js / analysis.js 的模式：state + els + renderXxx 全量重绘。

const state = {
  groups: [],
  currentGroup: null,
  report: null,
  mode: 'matrix',
  v2Report: null,
  v2Loading: false,
  v2History: []
};

const els = {
  runtimeNotice: document.querySelector('#runtimeNotice'),
  templateSelect: document.querySelector('#templateSelect'),
  appCheckItems: document.querySelector('#appCheckItems'),
  generateBtn: document.querySelector('#generateBtn'),
  generateV2Btn: document.querySelector('#generateV2Btn'),
  selectionSection: document.querySelector('#selectionSection'),
  reportSection: document.querySelector('#reportSection'),
  reportTitle: document.querySelector('#reportTitle'),
  reportSummary: document.querySelector('#reportSummary'),
  appOverview: document.querySelector('#appOverview'),
  compareMatrix: document.querySelector('#compareMatrix'),
  backToSelect: document.querySelector('#backToSelect'),
  // V2 elements
  v2ReportSection: document.querySelector('#v2ReportSection'),
  v2ReportTitle: document.querySelector('#v2ReportTitle'),
  v2ReportSummary: document.querySelector('#v2ReportSummary'),
  v2DataOverview: document.querySelector('#v2DataOverview'),
  v2Summary: document.querySelector('#v2Summary'),
  v2UserFocus: document.querySelector('#v2UserFocus'),
  v2Likes: document.querySelector('#v2Likes'),
  v2Suggestions: document.querySelector('#v2Suggestions'),
  v2Complaints: document.querySelector('#v2Complaints'),
  v2TopReviews: document.querySelector('#v2TopReviews'),
  v2CrossCutting: document.querySelector('#v2CrossCutting'),
  v2HistorySection: document.querySelector('#v2HistorySection'),
  v2HistoryList: document.querySelector('#v2HistoryList'),
  backToSelectV2: document.querySelector('#backToSelectV2'),
  modeTabs: document.querySelectorAll('.compare-mode-tab'),
  csvUploadSection: document.querySelector('#csvUploadSection'),
  csvUploadInputs: document.querySelector('#csvUploadInputs')
};

init();

async function init() {
  bindEvents();
  showRuntimeNoticeIfNeeded();

  try {
    await Promise.all([loadOptions(), loadV2History()]);
  } catch (error) {
    showRuntimeNotice(error);
  }
}

function bindEvents() {
  els.templateSelect.addEventListener('change', onTemplateChange);
  els.generateBtn.addEventListener('click', generateReport);
  els.generateV2Btn.addEventListener('click', generateV2Report);
  els.backToSelect.addEventListener('click', backToSelect);
  els.backToSelectV2.addEventListener('click', backToSelect);

  els.modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });
}

function showRuntimeNoticeIfNeeded() {
  if (window.location.protocol === 'file:') {
    showRuntimeNotice();
  }
}

function showRuntimeNotice(error) {
  if (!els.runtimeNotice) return;
  els.runtimeNotice.hidden = false;
  if (error) {
    els.runtimeNotice.textContent = `本地服务未连接：${error.message}。请运行 npm run dev 后打开控制台输出的 http://localhost:端口 地址。`;
  }
}

async function loadOptions() {
  const data = await fetchJson('/api/compare/options');
  state.groups = data.groups || [];
  renderTemplateSelect();
}

function renderTemplateSelect() {
  if (state.groups.length === 0) {
    els.templateSelect.innerHTML = '<option value="">-- 没有可对比的模板（需要至少同一模板下有 2 个已完成的解析任务）--</option>';
    return;
  }

  els.templateSelect.innerHTML = [
    '<option value="">-- 选择模板 --</option>',
    ...state.groups.map((g) => `<option value="${escapeAttr(g.templateId)}">${escapeHtml(g.templateName)}（${g.analyses.length} 个 App）</option>`)
  ].join('');
}

function onTemplateChange() {
  const templateId = els.templateSelect.value;
  state.currentGroup = state.groups.find((g) => g.templateId === templateId) || null;
  renderAppCheckList();
  updateButtonState();
}

function renderAppCheckList() {
  if (!state.currentGroup) {
    els.appCheckItems.innerHTML = '<span class="muted">请先选择模板</span>';
    return;
  }

  const analyses = state.currentGroup.analyses;
  els.appCheckItems.innerHTML = analyses.map((a) => `
    <label class="compare-app-check">
      <input type="checkbox" value="${escapeAttr(a.id)}" data-analysis-id="${escapeAttr(a.id)}" data-app-name="${escapeAttr(a.app?.name || '')}">
      <img class="app-icon" src="${escapeAttr(a.app?.icon || '')}" alt="" style="width: 28px; height: 28px; border-radius: 6px; object-fit: cover;">
      <div style="flex: 1; min-width: 0;">
        <div style="font-weight: 900; font-size: 14px; display: flex; align-items: center; gap: 6px;">
          ${escapeHtml(a.app?.name || '未知 App')}
          ${a.storeUrl ? `<a href="${escapeAttr(a.storeUrl)}" target="_blank" rel="noopener" class="store-link-icon" title="打开商店页面" onclick="event.stopPropagation()">↗</a>` : ''}
        </div>
        <div class="muted">${escapeHtml(a.app?.developer || '')} · ${a.summary?.totalReviews || 0} 条评论</div>
      </div>
    </label>
  `).join('');

  els.appCheckItems.addEventListener('change', () => {
    renderCsvUploadInputs();
    updateButtonState();
  });
}

async function generateReport() {
  const checked = Array.from(els.appCheckItems.querySelectorAll('input:checked'));
  if (checked.length < 2) return;

  const analysisIds = checked.map((cb) => cb.value);
  els.generateBtn.disabled = true;
  els.generateBtn.textContent = '正在生成...';

  try {
    const data = await fetchJson('/api/compare/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysisIds })
    });
    state.report = data;
    renderReport();
  } catch (error) {
    window.alert(`生成对比报告失败：${error.message}`);
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = '生成对比报告';
  }
}

function renderReport() {
  const report = state.report;
  if (!report) return;

  els.selectionSection.hidden = true;
  els.reportSection.hidden = false;

  const apps = report.apps || [];
  els.reportTitle.textContent = `对比报告：${escapeHtml(report.template?.name || '')}`;
  els.reportSummary.textContent = `共 ${apps.length} 个 App，${report.dimensionComparison?.length || 0} 个维度`;

  renderAppOverview(apps);
  renderCompareMatrix(report.dimensionComparison || [], apps);
}

function renderAppOverview(apps) {
  els.appOverview.innerHTML = `
    <div class="compare-app-row">
      ${apps.map((a) => `
        <div class="compare-app-card">
          <img class="compare-app-icon" src="${escapeAttr(a.app?.icon || '')}" alt="">
          <div style="flex: 1; min-width: 0;">
            <div class="compare-app-name">
              ${escapeHtml(a.app?.name || '未知')}
              ${a.storeUrl ? `<a href="${escapeAttr(a.storeUrl)}" target="_blank" rel="noopener" class="store-link-icon" title="打开商店页面">↗</a>` : ''}
            </div>
            <div class="muted">${escapeHtml(a.app?.developer || '')}</div>
            <div style="margin-top: 4px; font-size: 13px;">
              评论 ${a.totalReviews || 0} 条 · 已分类 ${a.classifiedCount || 0} 条
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderCompareMatrix(dimensionComparison, apps) {
  if (dimensionComparison.length === 0) {
    els.compareMatrix.innerHTML = '<div class="empty">没有可对比的维度数据。</div>';
    return;
  }

  // 计算每列的最大值，用于数据条比例
  const colMaxes = [];
  for (let colIdx = 0; colIdx < apps.length; colIdx++) {
    let max = 0;
    for (const dim of dimensionComparison) {
      for (const tag of (dim.tags || [])) {
        const appEntry = (tag.apps || []).find((a) => a.analysisId === apps[colIdx].analysisId);
        if (appEntry && appEntry.count > max) max = appEntry.count;
      }
      const dimTotal = (dim.appTotals || [])[colIdx] || 0;
      if (dimTotal > max) max = dimTotal;
    }
    colMaxes.push(max || 1);
  }

  els.compareMatrix.innerHTML = dimensionComparison.map((dim) => {
    const tags = dim.tags || [];
    const dimTotals = dim.appTotals || [];

    return `
      <table class="compare-matrix">
        <thead>
          <tr>
            <th class="compare-dim-header">
              <div class="compare-dim-name">${escapeHtml(dim.dimensionName)}</div>
              ${dim.productMeaning ? `<div class="muted" style="font-weight: 400; font-size: 12px;">${escapeHtml(dim.productMeaning)}</div>` : ''}
            </th>
            ${apps.map((a) => `<th class="compare-app-col">
              <div class="compare-col-header">
                <img class="compare-col-icon" src="${escapeAttr(a.app?.icon || '')}" alt="">
                <div class="compare-col-name">
                  ${escapeHtml(a.app?.name || '')}
                  ${a.storeUrl ? `<a href="${escapeAttr(a.storeUrl)}" target="_blank" rel="noopener" class="store-link-icon" title="打开商店页面">↗</a>` : ''}
                </div>
              </div>
            </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${tags.map((tag) => `
            <tr>
              <td class="compare-tag-name">${escapeHtml(tag.tagName)}</td>
              ${(tag.apps || []).map((appCount, colIdx) => {
                const count = appCount?.count || 0;
                const notes = appCount?.notes || [];
                const barPct = colMaxes[colIdx] ? Math.round((count / colMaxes[colIdx]) * 100) : 0;
                return `
                  <td class="compare-count-cell${notes.length > 0 ? ' compare-count-cell--has-notes' : ''}">
                    <span class="compare-count-num">${count || '-'}${notes.length > 0 ? `<span class="compare-notes-badge" title="${escapeAttr(notes.join(' | '))}">·${notes.length}</span>` : ''}</span>
                    ${count > 0 ? `<div class="compare-bar-track"><div class="compare-bar-fill" style="width: ${barPct}%"></div></div>` : ''}
                  </td>
                `;
              }).join('')}
            </tr>
          `).join('')}
          <tr class="compare-dim-total">
            <td>合计</td>
            ${dimTotals.map((total, colIdx) => {
              const barPct = colMaxes[colIdx] ? Math.round(((total || 0) / colMaxes[colIdx]) * 100) : 0;
              return `
                <td>
                  <span class="compare-total-num">${total || 0}</span>
                  ${total > 0 ? `<div class="compare-bar-track"><div class="compare-bar-fill" style="width: ${barPct}%"></div></div>` : ''}
                </td>
              `;
            }).join('')}
          </tr>
        </tbody>
      </table>
    `;
  }).join('');
}

function backToSelect() {
  els.selectionSection.hidden = false;
  els.reportSection.hidden = true;
  els.v2ReportSection.hidden = true;
  els.v2HistorySection.hidden = false;
  state.report = null;
  state.v2Report = null;
}

// ===== V2 深度分析 =====

function switchMode(mode) {
  state.mode = mode;
  els.modeTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
  els.csvUploadSection.hidden = mode !== 'deep';
  renderCsvUploadInputs();
  updateButtonState();
}

function getChecked() {
  return Array.from(els.appCheckItems.querySelectorAll('input:checked'));
}

function getCheckedAnalysisIds() {
  return getChecked().map((cb) => cb.value);
}

function getCheckedAppNames() {
  return getChecked().map((cb) => {
    const label = cb.closest('label');
    const nameEl = label?.querySelector('.compare-app-check-name');
    return nameEl?.textContent?.trim() || '';
  });
}

function renderCsvUploadInputs() {
  if (state.mode !== 'deep') {
    els.csvUploadInputs.innerHTML = '';
    return;
  }

  const checked = getChecked();
  if (checked.length === 0) {
    els.csvUploadInputs.innerHTML = '<span class="muted">请先勾选 App</span>';
    return;
  }

  // 保留已有文件的引用
  const existingFiles = state.csvFiles || {};
  state.csvFiles = existingFiles;

  els.csvUploadInputs.innerHTML = checked.map((cb) => {
    const analysisId = cb.value;
    const appName = cb.dataset.appName || cb.value;
    const hasFile = !!existingFiles[analysisId];
    return `<label class="csv-upload-item" style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px;">
      <span style="font-weight: 900; font-size: 13px; min-width: 120px;">${escapeHtml(appName)}</span>
      <input type="file" accept=".csv" data-analysis-id="${escapeAttr(analysisId)}" style="font-size: 13px;">
      ${hasFile ? '<span style="color: var(--accent); font-size: 12px;">已选择</span>' : ''}
    </label>`;
  }).join('');

  // 绑定文件选择事件
  els.csvUploadInputs.querySelectorAll('input[type="file"]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const analysisId = input.dataset.analysisId;
      if (e.target.files.length > 0) {
        state.csvFiles[analysisId] = e.target.files[0];
      } else {
        delete state.csvFiles[analysisId];
      }
      renderCsvUploadInputs();
    });
  });
}

function updateButtonState() {
  const checked = getChecked();
  const isMatrix = state.mode === 'matrix';

  if (isMatrix) {
    els.generateBtn.hidden = false;
    els.generateV2Btn.hidden = true;
    els.generateBtn.disabled = checked.length < 2;
  } else {
    els.generateBtn.hidden = true;
    els.generateV2Btn.hidden = false;
    els.generateV2Btn.disabled = checked.length < 2 || state.v2Loading;
  }
}

async function generateV2Report() {
  const checked = getChecked();
  if (checked.length < 2) return;

  const analysisIds = checked.map((cb) => cb.value);
  state.v2Loading = true;
  els.generateV2Btn.disabled = true;
  els.generateV2Btn.textContent = '正在生成（可能需要 60-120 秒）...';

  try {
    // 读取用户上传的 CSV 文件
    const csvData = {};
    const csvFiles = state.csvFiles || {};
    for (const analysisId of analysisIds) {
      const file = csvFiles[analysisId];
      if (file) {
        csvData[analysisId] = await readFileAsText(file);
      }
    }

    const data = await fetchJson('/api/compare/v2/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysisIds, csvData })
    });
    state.v2Report = data;
    renderV2Report();
    loadV2History();
  } catch (error) {
    window.alert(`生成深度分析报告失败：${error.message}`);
  } finally {
    state.v2Loading = false;
    els.generateV2Btn.disabled = false;
    els.generateV2Btn.textContent = '生成深度分析报告';
    updateButtonState();
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

// ===== V2 深度分析渲染 =====

function renderV2Report() {
  const report = state.v2Report;
  if (!report) return;

  els.selectionSection.hidden = true;
  els.reportSection.hidden = true;
  els.v2HistorySection.hidden = true;
  els.v2ReportSection.hidden = false;

  const apps = report.apps || [];
  els.v2ReportTitle.textContent = `深度分析报告：${escapeHtml(report.templateName || '')}`;
  els.v2ReportSummary.textContent = `共 ${apps.length} 个 App · ${report.reportId ? '已保存至历史' : ''}`;

  renderV2Summary(report.summary || {}, apps);
  renderV2Suggestions(apps);
  renderV2Likes(apps);
  renderV2Complaints(apps);
  renderV2TopReviews(apps);
  renderV2CrossCutting(report.crossCutting);
}

function renderV2Summary(summary, apps) {
  // 兼容旧格式（纯字符串）和新格式（{ userPurposes, insights }）
  const summaryObj = typeof summary === 'string'
    ? { userPurposes: '', insights: summary }
    : (summary || {});
  const hasPurposes = summaryObj.userPurposes && summaryObj.userPurposes.trim();
  const hasInsights = summaryObj.insights && summaryObj.insights.trim();
  if (!hasPurposes && !hasInsights) { els.v2Summary.innerHTML = ''; return; }

  let html = `<div class="v2-section-header"><span class="v2-section-icon">📝</span> 总结 <span class="v2-source-tag">AI 生成</span></div>`;

  if (hasPurposes) {
    html += `<div class="v2-summary-sub"><span class="v2-summary-label">用户使用目的与场景</span><div class="v2-summary-box">${escapeHtml(summaryObj.userPurposes)}</div></div>`;
  }
  if (hasInsights) {
    html += `<div class="v2-summary-sub"><span class="v2-summary-label">综合洞察</span><div class="v2-summary-box">${escapeHtml(summaryObj.insights)}</div></div>`;
  }

  // App 概览条
  html += '<div class="v2-app-overview-row">';
  for (const app of apps) {
    html += `<div class="v2-app-overview-chip"><img src="${escapeAttr(app.appIcon || '')}" alt=""><span>${escapeHtml(app.appName)}</span><span class="muted">${app.totalReviews}条评论 / ${app.classifiedCount}条分类</span></div>`;
  }
  html += '</div>';

  els.v2Summary.innerHTML = html;
}

function renderV2DataOverview(apps) {
  // 已合并到 renderV2Summary 的 App 概览条中，保留空函数避免报错
}
function renderV2Likes(apps) {
  if (apps.length === 0) { els.v2Likes.innerHTML = ''; return; }

  let html = `<div class="v2-section-header"><span class="v2-section-icon">👍</span> 用户喜欢 <span class="v2-source-tag">AI 生成 + 服务端聚合</span></div>`;
  html += '<div class="v2-app-columns">';

  for (const app of apps) {
    html += '<div class="v2-app-col-card">';
    html += `<div class="v2-app-col-title"><img src="${escapeAttr(app.appIcon || '')}" alt="">${escapeHtml(app.appName)}</div>`;

    // AI 叙述
    if (app.likesNarrative) {
      html += `<div class="v2-narrative">${escapeHtml(app.likesNarrative)}</div>`;
    }

    // 聚合数据
    const items = app.likes || [];
    if (items.length > 0) {
      html += '<ul class="v2-agg-list">';
      for (const item of items.slice(0, 8)) {
        html += '<li>';
        html += `<span class="v2-agg-item-name">${escapeHtml(item.tagName)}</span>`;
        html += `<span class="v2-count-chip like">${item.count}</span>`;
        if (item.examples && item.examples[0]) {
          html += `<span class="v2-item-example">"${escapeHtml(item.examples[0].slice(0, 50))}"</span>`;
        }
        html += '</li>';
      }
      html += '</ul>';
    }

    html += '</div>';
  }
  html += '</div>';
  els.v2Likes.innerHTML = html;
}

function renderV2Suggestions(apps) {
  if (apps.length === 0) { els.v2Suggestions.innerHTML = ''; return; }

  let html = `<div class="v2-section-header"><span class="v2-section-icon">💡</span> 用户建议 <span class="v2-source-tag">AI 生成 + 服务端聚合</span></div>`;
  html += '<div class="v2-app-columns">';

  for (const app of apps) {
    html += '<div class="v2-app-col-card">';
    html += `<div class="v2-app-col-title"><img src="${escapeAttr(app.appIcon || '')}" alt="">${escapeHtml(app.appName)}</div>`;

    // AI 叙述（包含 [数字人提到] 标注）
    if (app.suggestionsNarrative) {
      html += `<div class="v2-narrative">${renderCountBadges(escapeHtml(app.suggestionsNarrative))}</div>`;
    }

    // 聚合数据
    const items = app.suggestions || [];
    if (items.length > 0) {
      html += '<ul class="v2-agg-list">';
      for (const item of items.slice(0, 8)) {
        html += '<li>';
        html += `<span class="v2-agg-item-name">${escapeHtml(item.description || item.tagName)}</span>`;
        html += `<span class="v2-count-chip suggestion">${item.count}次</span>`;
        html += '</li>';
      }
      html += '</ul>';
    }

    html += '</div>';
  }
  html += '</div>';
  els.v2Suggestions.innerHTML = html;
}

// 将文案中的 [数字人提到] / [数字人] 等标注渲染为角标
function renderCountBadges(text) {
  return text.replace(/\[(\d+)人[^\]]*\]/g, '<span class="v2-count-badge">$1人</span>');
}

function renderV2Complaints(apps) {
  if (apps.length === 0) { els.v2Complaints.innerHTML = ''; return; }

  let html = `<div class="v2-section-header"><span class="v2-section-icon">👎</span> 用户抱怨 <span class="v2-source-tag">AI 生成 + 服务端聚合</span></div>`;
  html += '<div class="v2-app-columns">';

  for (const app of apps) {
    html += '<div class="v2-app-col-card">';
    html += `<div class="v2-app-col-title"><img src="${escapeAttr(app.appIcon || '')}" alt="">${escapeHtml(app.appName)}</div>`;

    // AI 叙述
    if (app.complaintsNarrative) {
      html += `<div class="v2-narrative">${escapeHtml(app.complaintsNarrative)}</div>`;
    }

    // 聚合数据
    const items = app.complaints || [];
    if (items.length > 0) {
      html += '<ul class="v2-agg-list">';
      for (const item of items.slice(0, 8)) {
        html += '<li>';
        html += `<span class="v2-agg-item-name">${escapeHtml(item.tagName)}</span>`;
        html += `<span class="v2-count-chip complaint">${item.count}</span>`;
        if (item.examples && item.examples[0]) {
          html += `<span class="v2-item-example">"${escapeHtml(item.examples[0].slice(0, 50))}"</span>`;
        }
        html += '</li>';
      }
      html += '</ul>';
    }

    html += '</div>';
  }
  html += '</div>';
  els.v2Complaints.innerHTML = html;
}

function renderV2TopReviews(apps) {
  const hasReviews = apps.some((a) => (a.topReviews || []).length > 0);
  if (!hasReviews) { els.v2TopReviews.innerHTML = ''; return; }

  let html = `<div class="v2-section-header"><span class="v2-section-icon">⭐</span> 高赞评论 <span class="v2-source-tag">语义情感标记</span></div>`;
  html += '<div class="v2-top-reviews-grid">';
  html += apps.map((app) => `
    <div class="v2-top-review-col">
      <div class="v2-top-review-app"><img src="${escapeAttr(app.appIcon || '')}" alt="">${escapeHtml(app.appName)}<span class="muted">${app.topDataReviewCount || 0} 条</span></div>
      ${(app.topReviews || []).slice(0, 5).map((r) => `
        <div class="v2-top-review">
          <div class="v2-top-review-text">${r.annotatedHtml || escapeHtml(r.originalText)}</div>
          <div class="v2-top-review-meta">
            <span class="v2-top-review-votes">👍 ${r.votes || 0}</span>
            <span class="v2-top-review-stars">${'⭐'.repeat(r.starRating || 0)}</span>
            <span class="v2-top-review-sentiment ${(r.sentiment || '').includes('正面') ? 'positive' : (r.sentiment || '').includes('负面') ? 'negative' : 'mixed'}">${escapeHtml(r.sentiment || '')}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');
  html += '</div>';

  els.v2TopReviews.innerHTML = html;
}

function renderV2CrossCutting(crossCutting) {
  if (!crossCutting) { els.v2CrossCutting.innerHTML = ''; return; }

  const cc = crossCutting;
  const hasAny = (cc.commonStrengths?.length || 0) > 0 || (cc.commonProblems?.length || 0) > 0 || (cc.differentiators?.length || 0) > 0;
  if (!hasAny) { els.v2CrossCutting.innerHTML = ''; return; }

  let html = `<div class="v2-section-header"><span class="v2-section-icon">🔍</span> 跨 App 洞察 <span class="v2-source-tag">AI 生成</span></div>`;
  html += '<div class="v2-cross-inline">';

  if (cc.commonStrengths?.length > 0) {
    html += `<div class="v2-cross-item strengths"><strong>共同优势</strong><ul>${cc.commonStrengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`;
  }
  if (cc.commonProblems?.length > 0) {
    html += `<div class="v2-cross-item problems"><strong>共同问题</strong><ul>${cc.commonProblems.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`;
  }
  if (cc.differentiators?.length > 0) {
    html += `<div class="v2-cross-item differentiators"><strong>差异化</strong><ul>${cc.differentiators.map((d) => `<li><strong>${escapeHtml(d.appName)}</strong>：${escapeHtml(d.strength)}</li>`).join('')}</ul></div>`;
  }

  html += '</div>';
  els.v2CrossCutting.innerHTML = html;
}

// ===== 横向对比辅助：按维度/类别分组 =====

function groupByDimName(apps, field) {
  // 合并所有 App 的 likes/complaints 条目，按 dimName 分组
  const dimGroups = {};
  const allTags = new Map(); // tagName -> { dimName, appEntries: { analysisId: { count, example } } }

  for (const app of apps) {
    for (const item of (app[field] || [])) {
      const dimName = item.dimName || '其他';
      if (!allTags.has(item.tagName)) {
        allTags.set(item.tagName, { dimName, appEntries: {}, maxCount: 0 });
      }
      const tag = allTags.get(item.tagName);
      tag.appEntries[app.analysisId] = {
        count: item.count,
        example: item.examples?.[0] || ''
      };
      if (item.count > tag.maxCount) tag.maxCount = item.count;
    }
  }

  for (const [, tag] of allTags) {
    const dim = tag.dimName;
    if (!dimGroups[dim]) dimGroups[dim] = [];
    dimGroups[dim].push(tag);
  }

  // 每组内按 maxCount 降序
  for (const key of Object.keys(dimGroups)) {
    dimGroups[key].sort((a, b) => b.maxCount - a.maxCount);
  }

  return dimGroups;
}

function groupByCategory(apps, field) {
  const catGroups = {};
  const allItems = new Map(); // description -> { category, appEntries: { analysisId: { count } } }

  for (const app of apps) {
    for (const item of (app[field] || [])) {
      const desc = item.description || item.tagName;
      const cat = item.category || '其他';
      if (!allItems.has(desc)) {
        allItems.set(desc, { description: desc, category: cat, appEntries: {} });
      }
      const entry = allItems.get(desc);
      entry.appEntries[app.analysisId] = { count: item.count };
    }
  }

  for (const [, item] of allItems) {
    const cat = item.category;
    if (!catGroups[cat]) catGroups[cat] = [];
    catGroups[cat].push(item);
  }

  return catGroups;
}

// ===== V2 历史记录 =====

async function loadV2History() {
  try {
    const data = await fetchJson('/api/compare/v2/history');
    state.v2History = data.reports || [];
    renderV2History();
  } catch {
    state.v2History = [];
  }
}

function renderV2History() {
  const history = state.v2History;
  if (history.length === 0) {
    els.v2HistorySection.hidden = true;
    return;
  }
  els.v2HistorySection.hidden = false;
  els.v2HistoryList.innerHTML = history.slice(0, 10).map((h) => `
    <div class="v2-history-item" data-report-id="${escapeAttr(h.reportId)}" role="button" tabindex="0" title="点击查看报告">
      <div class="v2-history-info">
        <strong>${escapeHtml(h.templateName)}</strong>
        <span class="muted">${h.appNames.join(' / ')} · ${h.appCount} 个 App</span>
        <span class="v2-history-time">${formatTime(h.createdAt)}</span>
      </div>
      <button class="v2-history-view secondary-button" type="button">查看</button>
      <button class="v2-history-delete danger-button" type="button">删除</button>
    </div>
  `).join('');

  els.v2HistoryList.addEventListener('click', (e) => {
    const item = e.target.closest('.v2-history-item');
    if (!item) return;
    const reportId = item.dataset.reportId;
    // 删除按钮优先
    if (e.target.closest('.v2-history-delete')) {
      deleteV2Report(reportId);
      return;
    }
    // 点击整行或查看按钮都加载报告
    loadV2Report(reportId);
  });
}

async function loadV2Report(reportId) {
  try {
    const data = await fetchJson(`/api/compare/v2/report/${reportId}`);
    state.v2Report = data;
    renderV2Report();
  } catch (error) {
    window.alert(`加载报告失败：${error.message}`);
  }
}

async function deleteV2Report(reportId) {
  if (!confirm('确定删除该报告？')) return;
  try {
    await fetchJson(`/api/compare/v2/report/${reportId}`, { method: 'DELETE' });
    await loadV2History();
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
