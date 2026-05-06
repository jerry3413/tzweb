// 评论解析页面：模板管理、分析任务创建、结果查看与人工确认。
// 沿用下载页面的整体模式：els 集中引用 → bindEvents → renderXxx 全量重绘。

const state = {
  templates: [],           // 模板索引列表
  currentTemplate: null,   // 当前正在编辑的完整模板
  downloadJobs: [],        // 已完成下载任务（用于 App 选择）
  analyses: [],            // 分析任务列表
  currentResults: null,    // 当前查看的分析结果
  polling: null,
  _selectedJobIds: ''      // 自定义下拉当前选中的 jobIds JSON 字符串
};

const els = {
  runtimeNotice: document.querySelector('#runtimeNotice'),
  // 模板相关
  templateList: document.querySelector('#templateList'),
  templateEditor: document.querySelector('#templateEditor'),
  templateEditorTitle: document.querySelector('#templateEditorTitle'),
  templateName: document.querySelector('#templateName'),
  templateCategory: document.querySelector('#templateCategory'),
  templateDescription: document.querySelector('#templateDescription'),
  dimensionsEditor: document.querySelector('#dimensionsEditor'),
  newTemplateBtn: document.querySelector('#newTemplateBtn'),
  closeTemplateEditor: document.querySelector('#closeTemplateEditor'),
  saveTemplateBtn: document.querySelector('#saveTemplateBtn'),
  deleteTemplateBtn: document.querySelector('#deleteTemplateBtn'),
  resetTemplateBtn: document.querySelector('#resetTemplateBtn'),
  addDimensionBtn: document.querySelector('#addDimensionBtn'),
  // 分析创建
  appSelectWrapper: document.querySelector('#appSelectWrapper'),
  appSelectTrigger: document.querySelector('#appSelectTrigger'),
  appSelectDropdown: document.querySelector('#appSelectDropdown'),
  analysisTemplateSelect: document.querySelector('#analysisTemplateSelect'),
  confidenceThreshold: document.querySelector('#confidenceThreshold'),
  apiKeyInput: document.querySelector('#apiKeyInput'),
  toggleAdvancedBtn: document.querySelector('#toggleAdvancedBtn'),
  advancedSettings: document.querySelector('#advancedSettings'),
  modelSelect: document.querySelector('#modelSelect'),
  temperatureInput: document.querySelector('#temperatureInput'),
  maxTokensInput: document.querySelector('#maxTokensInput'),
  parallelTasksInput: document.querySelector('#parallelTasksInput'),
  systemPromptInput: document.querySelector('#systemPromptInput'),
  userPromptInput: document.querySelector('#userPromptInput'),
  startAnalysisBtn: document.querySelector('#startAnalysisBtn'),
  // 分析任务列表
  analysisTable: document.querySelector('#analysisTable'),
  reloadAnalyses: document.querySelector('#reloadAnalyses'),
  // 结果查看
  resultsSection: document.querySelector('#resultsSection'),
  resultsTitle: document.querySelector('#resultsTitle'),
  resultsSummary: document.querySelector('#resultsSummary'),
  dimensionStats: document.querySelector('#dimensionStats'),
  filterDimension: document.querySelector('#filterDimension'),
  filterTag: document.querySelector('#filterTag'),
  filterConfidence: document.querySelector('#filterConfidence'),
  classifiedTable: document.querySelector('#classifiedTable'),
  lowConfidenceTable: document.querySelector('#lowConfidenceTable'),
  lowConfidenceSummary: document.querySelector('#lowConfidenceSummary'),
  lowConfBadge: document.querySelector('#lowConfBadge'),
  resultsTabs: document.querySelector('#resultsTabs'),
  backToJobsBtn: document.querySelector('#backToJobsBtn')
};

init();

async function init() {
  bindEvents();
  showRuntimeNoticeIfNeeded();

  try {
    await Promise.all([
      loadTemplates(),
      loadDownloadJobs()
    ]);
    await loadAnalyses();
    startPolling();
  } catch (error) {
    showRuntimeNotice(error);
  }
}

function bindEvents() {
  els.newTemplateBtn.addEventListener('click', () => openTemplateEditor(null));
  els.closeTemplateEditor.addEventListener('click', closeTemplateEditorFn);
  els.saveTemplateBtn.addEventListener('click', saveTemplate);
  els.deleteTemplateBtn.addEventListener('click', deleteTemplate);
  els.resetTemplateBtn.addEventListener('click', resetTemplate);
  els.addDimensionBtn.addEventListener('click', addDimensionToEditor);
  els.startAnalysisBtn.addEventListener('click', submitAnalysis);
  els.toggleAdvancedBtn.addEventListener('click', toggleAdvancedSettings);
  els.analysisTemplateSelect.addEventListener('change', updateDefaultPrompts);
  els.reloadAnalyses.addEventListener('click', loadAnalyses);
  els.backToJobsBtn.addEventListener('click', hideResults);
  els.filterDimension.addEventListener('change', () => {
	    populateFilterTag(els.filterDimension.value);
	    renderFilteredReviews();
	  });
	  els.filterTag.addEventListener('change', renderFilteredReviews);
	  els.filterConfidence.addEventListener('change', renderFilteredReviews);

  // 结果 Tab 切换
  els.resultsTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.results-tab');
    if (!tab) return;
    switchResultsTab(tab.dataset.tab);
  });

  // 汇总页点击：维度名跳转已分类（筛选维度）、标签跳转已分类（筛选维度+标签）
  els.dimensionStats.addEventListener('click', (event) => {
    // 二级类目：标签 badge 点击
    const badge = event.target.closest('.tag-badge[data-dim-id]');
    if (badge) {
      const dimId = badge.dataset.dimId;
      const tagId = badge.dataset.tagId;
      els.filterDimension.value = dimId;
      populateFilterTag(dimId);
      els.filterTag.value = tagId ? `${dimId}::${tagId}` : '';
      els.filterConfidence.value = '';
      switchResultsTab('classified');
      renderFilteredReviews();
      return;
    }
    // 一级类目：维度名称点击
    const dimName = event.target.closest('.stats-dim-name[data-dim-id]');
    if (dimName) {
      const dimId = dimName.dataset.dimId;
      els.filterDimension.value = dimId;
      populateFilterTag(dimId);
      els.filterTag.value = '';
      els.filterConfidence.value = '';
      switchResultsTab('classified');
      renderFilteredReviews();
    }
  });

  // 维度/标签编辑器事件委托——只绑定一次，DOM 通过 innerHTML 重建不影响委托
  bindEditorEvents();

  // 顶层字段同步回 state.currentTemplate
  els.templateName.addEventListener('input', () => {
    if (state.currentTemplate) state.currentTemplate.name = els.templateName.value;
  });
  els.templateCategory.addEventListener('input', () => {
    if (state.currentTemplate) state.currentTemplate.category = els.templateCategory.value;
  });
  els.templateDescription.addEventListener('input', () => {
    if (state.currentTemplate) state.currentTemplate.description = els.templateDescription.value;
  });

  // 自定义 App 下拉：展开/收起，展开时同步选中态样式
  els.appSelectTrigger.addEventListener('click', () => {
    const opening = els.appSelectDropdown.hidden;
    if (opening) {
      // 同步选中态：移除所有旧选中标记，给当前选中项添加标记
      els.appSelectDropdown.querySelectorAll('.custom-select-option--selected').forEach(el => el.classList.remove('custom-select-option--selected'));
      if (state._selectedJobIds) {
        for (const opt of els.appSelectDropdown.querySelectorAll('[data-value]')) {
          if (opt.dataset.value === state._selectedJobIds) {
            opt.classList.add('custom-select-option--selected');
            break;
          }
        }
      }
    }
    els.appSelectDropdown.hidden = !els.appSelectDropdown.hidden;
  });
  // 点击外部关闭下拉
  document.addEventListener('click', (event) => {
    if (!els.appSelectWrapper.contains(event.target)) {
      els.appSelectDropdown.hidden = true;
    }
  });
  // Escape 关闭下拉
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.appSelectDropdown.hidden = true;
    }
  });

  // 模板卡片点击：查看/编辑
  els.templateList.addEventListener('click', async (event) => {
    const card = event.target.closest('[data-template-id]');
    if (!card) return;
    const templateId = card.dataset.templateId;
    await openTemplateEditor(templateId);
  });

  // 分析结果查看：点击已完成任务；删除按钮
  els.analysisTable.addEventListener('click', async (event) => {
    // 删除按钮
    const deleteBtn = event.target.closest('[data-action="delete-analysis"]');
    if (deleteBtn) {
      event.stopPropagation();
      await deleteAnalysis(deleteBtn.dataset.analysisId);
      return;
    }
    // 查看结果（点击"查看结果"链接或整行）
    const row = event.target.closest('[data-analysis-id]');
    if (!row) return;
    const analysisId = row.dataset.analysisId;
    const analysis = state.analyses.find((a) => a.id === analysisId);
    if (analysis && analysis.status === 'completed') {
      await viewResults(analysisId);
    }
  });
}

// ===== 运行时提示 =====

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

// ===== 模板管理 =====

async function loadTemplates() {
  const data = await fetchJson('/api/templates');
  state.templates = data.templates || [];
  renderTemplates();
  populateTemplateSelect();
}

function renderTemplates() {
  if (state.templates.length === 0) {
    els.templateList.innerHTML = '<div class="empty">还没有模板，点击"新建模板"开始。</div>';
    return;
  }

  els.templateList.innerHTML = state.templates.map((tpl) => `
    <div class="template-card" data-template-id="${escapeAttr(tpl.id)}">
      <div class="template-card-header">
        <span class="template-card-name">${escapeHtml(tpl.name)}</span>
        ${tpl.isBuiltIn ? '<span class="status-pill" style="border-color: var(--green); background: #e7fff3; color: #056444;">内置</span>' : '<span class="status-pill">自定义</span>'}
      </div>
      <div class="muted" style="margin-top: 6px;">${escapeHtml(tpl.category || '未分类')} · ${tpl.dimensionCount} 维度 · ${tpl.tagCount} 标签</div>
      <div class="muted" style="margin-top: 4px; font-size: 12px;">${escapeHtml(tpl.description || '')}</div>
    </div>
  `).join('');
}

function populateTemplateSelect() {
  els.analysisTemplateSelect.innerHTML = '<option value="">-- 选择模板 --</option>' +
    state.templates.map((tpl) => `<option value="${escapeAttr(tpl.id)}">${escapeHtml(tpl.name)}（${tpl.dimensionCount} 维度 · ${tpl.tagCount} 标签）</option>`).join('');
}

// 打开模板编辑器：id 为 null 表示新建，否则加载已有模板。
async function openTemplateEditor(templateId) {
  if (templateId) {
    let data;
    try {
      data = await fetchJson(`/api/templates/${encodeURIComponent(templateId)}`);
    } catch (error) {
      window.alert(`无法打开模板：${error.message}`);
      return;
    }
    if (!data || !data.template) {
      window.alert('模板数据不存在，可能已被删除。请刷新页面。');
      await loadTemplates();
      return;
    }
    state.currentTemplate = data.template;
    els.templateEditorTitle.textContent = '编辑模板';
    els.deleteTemplateBtn.style.display = state.currentTemplate.isBuiltIn ? 'none' : 'inline-block';
    els.resetTemplateBtn.style.display = state.currentTemplate.isBuiltIn ? 'inline-block' : 'none';
    els.saveTemplateBtn.textContent = state.currentTemplate.isBuiltIn ? '创建自定义副本' : '保存模板';
  } else {
    state.currentTemplate = {
      id: null,
      name: '',
      category: '',
      description: '',
      isBuiltIn: false,
      dimensions: []
    };
    els.templateEditorTitle.textContent = '新建模板';
    els.deleteTemplateBtn.style.display = 'none';
    els.resetTemplateBtn.style.display = 'none';
    els.saveTemplateBtn.textContent = '保存模板';
  }

  els.templateName.value = state.currentTemplate.name;
  els.templateCategory.value = state.currentTemplate.category || '';
  els.templateDescription.value = state.currentTemplate.description || '';

  renderDimensionsEditor();
  els.templateEditor.hidden = false;
}

function closeTemplateEditorFn() {
  els.templateEditor.hidden = true;
  state.currentTemplate = null;
}

// 在编辑器中渲染维度列表，每个维度下展示标签。
function renderDimensionsEditor() {
  const dims = state.currentTemplate?.dimensions || [];
  if (dims.length === 0) {
    els.dimensionsEditor.innerHTML = '<div class="muted" style="padding: 10px;">还没有添加维度。点击下方"添加维度"开始构建模板。</div>';
    return;
  }

  els.dimensionsEditor.innerHTML = dims.map((dim, dimIndex) => `
    <div class="dimension-block" data-dim-index="${dimIndex}">
      <div class="dimension-header">
        <label class="field" style="gap: 4px;">
          <span>维度名称</span>
          <input class="dim-name-input" value="${escapeAttr(dim.name || '')}" placeholder="如：广告体验" data-dim-index="${dimIndex}" data-field="name">
        </label>
        <label class="field" style="gap: 4px;">
          <span>产品含义</span>
          <input class="dim-meaning-input" value="${escapeAttr(dim.productMeaning || '')}" placeholder="如：商业化是否打断核心任务" data-dim-index="${dimIndex}" data-field="productMeaning">
        </label>
        <button class="secondary-button compact-button remove-dim-btn" data-dim-index="${dimIndex}" type="button">删除维度</button>
      </div>
      <div class="tag-list" data-dim-index="${dimIndex}">
        ${(dim.tags || []).map((tag, tagIndex) => `
          <div class="tag-row">
            <input class="tag-name-input" value="${escapeAttr(tag.name || '')}" placeholder="标签名称" data-dim-index="${dimIndex}" data-tag-index="${tagIndex}" data-field="tagName">
            <button class="secondary-button compact-button remove-tag-btn" data-dim-index="${dimIndex}" data-tag-index="${tagIndex}" type="button">×</button>
          </div>
        `).join('')}
      </div>
      <button class="secondary-button compact-button add-tag-btn" data-dim-index="${dimIndex}" type="button">+ 添加标签</button>
    </div>
  `).join('');
}

function bindEditorEvents() {
  // 事件委托只需绑定一次。renderDimensionsEditor 用 innerHTML 重建 DOM，
  // 但事件冒泡到父容器仍然有效，重复绑定会导致监听器累积。
  if (bindEditorEvents._bound) return;
  bindEditorEvents._bound = true;

  els.dimensionsEditor.addEventListener('click', (event) => {
    if (!state.currentTemplate) return;
    const removeDimBtn = event.target.closest('.remove-dim-btn');
    const removeTagBtn = event.target.closest('.remove-tag-btn');
    const addTagBtn = event.target.closest('.add-tag-btn');

    if (removeDimBtn) {
      const dimIndex = parseInt(removeDimBtn.dataset.dimIndex, 10);
      state.currentTemplate.dimensions.splice(dimIndex, 1);
      renderDimensionsEditor();
    }

    if (removeTagBtn) {
      const dimIndex = parseInt(removeTagBtn.dataset.dimIndex, 10);
      const tagIndex = parseInt(removeTagBtn.dataset.tagIndex, 10);
      state.currentTemplate.dimensions[dimIndex].tags.splice(tagIndex, 1);
      renderDimensionsEditor();
    }

    if (addTagBtn) {
      const dimIndex = parseInt(addTagBtn.dataset.dimIndex, 10);
      const dim = state.currentTemplate.dimensions[dimIndex];
      if (!dim.tags) dim.tags = [];
      dim.tags.push({ id: '', name: '' });
      renderDimensionsEditor();
    }
  });

  // 输入框变更时同步回 state.currentTemplate
  els.dimensionsEditor.addEventListener('input', (event) => {
    if (!state.currentTemplate) return;
    const input = event.target;
    const dimIndex = parseInt(input.dataset.dimIndex, 10);

    if (input.classList.contains('dim-name-input')) {
      state.currentTemplate.dimensions[dimIndex].name = input.value;
    } else if (input.classList.contains('dim-meaning-input')) {
      state.currentTemplate.dimensions[dimIndex].productMeaning = input.value;
    } else if (input.classList.contains('tag-name-input')) {
      const tagIndex = parseInt(input.dataset.tagIndex, 10);
      state.currentTemplate.dimensions[dimIndex].tags[tagIndex].name = input.value;
    }
  });
}

function addDimensionToEditor() {
  if (!state.currentTemplate) return;
  if (!state.currentTemplate.dimensions) state.currentTemplate.dimensions = [];
  state.currentTemplate.dimensions.push({
    id: '',
    name: '',
    productMeaning: '',
    tags: []
  });
  renderDimensionsEditor();
}

// 保存模板：从编辑器收集最新数据，调用创建或更新 API。
async function saveTemplate() {
  const name = els.templateName.value.trim();
  if (!name) {
    window.alert('请输入模板名称。');
    return;
  }

  const payload = {
    name,
    category: els.templateCategory.value.trim(),
    description: els.templateDescription.value.trim(),
    dimensions: state.currentTemplate.dimensions || []
  };

  const wasBuiltIn = state.currentTemplate.isBuiltIn;

  try {
    let saved;
    if (state.currentTemplate.isBuiltIn) {
      const resp = await fetchJson('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      saved = resp.template;
    } else if (state.currentTemplate.id) {
      const resp = await fetchJson(`/api/templates/${encodeURIComponent(state.currentTemplate.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      saved = resp.template;
    } else {
      const resp = await fetchJson('/api/templates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      saved = resp.template;
    }

    await loadTemplates();

    if (wasBuiltIn) {
      state.currentTemplate = saved;
      els.templateEditorTitle.textContent = '编辑模板（自定义副本）';
      els.deleteTemplateBtn.style.display = 'inline-block';
      els.resetTemplateBtn.style.display = 'none';
      els.saveTemplateBtn.textContent = '保存模板';
      showSaveFeedback('副本已创建，可继续编辑');
    } else {
      showSaveFeedback('已保存');
      setTimeout(() => {
        closeTemplateEditorFn();
      }, 600);
    }
  } catch (error) {
    window.alert(`保存模板失败：${error.message}`);
  }
}

function showSaveFeedback(msg) {
  const btn = els.saveTemplateBtn;
  const original = btn.textContent;
  btn.textContent = msg;
  btn.style.background = 'var(--green)';
  setTimeout(() => {
    btn.textContent = original;
    btn.style.background = '';
  }, 1500);
}

async function deleteTemplate() {
  if (!state.currentTemplate || !state.currentTemplate.id) return;
  if (!confirm(`确认删除模板"${state.currentTemplate.name}"？此操作不可恢复。`)) return;

  try {
    await fetchJson(`/api/templates/${encodeURIComponent(state.currentTemplate.id)}`, { method: 'DELETE' });
    closeTemplateEditorFn();
    await loadTemplates();
  } catch (error) {
    window.alert(`删除模板失败：${error.message}`);
  }
}

async function resetTemplate() {
  if (!state.currentTemplate || !state.currentTemplate.isBuiltIn) return;
  if (!confirm(`确认将模板"${state.currentTemplate.name}"恢复为内置版本？所有自定义修改将丢失。`)) return;

  try {
    const data = await fetchJson(`/api/templates/${encodeURIComponent(state.currentTemplate.id)}/reset`, { method: 'POST' });
    state.currentTemplate = data.template;
    els.templateName.value = state.currentTemplate.name;
    els.templateCategory.value = state.currentTemplate.category || '';
    els.templateDescription.value = state.currentTemplate.description || '';
    renderDimensionsEditor();
  } catch (error) {
    window.alert(`重置模板失败：${error.message}`);
  }
}

// ===== 下载任务加载（用于 App 选择） =====

async function loadDownloadJobs() {
  const data = await fetchJson('/api/jobs');
  const jobs = data.jobs || [];
  // 只保留已完成的下载任务
  state.downloadJobs = jobs.filter((job) => job.status === 'completed');
  renderAppSelect();
}

// 将已完成下载任务按 App 名称分组，构建带图标的自定义下拉选项。
function renderAppSelect() {
  const apps = new Map();
  for (const job of state.downloadJobs) {
    const appName = job.app?.name || job.result?.app?.name || '未知 App';
    if (!apps.has(appName)) {
      apps.set(appName, {
        name: appName,
        developer: job.app?.developer || job.result?.app?.developer || '',
        icon: job.app?.icon || job.result?.app?.icon || '',
        jobIds: [],
        totalReviews: 0
      });
    }
    const entry = apps.get(appName);
    entry.jobIds.push(job.id);
    entry.totalReviews += job.result?.exportedCount || 0;
  }

  const appList = Array.from(apps.values());

  // 构建下拉选项 HTML（带图标）
  els.appSelectDropdown.innerHTML = appList.map((app) => {
    const jobIdsJson = escapeAttr(JSON.stringify(app.jobIds));
    const selectedClass = (jobIdsJson === state._selectedJobIds) ? ' custom-select-option--selected' : '';
    return `<div class="custom-select-option${selectedClass}" data-value="${jobIdsJson}">
      <img class="app-icon" src="${escapeAttr(app.icon)}" alt="${escapeHtml(app.name)}" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="custom-select-option-text">
        <span class="custom-select-option-name">${escapeHtml(app.name)}</span>
        <span class="custom-select-option-meta">${escapeHtml(app.developer)} · ${app.totalReviews} 条评论</span>
      </div>
    </div>`;
  }).join('');

  if (appList.length === 0) {
    els.appSelectDropdown.innerHTML = '<div class="custom-select-option custom-select-option--empty">暂无已下载的 App</div>';
  }

  // 选项点击事件委托（每次重建下拉时移除旧监听再添加新监听）
  if (els.appSelectDropdown._clickHandler) {
    els.appSelectDropdown.removeEventListener('click', els.appSelectDropdown._clickHandler);
  }
  els.appSelectDropdown._clickHandler = (event) => {
    const option = event.target.closest('[data-value]');
    if (!option) return;
    const jobIdsJson = option.dataset.value;
    const app = appList.find(a => JSON.stringify(a.jobIds) === jobIdsJson);
    if (!app) return;

    state._selectedJobIds = jobIdsJson;
    updateAppTriggerDisplay(app);
    event.stopPropagation();
    event.stopImmediatePropagation();
    // 延迟关闭，确保事件处理完成后再隐藏
    requestAnimationFrame(() => {
      els.appSelectDropdown.hidden = true;
    });
  };
  els.appSelectDropdown.addEventListener('click', els.appSelectDropdown._clickHandler);

  // 恢复之前的选择或显示占位
  const prevApp = appList.find(a => JSON.stringify(a.jobIds) === state._selectedJobIds);
  updateAppTriggerDisplay(prevApp || null);
}

// 更新下拉触发器显示：展示选中 App 的图标和名称，或回退到占位文字。
function updateAppTriggerDisplay(app) {
  if (app) {
    els.appSelectTrigger.innerHTML = `<img class="app-icon" src="${escapeAttr(app.icon)}" alt="${escapeHtml(app.name)}" onerror="this.style.visibility='hidden'" style="flex-shrink: 0;">
      <span class="custom-select-trigger-info"><span class="custom-select-trigger-text">${escapeHtml(app.name)}</span><span class="custom-select-trigger-meta">${escapeHtml(app.developer)} · ${app.totalReviews} 条评论</span></span>`;
  } else {
    els.appSelectTrigger.innerHTML = '<span class="custom-select-placeholder">-- 选择已下载的 App --</span>';
  }
}

// ===== 高级 Prompt 设置 =====

function toggleAdvancedSettings() {
  const hidden = els.advancedSettings.style.display === 'none';
  els.advancedSettings.style.display = hidden ? 'block' : 'none';
  els.toggleAdvancedBtn.textContent = hidden ? '收起高级 Prompt 设置' : '展开高级 Prompt 设置';
  if (hidden) {
    updateDefaultPrompts();
  }
}

// 根据所选模板生成默认 System Prompt 和 User Prompt 模板，供用户预览和编辑。
async function updateDefaultPrompts() {
  const templateId = els.analysisTemplateSelect.value;
  if (!templateId) return;

  let tpl;
  try {
    const resp = await fetchJson(`/api/templates/${encodeURIComponent(templateId)}`);
    tpl = resp.template;
  } catch {
    return;
  }
  if (!tpl) return;

  // System Prompt：与 deepseek-client.mjs buildSystemPrompt 逻辑一致
  const dims = tpl.dimensions || [];
  const dimensionsDesc = dims.map((dim) => {
    const tagsDesc = (dim.tags || []).map((tag) => `"${tag.name}"`).join('、');
    return `- ${dim.name}（${dim.productMeaning || ''}）：${tagsDesc}`;
  }).join('\n');

  els.systemPromptInput.value = `你是一个专业的 APP 用户评论分析助手。请根据以下模板维度与标签，对每条评论进行语义理解和分类。

## 分类规则
1. 一条评论可以同时匹配多个维度和多个标签。只要评论内容涉及该维度/标签，就应该标记。
2. 对每个匹配输出 confidence（0-1 的小数），表示你对这个分类的确信程度：
   - 0.9-1.0：评论明确表达了该含义
   - 0.7-0.9：评论高度暗示该含义
   - 0.5-0.7：评论可能涉及该含义，但不够明确
   - 低于 0.5：不要输出，视为不匹配
3. **无意义内容优先判断**：对于无实质内容的评论，应优先归类到"无意义内容"维度并给 0.95 置信度，不要强行匹配其他维度。具体包括：
	   - 纯情绪表达而无具体功能/体验描述（如 "very good", "good app", "nice", "great", "awesome", "bad", "very bad", "terrible", "worst app" 等仅有简单评价词）
	   - 乱码、纯表情、无意义字符
	   - 明显刷评/灌水
	   - 与 APP 完全无关的内容
4. 如果评论内容与任何维度/标签都不相关，返回空的 classifications 数组。
5. **重要**：只输出 JSON 数组，不要输出其他文字、解释或 markdown 代码块标记。

## 模板维度与标签

${dimensionsDesc}
- 无意义内容（评论是否为无意义、垃圾、灌水、乱码等无效内容）："无意义"

## 输出格式
请严格按以下 JSON 数组格式输出（每行一条完整的 JSON）：
[{"reviewIndex": 0, "classifications": [{"dimension": "维度名称", "tag": "标签名称", "confidence": 0.85}]}, {"reviewIndex": 1, "classifications": []}]`;

  // User Prompt 模板：占位符会在服务端替换为实际评论数据
  els.userPromptInput.value = `以下是需要分类的 __BATCH_SIZE__ 条评论（每条包含 index、starRating 和 text）：

__REVIEWS_JSON__

请输出分类结果 JSON 数组：`;
}

// ===== 分析任务创建 =====

async function submitAnalysis() {
  const jobIdsJson = state._selectedJobIds;
  if (!jobIdsJson) {
    window.alert('请先选择已下载的目标 App。');
    return;
  }

  const templateId = els.analysisTemplateSelect.value;
  if (!templateId) {
    window.alert('请选择分析模板。');
    return;
  }

  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    window.alert('请输入 DeepSeek API Key。');
    return;
  }

  const originalText = els.startAnalysisBtn.textContent;
  els.startAnalysisBtn.disabled = true;
  els.startAnalysisBtn.textContent = '正在创建任务...';

  try {
    const payload = {
      downloadJobIds: JSON.parse(jobIdsJson),
      templateId,
      deepseekApiKey: apiKey,
      confidenceThreshold: parseFloat(els.confidenceThreshold.value),
      parallelTasks: parseInt(els.parallelTasksInput.value, 10) || 20,
      model: els.modelSelect.value || 'deepseek-chat',
      temperature: !isNaN(parseFloat(els.temperatureInput.value)) ? parseFloat(els.temperatureInput.value) : undefined,
      maxTokens: parseInt(els.maxTokensInput.value, 10) || 8192,
      systemPrompt: els.systemPromptInput.value.trim() || undefined,
      userPromptTemplate: els.userPromptInput.value.trim() || undefined
    };

    const data = await fetchJson('/api/analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // 分析任务创建成功，立即加入列表顶部
    state.analyses.unshift(data.analysis);
    renderAnalyses();
  } catch (error) {
    window.alert(`创建分析任务失败：${error.message}`);
  } finally {
    els.startAnalysisBtn.disabled = false;
    els.startAnalysisBtn.textContent = originalText;
  }
}

// ===== 分析任务列表 =====

async function loadAnalyses() {
  try {
    const data = await fetchJson('/api/analysis');
    state.analyses = data.analyses || [];
    renderAnalyses();
  } catch (error) {
    // 分析接口可能尚未部署，静默处理避免影响模板功能
    console.error('加载分析任务失败：', error);
  }
}

async function deleteAnalysis(analysisId) {
  if (!window.confirm('确定要删除此解析任务及其结果吗？此操作不可撤销。')) return;
  try {
    await fetchJson(`/api/analysis/${encodeURIComponent(analysisId)}`, { method: 'DELETE' });
    state.analyses = state.analyses.filter((a) => a.id !== analysisId);
    // 如果当前正在查看该分析结果，返回任务列表
    if (state.currentResults?.id === analysisId) {
      hideResults();
    }
    renderAnalyses();
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
}

function startPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(loadAnalyses, 2000);
}

function renderAnalyses() {
  if (state.analyses.length === 0) {
    els.analysisTable.innerHTML = '<tr><td colspan="7" class="empty">还没有解析任务。在上方选择 App 和模板后，启动 AI 解析。</td></tr>';
    return;
  }

  els.analysisTable.innerHTML = state.analyses.map((a) => `
    <tr data-analysis-id="${escapeAttr(a.id)}" style="${a.status === 'completed' ? 'cursor: pointer;' : ''}">
      <td>${appCell(a)}</td>
      <td>${escapeHtml(a.templateName || '-')}</td>
      <td>${analysisStatusCell(a)}</td>
      <td>${analysisReviewCell(a)}</td>
      <td><span class="muted">${escapeHtml(analysisConfigText(a))}</span></td>
      <td><span class="muted">${new Date(a.createdAt).toLocaleString('zh-CN')}</span></td>
      <td>
        ${a.status === 'completed' ? '<a class="action-link" data-action="view-results">查看结果</a>' : '<span class="muted">-</span>'}
        <br><a class="action-link delete-link" data-action="delete-analysis" data-analysis-id="${escapeAttr(a.id)}">删除</a>
      </td>
    </tr>
  `).join('');
}

function appCell(analysis) {
  const app = analysis.app || {};
  const name = escapeHtml(app.name || '未知 App');
  const developer = escapeHtml(app.developer || '');
  const icon = escapeAttr(app.icon || '');
  return `
    <div class="app-cell">
      ${icon ? `<img class="app-icon" src="${icon}" alt="${name}">` : ''}
      <div>
        <div>${name}</div>
        ${developer ? `<div class="muted">${developer}</div>` : ''}
      </div>
    </div>
  `;
}

function analysisStatusCell(a) {
  const status = a.status || 'unknown';
  const progress = Math.max(0, Math.min(100, a.progress || 0));
  const step = escapeHtml(analysisStepText(a.currentStep || ''));
  return `
    <span class="status-pill ${status}">${analysisStatusText(status)}</span>
    <div class="progress-track"><div class="progress-fill" style="width: ${progress}%"></div></div>
    <div class="muted">${progress}% ${step}</div>
  `;
}

function analysisReviewCell(a) {
  const summary = a.summary || {};
  const total = summary.totalReviews || 0;
  const classified = summary.classifiedCount || 0;
  const low = summary.lowConfidenceCount || 0;
  if (!total) return '<span class="muted">-</span>';
  return `
    <div>${classified} 条已分类</div>
    <div class="muted">${low} 条待确认 / 共 ${total} 条</div>
  `;
}

function analysisConfigText(a) {
  const config = a.config || {};
  return `${config.parallelTasks || 20} 并行 · 阈值 ${config.confidenceThreshold || 0.6}`;
}

// ===== 结果查看 =====

async function viewResults(analysisId) {
  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(analysisId)}/results`);
    state.currentResults = data;
    els.resultsSection.hidden = false;
    els.resultsTitle.textContent = `解析结果 — ${escapeHtml(state.currentResults.template?.name || '')}`;

    const revs = state.currentResults.reviews || [];
    const lowConf = revs.filter((r) => r.isLowConfidence);
    els.resultsSummary.textContent = `共 ${revs.length} 条评论，${revs.length - lowConf.length} 条已分类，${lowConf.length} 条待确认`;

    renderDimensionStats();
    populateFilterDimension();
    populateFilterTag('');
    els.filterDimension.value = '';
    els.filterTag.value = '';
    els.filterConfidence.value = '';
    renderFilteredReviews();
    renderLowConfidence();

    switchResultsTab('summary');
    window.scrollTo({ top: els.resultsSection.offsetTop - 20, behavior: 'smooth' });
  } catch (error) {
    window.alert(`加载分析结果失败：${error.message}`);
  }
}

function hideResults() {
  els.resultsSection.hidden = true;
  state.currentResults = null;
}

function switchResultsTab(tabName) {
  // 更新 tab 按钮状态
  els.resultsTabs.querySelectorAll('.results-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  // 切换面板
  document.querySelectorAll('.results-tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `tab-${tabName}`;
  });
}

// 维度标签统计：用 CSS 柱状条展示每个维度下的标签分布。
function renderDimensionStats() {
  const stats = state.currentResults?.dimensionStats || [];
  if (stats.length === 0) {
    els.dimensionStats.innerHTML = '';
    return;
  }

  const maxCount = Math.max(...stats.map((s) => s.count), 1);

  els.dimensionStats.innerHTML = stats.map((dim) => {
    const percent = Math.round((dim.count / maxCount) * 100);
    const tagItems = (dim.tags || []).sort((a, b) => b.count - a.count).slice(0, 8).map((tag) =>
      `<span class="tag-badge" data-dim-id="${escapeAttr(dim.dimensionId)}" data-tag-id="${escapeAttr(tag.tagId || '')}" style="cursor: pointer;">${escapeHtml(tag.tagName)} (${tag.count})</span>`
    ).join('');

    return `
      <div class="stats-row">
        <div class="stats-label">
          <span class="stats-dim-name" data-dim-id="${escapeAttr(dim.dimensionId)}" style="cursor: pointer;">${escapeHtml(dim.dimensionName)}</span>
          <span class="stats-dim-count">${dim.count} 条</span>
        </div>
        <div class="stats-bar-track">
          <div class="stats-bar-fill" style="width: ${percent}%"></div>
        </div>
        <div class="tag-badges">${tagItems}</div>
      </div>
    `;
  }).join('');
}

function populateFilterDimension() {
  const stats = state.currentResults?.dimensionStats || [];
  els.filterDimension.innerHTML = '<option value="">全部维度</option>' +
    stats.map((dim) => `<option value="${escapeAttr(dim.dimensionId)}">${escapeHtml(dim.dimensionName)}（${dim.count}）</option>`).join('') +
    '<option value="_meaningless">无意义</option>';
}

function populateFilterTag(dimensionId) {
  if (dimensionId === '_meaningless') {
    els.filterTag.innerHTML = '<option value="">全部标签</option>' +
      '<option value="_meaningless::_meaningless">无意义</option>';
    return;
  }
  const stats = state.currentResults?.dimensionStats || [];
  let allTags = [];
  if (dimensionId) {
    const dim = stats.find((s) => s.dimensionId === dimensionId);
    allTags = (dim?.tags || []).map((t) => ({ ...t, _dimId: dimensionId }));
  } else {
    for (const dim of stats) {
      for (const tag of (dim.tags || [])) {
        allTags.push({ ...tag, _dimId: dim.dimensionId });
      }
    }
  }
  // 去重（同标签名可能在不同维度出现）
  const seen = new Set();
  const unique = allTags.filter((t) => {
    const key = `${t._dimId}::${t.tagId || t.tagName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.count - a.count);

  els.filterTag.innerHTML = '<option value="">全部标签</option>' +
    unique.map((t) => `<option value="${escapeAttr(t._dimId + '::' + (t.tagId || t.tagName))}">${escapeHtml(t.tagName)}（${t.count}）</option>`).join('');
}

// 已分类评论表：支持按维度、标签和置信度筛选。
function renderFilteredReviews() {
  const reviews = state.currentResults?.reviews || [];
  const filterDim = els.filterDimension.value;
  const filterTag = els.filterTag.value;
  const filterConf = els.filterConfidence.value;

  let filtered = reviews.filter((r) => !r.isLowConfidence && r.classifications && r.classifications.length > 0);

  if (filterDim) {
    filtered = filtered.filter((r) => r.classifications.some((c) => c.dimensionId === filterDim));
  }
  // 标签筛选值格式：dimId::tagId
  if (filterTag) {
    const [tagDimId, tagId] = filterTag.split('::');
    filtered = filtered.filter((r) =>
      r.classifications.some((c) => c.dimensionId === tagDimId && (c.tagId === tagId || c.tagName === tagId))
    );
  }
  if (filterConf === 'high') {
    filtered = filtered.filter((r) => r.classifications.some((c) => c.confidence >= 0.8));
  } else if (filterConf === 'medium') {
    filtered = filtered.filter((r) => r.classifications.some((c) => c.confidence >= 0.6 && c.confidence < 0.8));
  } else if (filterConf === 'low') {
    filtered = filtered.filter((r) => r.classifications.every((c) => c.confidence < 0.6));
  }

  if (filtered.length === 0) {
    els.classifiedTable.innerHTML = '<tr><td colspan="5" class="empty">没有匹配的评论。</td></tr>';
    return;
  }

  // 当前标签筛选值，用于高亮匹配的标签
  const filterTagRaw = els.filterTag.value;
  let filterTagDimId = '';
  let filterTagId = '';
  if (filterTagRaw) {
    [filterTagDimId, filterTagId] = filterTagRaw.split('::');
  }

  els.classifiedTable.innerHTML = filtered.map((r) => `
    <tr>
      <td style="max-width: 320px;">
        <div style="max-height: 80px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.reviewText || '')}</div>
        ${r.reviewerName ? `<div class="muted" style="margin-top: 4px;">— ${escapeHtml(r.reviewerName)}</div>` : ''}
      </td>
      <td>${'★'.repeat(Math.min(5, r.starRating || 0))}${r.starRating ? ` ${r.starRating}` : ''}</td>
      <td>
        <div class="tag-badges">
          ${(r.classifications || []).map((c) => {
            const isMatch = filterTagRaw && c.dimensionId === filterTagDimId && (c.tagId === filterTagId || c.tagName === filterTagId);
            return `<span class="tag-badge${isMatch ? ' tag-badge--match' : ''}">${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)}</span>`;
          }).join('')}
        </div>
      </td>
      <td>
        ${(r.classifications || []).map((c) => `
          <span class="confidence-pill ${c.confidence >= 0.8 ? 'confidence-high' : c.confidence >= 0.6 ? 'confidence-medium' : 'confidence-low'}">
            ${Math.round(c.confidence * 100)}%
          </span>
        `).join(' ')}
      </td>
      <td class="muted">${r.reviewDate ? new Date(r.reviewDate).toLocaleDateString('zh-CN') : '-'}</td>
    </tr>
  `).join('');
}

// 从当前结果中重新计算 summary 计数（lowConfidenceCount / classifiedCount）。
function updateLocalSummary() {
  const reviews = state.currentResults?.reviews || [];
  const lowCount = reviews.filter((r) => r.isLowConfidence).length;
  const classifiedCount = reviews.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length;
  if (state.currentResults?.summary) {
    state.currentResults.summary.lowConfidenceCount = lowCount;
    state.currentResults.summary.classifiedCount = classifiedCount;
  }
}

// 低置信度评论：AI 建议 + 人工重新分配。
function renderLowConfidence() {
  const reviews = state.currentResults?.reviews || [];
  const lowConf = reviews.filter((r) => r.isLowConfidence);

  // 更新 Tab 徽标
  if (lowConf.length > 0) {
    els.lowConfBadge.textContent = lowConf.length;
    els.lowConfBadge.hidden = false;
  } else {
    els.lowConfBadge.hidden = true;
  }

  els.lowConfidenceSummary.innerHTML = lowConf.length === 0
    ? '所有评论均已成功分类，无需人工确认。'
    : `以下 ${lowConf.length} 条评论的 AI 分类置信度低于阈值，需要人工确认或重新分配。
       <button class="secondary-button compact-button batch-meaningless-btn" type="button" style="margin-left: 12px; background: var(--muted); color: #fff; border-color: var(--muted);">全部标记为无意义</button>`;

  if (lowConf.length === 0) {
    els.lowConfidenceTable.innerHTML = '<tr><td colspan="5" class="empty">没有待确认的评论。</td></tr>';
    return;
  }

  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];

  els.lowConfidenceTable.innerHTML = lowConf.map((r) => {
    const regularClasses = (r.classifications || []).filter((c) => !c.suggested);
    const suggestedClasses = (r.classifications || []).filter((c) => c.suggested);

    return `
    <tr data-review-id="${escapeAttr(r.reviewId)}">
      <td style="max-width: 280px;">
        <div style="max-height: 80px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(r.reviewText || '')}</div>
      </td>
      <td>${'★'.repeat(Math.min(5, r.starRating || 0))} ${r.starRating || '-'}</td>
      <td>
        <div class="tag-badges">
          ${regularClasses.length > 0
            ? regularClasses.map((c) => `<span class="tag-badge">${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round(c.confidence * 100)}%)</span>`).join('')
            : (suggestedClasses.length === 0 ? '<span class="muted">AI 未能匹配</span>' : '')}
          ${suggestedClasses.map((c) => `
            <span class="tag-badge tag-badge--suggested">AI 建议: ${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round(c.confidence * 100)}%)</span>
          `).join('')}
        </div>
        ${suggestedClasses.length > 0 ? `
        <div style="margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap;">
          ${suggestedClasses.map((c) => `
            <button class="secondary-button compact-button confirm-suggest-btn" type="button"
              data-review-id="${escapeAttr(r.reviewId)}"
              data-dim-name="${escapeAttr(c.dimensionName)}"
              data-tag-name="${escapeAttr(c.tagName)}">采纳建议</button>
            <button class="secondary-button compact-button ignore-suggest-btn" type="button"
              data-review-id="${escapeAttr(r.reviewId)}"
              data-dim-name="${escapeAttr(c.dimensionName)}"
              data-tag-name="${escapeAttr(c.tagName)}"
              style="background: transparent; border-color: var(--line);">忽略</button>
          `).join('')}
        </div>` : ''}
      </td>
      <td>
        ${(r.classifications || []).map((c) => `
          <span class="confidence-pill ${c.suggested ? 'confidence-pill--suggested' : 'confidence-low'}">${Math.round(c.confidence * 100)}%</span>
        `).join(' ') || '<span class="confidence-pill confidence-low">-</span>'}
      </td>
      <td>
        <select class="reassign-dim-select" style="height: 28px; font-size: 12px; margin-bottom: 4px;" data-review-id="${escapeAttr(r.reviewId)}">
          <option value="">选择维度</option>
          ${allDimensions.map((dim) => `<option value="${escapeAttr(dim.id)}">${escapeHtml(dim.name)}</option>`).join('')}
        </select>
        <select class="reassign-tag-select" style="height: 28px; font-size: 12px; margin-bottom: 4px;" data-review-id="${escapeAttr(r.reviewId)}">
          <option value="">选择标签</option>
        </select>
        <button class="secondary-button compact-button reassign-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button">确认分配</button>
        <button class="secondary-button compact-button meaningless-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button" style="background: var(--muted); color: #fff; border-color: var(--muted);">标记无意义</button>
      </td>
    </tr>
  `}).join('');

  // 维度下拉联动标签下拉
  els.lowConfidenceTable.querySelectorAll('.reassign-dim-select').forEach((select) => {
    select.addEventListener('change', () => {
      const reviewId = select.dataset.reviewId;
      const tagSelect = els.lowConfidenceTable.querySelector(`.reassign-tag-select[data-review-id="${reviewId}"]`);
      const dim = allDimensions.find((d) => d.id === select.value);
      tagSelect.innerHTML = '<option value="">选择标签</option>' +
        (dim ? dim.tags.map((tag) => `<option value="${escapeAttr(tag.id)}">${escapeHtml(tag.name)}</option>`).join('') : '');
    });
  });

  // 确认分配按钮
  els.lowConfidenceTable.querySelectorAll('.reassign-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimSelect = els.lowConfidenceTable.querySelector(`.reassign-dim-select[data-review-id="${reviewId}"]`);
      const tagSelect = els.lowConfidenceTable.querySelector(`.reassign-tag-select[data-review-id="${reviewId}"]`);
      const dimId = dimSelect.value;
      const tagId = tagSelect.value;

      if (!dimId || !tagId) {
        window.alert('请同时选择维度和标签。');
        return;
      }

      const dim = allDimensions.find((d) => d.id === dimId);
      const tag = dim?.tags.find((t) => t.id === tagId);

      try {
        await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/low-confidence/${encodeURIComponent(reviewId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dimensionId: dimId, tagId, dimensionName: dim?.name || '', tagName: tag?.name || '' })
        });
        // 从当前结果中移除该评论的低置信度标记
        const review = state.currentResults.reviews.find((r) => r.reviewId === reviewId);
        if (review) {
          review.isLowConfidence = false;
          review.classifications = [{ dimensionId: dimId, tagId, dimensionName: dim?.name || '', tagName: tag?.name || '', confidence: 1, manuallyAssigned: true }];
        }
        // 更新 summary
        if (state.currentResults.summary) {
          state.currentResults.summary.lowConfidenceCount = Math.max(0, (state.currentResults.summary.lowConfidenceCount || 1) - 1);
          state.currentResults.summary.classifiedCount = (state.currentResults.summary.classifiedCount || 0) + 1;
        }
        renderLowConfidence();
        renderDimensionStats();
      } catch (error) {
        window.alert(`重新分配失败：${error.message}`);
      }
    });
  });

  // 标记无意义按钮
  els.lowConfidenceTable.querySelectorAll('.meaningless-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      try {
        await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/low-confidence/${encodeURIComponent(reviewId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dimensionId: '_meaningless', tagId: '_meaningless', dimensionName: '无意义', tagName: '无意义' })
        });
        const review = state.currentResults.reviews.find((r) => r.reviewId === reviewId);
        if (review) {
          review.isLowConfidence = false;
          review.classifications = [{ dimensionId: '_meaningless', tagId: '_meaningless', dimensionName: '无意义', tagName: '无意义', confidence: 1, manuallyAssigned: true }];
        }
        if (state.currentResults.summary) {
          state.currentResults.summary.lowConfidenceCount = Math.max(0, (state.currentResults.summary.lowConfidenceCount || 1) - 1);
          state.currentResults.summary.classifiedCount = (state.currentResults.summary.classifiedCount || 0) + 1;
        }
        renderLowConfidence();
        renderDimensionStats();
      } catch (error) {
        window.alert(`操作失败：${error.message}`);
      }
    });
  });

  // 一键全部标记为无意义
  els.lowConfidenceSummary.querySelector('.batch-meaningless-btn')?.addEventListener('click', async () => {
    if (!window.confirm(`确定要将全部 ${lowConf.length} 条待确认评论标记为"无意义"吗？此操作不可撤销。`)) return;

    const reviewIds = lowConf.map((r) => r.reviewId);
    const btn = els.lowConfidenceSummary.querySelector('.batch-meaningless-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '标记中...';

    try {
      const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/low-confidence/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reviewIds,
          dimensionId: '_meaningless',
          tagId: '_meaningless',
          dimensionName: '无意义',
          tagName: '无意义'
        })
      });

      // 更新本地状态：将所有目标评论标记为非低置信度
      const idSet = new Set(reviewIds);
      for (const review of (state.currentResults.reviews || [])) {
        if (idSet.has(review.reviewId)) {
          review.isLowConfidence = false;
          review.classifications = [{
            dimensionId: '_meaningless', tagId: '_meaningless',
            dimensionName: '无意义', tagName: '无意义',
            confidence: 1, manuallyAssigned: true
          }];
        }
      }
      if (state.currentResults.summary) {
        state.currentResults.summary.lowConfidenceCount = Math.max(0, (state.currentResults.summary.lowConfidenceCount || 0) - data.count);
        state.currentResults.summary.classifiedCount = (state.currentResults.summary.classifiedCount || 0) + data.count;
      }
      renderLowConfidence();
      renderDimensionStats();
    } catch (error) {
      window.alert(`批量标记失败：${error.message}`);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // AI 建议标签「采纳」按钮
  els.lowConfidenceTable.querySelectorAll('.confirm-suggest-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimensionName = btn.dataset.dimName;
      const tagName = btn.dataset.tagName;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '确认中...';

      try {
        const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/suggested/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewId, dimensionName, tagName })
        });

        // 更新本地状态
        const review = state.currentResults.reviews.find((r) => r.reviewId === reviewId);
        if (review) {
          for (const c of (review.classifications || [])) {
            if (c.suggested && c.dimensionName === dimensionName && c.tagName === tagName) {
              delete c.suggested;
              c.dimensionId = data.dimensionId;
              c.tagId = data.tagId;
              c.manuallyAssigned = true;
            }
          }
          // 重新判断 isLowConfidence
          const hasSuggestions = (review.classifications || []).some((c) => c.suggested);
          if (!hasSuggestions) {
            review.isLowConfidence = false;
          }
        }
        // 更新模板快照（前端缓存）
        if (data.dimensionId && data.tagId && state.currentResults.template) {
          let dim = (state.currentResults.template.dimensions || []).find((d) => d.id === data.dimensionId);
          if (!dim) {
            dim = { id: data.dimensionId, name: dimensionName, productMeaning: '', tags: [] };
            state.currentResults.template.dimensions.push(dim);
          }
          if (!(dim.tags || []).find((t) => t.id === data.tagId)) {
            if (!dim.tags) dim.tags = [];
            dim.tags.push({ id: data.tagId, name: tagName });
          }
        }
        updateLocalSummary();
        renderLowConfidence();
        renderDimensionStats();
      } catch (error) {
        window.alert(`采纳建议失败：${error.message}`);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  // AI 建议标签「忽略」按钮
  els.lowConfidenceTable.querySelectorAll('.ignore-suggest-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimensionName = btn.dataset.dimName;
      const tagName = btn.dataset.tagName;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '忽略中...';

      try {
        await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/suggested/ignore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewId, dimensionName, tagName })
        });

        // 更新本地状态：移除 suggested 分类
        const review = state.currentResults.reviews.find((r) => r.reviewId === reviewId);
        if (review) {
          review.classifications = (review.classifications || []).filter((c) => {
            if (c.suggested && c.dimensionName === dimensionName && c.tagName === tagName) return false;
            return true;
          });
          // 重新判断 isLowConfidence
          const hasSuggestions = (review.classifications || []).some((c) => c.suggested);
          if (!hasSuggestions) {
            const threshold = state.currentResults.summary?.confidenceThreshold || 0.6;
            const hasHighEnough = (review.classifications || []).some((c) => c.confidence >= threshold);
            review.isLowConfidence = !hasHighEnough && review.classifications.length > 0;
            if (review.classifications.length === 0) review.isLowConfidence = true;
          }
        }
        updateLocalSummary();
        renderLowConfidence();
        renderDimensionStats();
      } catch (error) {
        window.alert(`忽略建议失败：${error.message}`);
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

// ===== 中文翻译映射 =====

function analysisStatusText(status) {
  const map = {
    queued: '排队中',
    running: '解析中',
    completed: '已完成',
    failed: '失败'
  };
  return map[status] || status;
}

function analysisStepText(step) {
  const map = {
    Queued: '已排队',
    'Reading CSV files': '正在读取评论文件',
    'Merging reviews': '正在合并去重评论',
    'Starting DeepSeek analysis': '正在启动 AI 分析',
    'Analyzing batch': '正在分析评论批次',
    'Saving results': '正在保存分析结果',
    Completed: '已完成',
    Failed: '失败'
  };
  return map[step] || step || '';
}
