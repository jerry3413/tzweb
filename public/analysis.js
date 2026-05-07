// 评论解析页面：模板管理、分析任务创建、结果查看与人工确认。
// 沿用下载页面的整体模式：els 集中引用 → bindEvents → renderXxx 全量重绘。

const state = {
  templates: [],           // 模板索引列表
  currentTemplate: null,   // 当前正在编辑的完整模板
  downloadJobs: [],        // 已完成下载任务（用于 App 选择）
  analyses: [],            // 分析任务列表
  currentResults: null,    // 当前查看的分析结果
  polling: null,
  _selectedJobIds: '',     // 自定义下拉当前选中的 jobIds JSON 字符串
  editMode: false,         // 已分类评论是否处于编辑模式
  editHistory: [],         // 手动修正记录 [{ reviewId, reviewText, originalClasses, newClasses, changeType }]
  _addingTagForReviewId: null,  // 正在添加标签的 reviewId
  _currentDimensionsDesc: ''     // 当前选中模板的维度描述文本，供版本切换时复用
};

const RECENT_TAGS_KEY = 'tzweb_recent_tags';
const RECENT_TAGS_MAX = 15;

function getRecentTags() {
  try { return JSON.parse(localStorage.getItem(RECENT_TAGS_KEY)) || []; } catch { return []; }
}

function saveRecentTags(tags) {
  try { localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify(tags)); } catch {}
}

function addRecentTag(dimensionId, dimensionName, tagName, polarity) {
  const tags = getRecentTags();
  // 去重：同维度+同标签名视为重复，移除旧条目
  const idx = tags.findIndex((t) => t.dimensionId === dimensionId && t.tagName === tagName);
  if (idx >= 0) tags.splice(idx, 1);
  tags.unshift({ dimensionId, dimensionName, tagName, polarity, usedAt: new Date().toISOString() });
  if (tags.length > RECENT_TAGS_MAX) tags.length = RECENT_TAGS_MAX;
  saveRecentTags(tags);
}

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
  promptVersionSelect: document.querySelector('#promptVersionSelect'),
  startAnalysisBtn: document.querySelector('#startAnalysisBtn'),
  // 分析任务列表
  analysisTable: document.querySelector('#analysisTable'),
  reloadAnalyses: document.querySelector('#reloadAnalyses'),
  // 结果查看
  resultsSection: document.querySelector('#resultsSection'),
  resultsTitle: document.querySelector('#resultsTitle'),
  resultsSummary: document.querySelector('#resultsSummary'),
  dimensionStats: document.querySelector('#dimensionStats'),
  filterPolaritySummary: document.querySelector('#filterPolaritySummary'),
  polaritySortBtn: document.querySelector('#polaritySortBtn'),
  polaritySortModal: document.querySelector('#polaritySortModal'),
  polaritySortContent: document.querySelector('#polaritySortContent'),
  polaritySortClose: document.querySelector('#polaritySortClose'),
  filterDimension: document.querySelector('#filterDimension'),
  filterTag: document.querySelector('#filterTag'),
  filterConfidence: document.querySelector('#filterConfidence'),
  filterPolarity: document.querySelector('#filterPolarity'),
  filterHasNote: document.querySelector('#filterHasNote'),
  classifiedTable: document.querySelector('#classifiedTable'),
  lowConfidenceTable: document.querySelector('#lowConfidenceTable'),
  lowConfidenceSummary: document.querySelector('#lowConfidenceSummary'),
  lowConfBadge: document.querySelector('#lowConfBadge'),
  resultsTabs: document.querySelector('#resultsTabs'),
  backToJobsBtn: document.querySelector('#backToJobsBtn'),
  exportResultsBtn: document.querySelector('#exportResultsBtn'),
  // 编辑模式 + Prompt 优化
  editToggleBtn: document.querySelector('#editToggleBtn'),
  promptOptimizeBtn: document.querySelector('#promptOptimizeBtn'),
  promptOptimizeModal: document.querySelector('#promptOptimizeModal'),
  promptOptimizeClose: document.querySelector('#promptOptimizeClose'),
  promptOptimizeContent: document.querySelector('#promptOptimizeContent')
};

init();

async function init() {
  bindEvents();
  showRuntimeNoticeIfNeeded();

  try {
    await Promise.all([
      loadTemplates(),
      loadDownloadJobs(),
      loadPromptVersions()
    ]);
    await loadAnalyses();
    startPolling();
  } catch (error) {
    showRuntimeNotice(error);
  }
}

function bindEvents() {
  // 恢复上次使用的 API Key
  try {
    const savedKey = localStorage.getItem('tzweb_api_key');
    if (savedKey) els.apiKeyInput.value = savedKey;
  } catch {}

  els.newTemplateBtn.addEventListener('click', () => openTemplateEditor(null));
  els.closeTemplateEditor.addEventListener('click', closeTemplateEditorFn);
  els.saveTemplateBtn.addEventListener('click', saveTemplate);
  els.deleteTemplateBtn.addEventListener('click', deleteTemplate);
  els.resetTemplateBtn.addEventListener('click', resetTemplate);
  els.addDimensionBtn.addEventListener('click', addDimensionToEditor);
  els.startAnalysisBtn.addEventListener('click', submitAnalysis);
  els.toggleAdvancedBtn.addEventListener('click', toggleAdvancedSettings);
  els.analysisTemplateSelect.addEventListener('change', updateDefaultPrompts);
  els.promptVersionSelect.addEventListener('change', () => applyPromptVersion(els.promptVersionSelect.value));
  els.reloadAnalyses.addEventListener('click', loadAnalyses);
  els.backToJobsBtn.addEventListener('click', hideResults);
  els.exportResultsBtn.addEventListener('click', exportResultsCSV);
  els.editToggleBtn.addEventListener('click', toggleEditMode);
  els.promptOptimizeBtn.addEventListener('click', openPromptOptimization);
  els.promptOptimizeClose.addEventListener('click', closePromptOptimization);
  els.filterDimension.addEventListener('change', () => {
	    populateFilterTag(els.filterDimension.value);
	    renderFilteredReviews();
	  });
	  els.filterTag.addEventListener('change', renderFilteredReviews);
	  els.filterConfidence.addEventListener('change', renderFilteredReviews);
  els.filterPolarity.addEventListener('change', renderFilteredReviews);
  els.filterHasNote.addEventListener('change', renderFilteredReviews);
  els.filterPolaritySummary.addEventListener('change', renderDimensionStats);
  els.polaritySortBtn.addEventListener('click', showPolaritySortModal);
  els.polaritySortClose.addEventListener('click', () => { els.polaritySortModal.hidden = true; });
  els.polaritySortModal.addEventListener('click', (e) => { if (e.target === els.polaritySortModal) els.polaritySortModal.hidden = true; });
  els.polaritySortContent.addEventListener('click', (e) => {
    const badge = e.target.closest('.tag-badge[data-dim-id]');
    if (!badge) return;
    const dimId = badge.dataset.dimId;
    const tagId = badge.dataset.tagId;
    els.filterDimension.value = dimId;
    populateFilterTag(dimId);
    els.filterTag.value = tagId ? `${dimId}::${tagId}` : '';
    els.filterConfidence.value = '';
    els.filterPolarity.value = '';
    els.filterHasNote.value = '';
    switchResultsTab('classified');
    renderFilteredReviews();
  });

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
      els.filterPolarity.value = '';
      els.filterHasNote.value = '';
      els.filterPolaritySummary.value = '';
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
      els.filterPolarity.value = '';
      els.filterHasNote.value = '';
      els.filterPolaritySummary.value = '';
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
            <select class="tag-polarity-select" data-dim-index="${dimIndex}" data-tag-index="${tagIndex}" data-field="tagPolarity">
              <option value="">-- 方向 --</option>
              <option value="正向" ${tag.polarity === '正向' ? 'selected' : ''}>正向</option>
              <option value="负向" ${tag.polarity === '负向' ? 'selected' : ''}>负向</option>
              <option value="中性" ${tag.polarity === '中性' ? 'selected' : ''}>中性</option>
              <option value="需求" ${tag.polarity === '需求' ? 'selected' : ''}>需求</option>
            </select>
            <input class="tag-meaning-input" value="${escapeAttr(tag.productMeaning || '')}" placeholder="产品含义（可选）" data-dim-index="${dimIndex}" data-tag-index="${tagIndex}" data-field="tagMeaning">
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
      dim.tags.push({ id: '', name: '', polarity: '', productMeaning: '' });
      renderDimensionsEditor();
    }
  });

  // 输入框/下拉框变更时同步回 state.currentTemplate
  els.dimensionsEditor.addEventListener('input', (event) => {
    if (!state.currentTemplate) return;
    const input = event.target;
    const dimIndex = parseInt(input.dataset.dimIndex, 10);
    const tagIndex = input.dataset.tagIndex ? parseInt(input.dataset.tagIndex, 10) : -1;

    if (input.classList.contains('dim-name-input')) {
      state.currentTemplate.dimensions[dimIndex].name = input.value;
    } else if (input.classList.contains('dim-meaning-input')) {
      state.currentTemplate.dimensions[dimIndex].productMeaning = input.value;
    } else if (input.classList.contains('tag-name-input')) {
      state.currentTemplate.dimensions[dimIndex].tags[tagIndex].name = input.value;
    } else if (input.classList.contains('tag-meaning-input')) {
      state.currentTemplate.dimensions[dimIndex].tags[tagIndex].productMeaning = input.value;
    }
  });

  els.dimensionsEditor.addEventListener('change', (event) => {
    if (!state.currentTemplate) return;
    const select = event.target;
    if (select.classList.contains('tag-polarity-select')) {
      const dimIndex = parseInt(select.dataset.dimIndex, 10);
      const tagIndex = parseInt(select.dataset.tagIndex, 10);
      state.currentTemplate.dimensions[dimIndex].tags[tagIndex].polarity = select.value;
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

// 加载可用的 prompt 版本列表，填充下拉框。
async function loadPromptVersions() {
  try {
    const data = await fetchJson('/api/prompts/versions');
    const versions = data.versions || [];
    els.promptVersionSelect.innerHTML = versions.map((v) =>
      `<option value="${escapeAttr(v.version)}">v${escapeHtml(v.version)}${v.current ? '（最新）' : ''} — ${escapeHtml(v.description)}</option>`
    ).join('');
    // 默认选中最新版本
    const current = versions.find((v) => v.current);
    if (current) els.promptVersionSelect.value = current.version;
  } catch {
    els.promptVersionSelect.innerHTML = '<option value="">无法加载版本列表</option>';
  }
}

// 将指定版本的 prompt 模板填入 textarea。
// dimensionsDesc 从 state._currentDimensionsDesc 读取。
async function applyPromptVersion(version) {
  const dimsDesc = state._currentDimensionsDesc;
  if (!dimsDesc) return;

  // 尝试从服务端获取指定版本的 prompt 模板
  let promptTemplate = null;
  if (version) {
    try {
      const data = await fetchJson(`/api/prompts/versions/${encodeURIComponent(version)}`);
      promptTemplate = data.version?.promptTemplate;
    } catch (err) {
      console.error('加载 Prompt 版本失败：', err);
    }
  }

  if (promptTemplate) {
    els.systemPromptInput.value = promptTemplate.replace('${dimensionsDesc}', dimsDesc);
  }
  // 没有版本文件或版本不存在时，保持 textarea 原始内容不变
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

  // System Prompt：根据模板维度与标签生成，标签含产品含义帮助 AI 精确分类。
  // 过滤掉无意义的标签：id 为空或 name 为空的标签不传给 DeepSeek
  const dims = tpl.dimensions || [];
  const dimensionsDesc = dims.map((dim) => {
    const validTags = (dim.tags || []).filter((tag) => tag.id && tag.name);
    if (validTags.length === 0) return '';
    const tagsDesc = validTags.map((tag) => {
      const polarity = tag.polarity ? `[${tag.polarity}] ` : '';
      const meaning = tag.productMeaning ? ` — ${tag.productMeaning}` : '';
      return `  ${polarity}"${tag.name}"${meaning}`;
    }).join('\n');
    return `- ${dim.name}（${dim.productMeaning || ''}）：\n${tagsDesc}`;
  }).filter(Boolean).join('\n');

  // 缓存维度描述，供版本切换时复用
  state._currentDimensionsDesc = dimensionsDesc;

  // 先用硬编码最新版本作为 fallback，再尝试加载用户选择的版本
  els.systemPromptInput.value = `你是一个专业的 APP 用户评论分析助手。请根据以下模板维度与标签，对每条评论进行语义理解和分类。

## 分类规则
1. 一条评论可以同时匹配多个维度和多个标签。只要评论内容涉及该维度/标签，就应该标记。
2. 对每个匹配输出 confidence（0-1 的小数），表示你对这个分类的确信程度：
   - 0.9-1.0：评论明确表达了该含义
   - 0.7-0.9：评论高度暗示该含义
   - 0.5-0.7：评论可能涉及该含义，但不够明确
   - 低于 0.5：不要输出，视为不匹配
3. **无意义内容跳过**：对于无实质内容的评论（纯情绪表达如 "very good"/"good"/"bad"、乱码、纯表情、刷评灌水、与APP无关内容等），不要强行匹配任何维度/标签，直接返回空的 classifications 数组。
4. 如果评论内容与任何维度/标签都不相关，也返回空的 classifications 数组。
5. **重要**：只输出 JSON 数组，不要输出其他文字、解释或 markdown 代码块标记。
6. **note 补充信息**：仅当评论包含标签名未能覆盖的具体细节时才填写 note。note 是评论原文信息的提炼，不是标签名的复述或换说法。
   **必须填 note**（评论有标签名之外的具体信息）：
   - 正向标签：用户具体喜欢什么？（如评论"converts 50 pages in 3 seconds" + 标签"转换速度快" → note: "50页3秒转完"）
   - 负向标签：用户具体抱怨什么？（如评论"full screen ad every time I click convert" + 标签"广告多" → note: "每次点转换都弹全屏广告"）
   - 需求标签：用户具体建议什么功能？（如评论"need an option to choose output quality" + 标签"增加压缩选项" → note: "希望可选输出图片质量"）
   - 中性标签：用户的具体场景或动机是什么？（如评论"using this to scan my ID for exam submission" + 标签"办公/学习场景" → note: "扫描证件提交考试"）
   **禁止填 note**（评论内容已被标签名完全覆盖，无额外信息）：
   - 评论"too many ads" + 标签"广告多" → note 留空（没说广告在哪、何时弹）
   - 评论"very good app" + 标签"满意/好评" → note 留空（没说好在哪）
   - 评论"crashes every time" + 标签"闪退/崩溃" → note 留空（没说触发场景）
   - 评论"waste of money" + 标签"付费不满" → note 留空（没说哪里不值）
   - 评论只是换一种说法复述标签名 → note 留空
   **判断标准**：如果 note 和标签名表达的是同一件事，就留空。只有评论说出了标签名覆盖不了的具体细节时才填。

7. **维度区分指南**：当一条评论可能同时命中"功能完整性"和"功能质量"两个维度时，按以下标准区分：
   - 功能完整性：关注"功能是否存在、链路是否通畅"（有没有这个能力、能不能走完流程）
   - 功能质量：关注"功能执行完成后的结果好坏"（输出清不清晰、排版对不对、比例是否正常）
   例如："cannot convert images to PDF" → 功能完整性（能力缺失，任务无法执行）
   "converted but PDF is blurry" → 功能质量（任务完成了但结果不满意）
   "app crashes when I try to save" → 技术稳定性（崩溃），不是功能完整性也不是功能质量
   "I can't find the file after saving" → UI/交互（找不到保存位置），不是功能质量
8. **"其他"标签使用规则**：名称为"其他XXX"的标签是兜底选项，仅当评论明确不属于该维度下任何具体标签时才使用。命中"其他"标签时必须：
   - note 必填，简要说明评论的具体内容
   - 在 note 末尾附加 [新标签候选: XXX]，建议一个可新增的具体标签名
   例如：评论"the OCR feature misreads Chinese characters"命中"其他功能质量反馈" → note: "OCR识别中文字符出错 [新标签候选: OCR识别错误]"

## 模板维度与标签

${dimensionsDesc}

## 输出格式
请严格按以下 JSON 数组格式输出：
[{"reviewIndex": 0, "classifications": [{"dimension": "维度名称", "tag": "标签名称", "confidence": 0.85, "note": "具体内容（可选）"}]}, {"reviewIndex": 1, "classifications": []}]`;

  // User Prompt 模板：占位符会在服务端替换为实际评论数据
  els.userPromptInput.value = `以下是需要分类的 __BATCH_SIZE__ 条评论（每条包含 index、starRating 和 text）：

__REVIEWS_JSON__

请输出分类结果 JSON 数组：`;

  // 如果用户选择了非最新版本，用对应版本的 prompt 模板覆盖 System Prompt
  const selectedVersion = els.promptVersionSelect.value;
  if (selectedVersion) {
    await applyPromptVersion(selectedVersion);
  }
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
  // 记住上次使用的 API Key
  try { localStorage.setItem('tzweb_api_key', apiKey); } catch {}

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
      userPromptTemplate: els.userPromptInput.value.trim() || undefined,
      promptVersion: els.promptVersionSelect.value || undefined
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
  const pv = config.promptVersion ? ` · Prompt v${escapeHtml(config.promptVersion)}` : '';
  return `${config.parallelTasks || 20} 并行 · 阈值 ${config.confidenceThreshold || 0.6}${pv}`;
}

// ===== 结果查看 =====

async function viewResults(analysisId) {
  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(analysisId)}/results`);
    state.currentResults = data;
    mergeCustomTagsIntoLocalTemplate();
    state.editMode = false;
    state.editHistory = [];
    state._addingTagForReviewId = null;
    els.editToggleBtn.classList.remove('edit-toggle--active');
    els.editToggleBtn.textContent = '编辑标签';
    if (els.promptOptimizeBtn) els.promptOptimizeBtn.hidden = true;
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
    els.filterPolarity.value = '';
    els.filterHasNote.value = '';
    els.filterPolaritySummary.value = '';
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
  state.editMode = false;
  state.editHistory = [];
  state._addingTagForReviewId = null;
  els.editToggleBtn.classList.remove('edit-toggle--active');
  els.editToggleBtn.textContent = '编辑标签';
  if (els.promptOptimizeBtn) els.promptOptimizeBtn.hidden = true;
}

// 导出当前解析结果为 CSV 文件（每个分类一行，无分类的评论也导出一行）。
function exportResultsCSV() {
  const results = state.currentResults;
  if (!results || !results.reviews) return;

  const template = results.template;
  const allDimensions = template?.dimensions || [];
  const tagMetaMap = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagMetaMap.set(tag.id, { polarity: tag.polarity || '', tagName: tag.name, dimName: dim.name });
    }
  }

  const getPolarity = (c) => c.polarity || tagMetaMap.get(c.tagId)?.polarity || '';

  const headers = ['评论内容', '评分', '评论者', '评论日期', '维度', '标签', '向性', '置信度', '备注', '用户建议', '人工标注', '低置信度'];

  const rows = [];
  for (const review of results.reviews) {
    const suggestions = (review.suggestions || []).map((s) => `${s.category || ''}: ${s.description || ''}`).join('；');
    const classifications = review.classifications || [];

    if (classifications.length === 0) {
      rows.push([review.reviewText || '', review.starRating || '', review.reviewerName || '', review.reviewDate || '', '', '', '', '', '', suggestions, '', review.isLowConfidence ? '是' : '']);
    } else {
      for (const c of classifications) {
        rows.push([
          review.reviewText || '',
          review.starRating || '',
          review.reviewerName || '',
          review.reviewDate || '',
          c.dimensionName || '',
          c.tagName || '',
          getPolarity(c),
          typeof c.confidence === 'number' ? c.confidence.toFixed(2) : '',
          c.note || '',
          suggestions,
          c.manuallyAssigned ? '是' : '',
          review.isLowConfidence ? '是' : ''
        ]);
      }
    }
  }

  const csvContent = [headers, ...rows]
    .map((row) => row.map((cell) => {
      const str = String(cell ?? '');
      // CSV 转义：含逗号、引号或换行时用引号包裹，内部引号加倍
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(','))
    .join('\n');

  const bom = '﻿';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const appName = results.appName || results.template?.name || 'analysis';
  a.download = `${appName}_解析结果_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  const filterPolarity = els.filterPolaritySummary.value;
  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];

  // 构建 tagId → { polarity, tagName } 的索引
  const tagMetaMap = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagMetaMap.set(tag.id, { polarity: tag.polarity || '', tagName: tag.name });
    }
  }
  const getPolarity = (c) => c.polarity || tagMetaMap.get(c.tagId)?.polarity || '';

  // 向性筛选时，从原始评论实时计算统计；否则使用预计算的 dimensionStats
  let stats;
  if (filterPolarity) {
    stats = computePolarityFilteredStats(filterPolarity, getPolarity);
  } else {
    stats = state.currentResults?.dimensionStats || [];
  }

  if (stats.length === 0) {
    els.dimensionStats.innerHTML = '';
    return;
  }

  const maxCount = Math.max(...stats.map((s) => s.count), 1);

  els.dimensionStats.innerHTML = stats.map((dim) => {
    const percent = Math.round((dim.count / maxCount) * 100);
    const tagItems = (dim.tags || []).sort((a, b) => b.count - a.count).slice(0, 8).map((tag) => {
      const pol = tagMetaMap.get(tag.tagId)?.polarity || '';
      const polClass = pol === '正向' ? 'pol-positive' : pol === '负向' ? 'pol-negative' : pol === '需求' ? 'pol-demand' : 'pol-neutral';
      return `<span class="tag-badge" data-dim-id="${escapeAttr(dim.dimensionId)}" data-tag-id="${escapeAttr(tag.tagId || '')}" style="cursor: pointer;"><span class="polarity-tag ${polClass}">${escapeHtml(pol)}</span>${escapeHtml(tag.tagName)} (${tag.count})</span>`;
    }).join('');

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

// 按向性筛选评论后，实时计算维度/标签统计。
// 结构与服务端 calculateDimensionStats 一致，但仅统计匹配向性的分类。
function computePolarityFilteredStats(polarity, getPolarity) {
  const reviews = state.currentResults?.reviews || [];
  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];

  // dimId → { dimensionId, dimensionName, count, tagCounts: Map<tagId, count> }
  const dimMap = new Map();
  for (const dim of allDimensions) {
    dimMap.set(dim.id, { dimensionId: dim.id, dimensionName: dim.name, count: 0, tagCounts: new Map() });
  }
  // 无意义内容维度
  dimMap.set('_meaningless', { dimensionId: '_meaningless', dimensionName: '无意义', count: 0, tagCounts: new Map() });

  for (const review of reviews) {
    if (review.isLowConfidence) continue;
    for (const c of (review.classifications || [])) {
      if (getPolarity(c) !== polarity) continue;
      const dim = dimMap.get(c.dimensionId);
      if (!dim) continue;
      dim.count += 1;
      const tagId = c.tagId || c.tagName;
      dim.tagCounts.set(tagId, (dim.tagCounts.get(tagId) || 0) + 1);
    }
  }

  return [...dimMap.values()]
    .filter((dim) => dim.count > 0)
    .map((dim) => ({
      dimensionId: dim.dimensionId,
      dimensionName: dim.dimensionName,
      count: dim.count,
      tags: [...dim.tagCounts.entries()].map(([tagId, count]) => {
        // 从模板维度查找标签名；自定义标签直接用 tagId
        const templateDim = allDimensions.find((d) => d.id === dim.dimensionId);
        const templateTag = templateDim?.tags?.find((t) => t.id === tagId);
        const tagName = templateTag?.name || tagId;
        return { tagId, tagName, count };
      }).filter((t) => t.count > 0).sort((a, b) => b.count - a.count)
    }));
}

// 向性排序弹窗：将所有标签按正向/负向/需求/中性分组，组内按频次由大到小排序。
// 点击标签可跳转查看对应评论，不关闭弹窗。
function showPolaritySortModal() {
  const reviews = state.currentResults?.reviews || [];
  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];

  // 构建 tagId → { polarity, tagName, dimName, dimId } 索引
  const tagMeta = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagMeta.set(tag.id, { polarity: tag.polarity || '', tagName: tag.name, dimName: dim.name, dimId: dim.id });
    }
  }

  // polarity → Map<dimId::tagId, { dimId, tagId, dimName, tagName, count }>
  const groupMaps = { '正向': new Map(), '负向': new Map(), '需求': new Map(), '中性': new Map() };

  for (const review of reviews) {
    if (review.isLowConfidence) continue;
    for (const c of (review.classifications || [])) {
      const meta = tagMeta.get(c.tagId);
      if (!meta) continue;
      const polarity = c.polarity || meta.polarity || '中性';
      const gm = groupMaps[polarity] || (groupMaps[polarity] = new Map());
      const key = `${meta.dimId}::${c.tagId}`;
      const entry = gm.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        gm.set(key, { dimId: meta.dimId, tagId: c.tagId, dimName: meta.dimName, tagName: meta.tagName, count: 1 });
      }
    }
  }

  const order = ['负向', '正向', '需求', '中性'];
  let html = '';

  for (const pol of order) {
    const entries = [...(groupMaps[pol] || new Map()).values()].sort((a, b) => b.count - a.count);
    if (entries.length === 0) continue;
    const polClass = pol === '正向' ? 'pol-positive' : pol === '负向' ? 'pol-negative' : pol === '需求' ? 'pol-demand' : 'pol-neutral';
    const total = entries.reduce((s, e) => s + e.count, 0);
    html += `<div style="margin-bottom: 18px;">
      <h4 style="margin-bottom: 8px;"><span class="polarity-tag ${polClass}" style="margin-right: 6px;">${pol}</span> 共 ${total} 条</h4>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">`;
    for (const e of entries) {
      html += `<span class="tag-badge" style="font-size: 13px; padding: 4px 10px; cursor: pointer;" data-dim-id="${escapeAttr(e.dimId)}" data-tag-id="${escapeAttr(e.tagId)}">${escapeHtml(e.dimName)} · ${escapeHtml(e.tagName)} <strong>${e.count}</strong></span>`;
    }
    html += `</div></div>`;
  }

  els.polaritySortContent.innerHTML = html || '<p>暂无数据。</p>';
  els.polaritySortModal.hidden = false;
}

function populateFilterDimension() {
  const template = state.currentResults?.template;
  const stats = state.currentResults?.dimensionStats || [];
  const statMap = new Map(stats.map((s) => [s.dimensionId, s.count]));
  const dims = (template?.dimensions || []).slice();
  // 确保无意义维度在列表中（不在模板维度里，是系统内置维度）
  dims.push({ id: '_meaningless', name: '无意义' });
  els.filterDimension.innerHTML = '<option value="">全部维度</option>' +
    dims.map((dim) => {
      const count = statMap.get(dim.id) || 0;
      return `<option value="${escapeAttr(dim.id)}">${escapeHtml(dim.name)}（${count}）</option>`;
    }).join('');
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

  // 补充扫描 reviews 中的自定义标签，确保手动添加的标签也能出现在筛选项中
  const reviews = state.currentResults?.reviews || [];
  for (const r of reviews) {
    for (const c of (r.classifications || [])) {
      if (c.suggested) continue;
      const key = `${c.dimensionId}::${c.tagId || c.tagName}`;
      if (!seen.has(key) && c.tagName) {
        seen.add(key);
        unique.push({ tagId: c.tagId, tagName: c.tagName, count: 0, _dimId: c.dimensionId });
      }
    }
  }

  els.filterTag.innerHTML = '<option value="">全部标签</option>' +
    unique.map((t) => `<option value="${escapeAttr(t._dimId + '::' + (t.tagId || t.tagName))}">${escapeHtml(t.tagName)}（${t.count}）</option>`).join('');
}

// 已分类评论表：支持按维度、标签、置信度和向性筛选，支持编辑模式修改分类。
function renderFilteredReviews() {
  mergeCustomTagsIntoLocalTemplate();
  const reviews = state.currentResults?.reviews || [];
  const filterDim = els.filterDimension.value;
  const filterTag = els.filterTag.value;
  const filterConf = els.filterConfidence.value;
  const filterPolarity = els.filterPolarity.value;

  // 构建 tagId → { polarity, tagName } 的索引，用于向性筛选和显示
  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];
  const tagMetaMap = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagMetaMap.set(tag.id, { polarity: tag.polarity || '', tagName: tag.name });
    }
  }

  // 获取分类的实际向性（优先人工标注，其次模板定义）
  const getPolarity = (c) => c.polarity || tagMetaMap.get(c.tagId)?.polarity || '';

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
  // 默认隐藏仅含"无意义"标签的评论，筛选无意义维度或标签时则展示
  if (!filterTag && filterDim !== '_meaningless') {
    filtered = filtered.filter((r) => !r.classifications.every((c) => c.tagId === '_meaningless'));
  }

  if (filterConf === 'high') {
    filtered = filtered.filter((r) => r.classifications.some((c) => c.confidence >= 0.8));
  } else if (filterConf === 'medium') {
    filtered = filtered.filter((r) => r.classifications.some((c) => c.confidence >= 0.6 && c.confidence < 0.8));
  } else if (filterConf === 'low') {
    filtered = filtered.filter((r) => r.classifications.every((c) => c.confidence < 0.6));
  }

  if (filterPolarity) {
    filtered = filtered.filter((r) => r.classifications.some((c) => getPolarity(c) === filterPolarity));
  }

  if (els.filterHasNote.value === 'yes') {
    filtered = filtered.filter((r) => (r.classifications || []).some((c) => c.note && c.note.trim()));
  }

  // 更新编辑按钮文案和状态
  els.editToggleBtn.textContent = state.editMode ? '退出编辑' : '编辑标签';
  els.editToggleBtn.classList.toggle('edit-toggle--active', state.editMode);

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

  const editMode = state.editMode;

  els.classifiedTable.innerHTML = filtered.map((r) => {
    const isAdding = state._addingTagForReviewId === r.reviewId;
    const hasNotes = (r.classifications || []).some((c) => c.note && c.note.trim());

    return `
    <tr data-review-id="${escapeAttr(r.reviewId)}">
      <td style="max-width: 320px;">
        <div class="review-text-cell">${escapeHtml(r.reviewText || '')}</div>
        ${r.reviewerName ? `<div class="muted" style="margin-top: 4px;">— ${escapeHtml(r.reviewerName)}</div>` : ''}
      </td>
      <td>${'★'.repeat(Math.min(5, r.starRating || 0))}${r.starRating ? ` ${r.starRating}` : ''}</td>
      <td>
        <div class="tag-badges">
          ${(r.classifications || []).map((c) => {
            const isMatch = filterTagRaw && c.dimensionId === filterTagDimId && (c.tagId === filterTagId || c.tagName === filterTagId);
            const polarity = c.polarity || tagMetaMap.get(c.tagId)?.polarity || '';
            const polClass = polarity === '正向' ? 'pol-positive' : polarity === '负向' ? 'pol-negative' : polarity === '需求' ? 'pol-demand' : 'pol-neutral';
            return `<span class="tag-badge${isMatch ? ' tag-badge--match' : ''}" title="${escapeAttr(c.note || '')}">
              <span class="polarity-tag ${polClass}">${escapeHtml(polarity)}</span>
              ${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)}
              ${editMode ? `<button class="badge-delete" type="button" data-dim-id="${escapeAttr(c.dimensionId)}" data-tag-id="${escapeAttr(c.tagId || c.tagName)}" title="删除此分类">&times;</button>` : ''}
            </span>`;
          }).join('')}
        </div>
        ${hasNotes ? `
        <div class="tag-notes">
          ${(r.classifications || []).filter((c) => c.note && c.note.trim()).map((c) => `<span class="tag-note">📝 ${escapeHtml(c.note.trim())}</span>`).join('')}
        </div>` : ''}
        ${editMode ? `
        <div style="margin-top: 6px;">
          ${isAdding ? `
            <div class="inline-add-tag" style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              ${(() => {
                const recent = getRecentTags();
                if (recent.length === 0) return '';
                return `<div style="display: flex; gap: 4px; flex-wrap: wrap; width: 100%; margin-bottom: 2px;">
                  <span style="font-size: 11px; color: var(--ink-3); line-height: 24px;">最近：</span>
                  ${recent.slice(0, 10).map((rt) => {
                    const pClass = rt.polarity === '正向' ? 'pol-positive' : rt.polarity === '负向' ? 'pol-negative' : rt.polarity === '需求' ? 'pol-demand' : 'pol-neutral';
                    return `<button class="recent-tag-chip" type="button"
                      data-dim-id="${escapeAttr(rt.dimensionId)}"
                      data-tag-name="${escapeAttr(rt.tagName)}"
                      data-polarity="${escapeAttr(rt.polarity || '')}"
                      data-review-id="${escapeAttr(r.reviewId)}"
                      title="${escapeAttr(rt.dimensionName)} · ${escapeAttr(rt.tagName)}"
                      style="font-size: 11px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); cursor: pointer; white-space: nowrap; line-height: 22px;"
                    ><span class="polarity-tag ${pClass}" style="font-size: 9px; padding: 0 3px; margin-right: 2px;">${escapeHtml(rt.polarity)}</span>${escapeHtml(rt.tagName)}</button>`;
                  }).join('')}
                </div>`;
              })()}
              <select class="add-dim-select" data-review-id="${escapeAttr(r.reviewId)}" style="height: 28px; font-size: 12px;">
                <option value="">选择维度</option>
                ${allDimensions.map((dim) => `<option value="${escapeAttr(dim.id)}">${escapeHtml(dim.name)}</option>`).join('')}
              </select>
              <input class="add-tag-input" data-review-id="${escapeAttr(r.reviewId)}" list="tag-datalist-${escapeAttr(r.reviewId)}" placeholder="选择或输入标签" style="height: 28px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; background: var(--paper);">
              <datalist id="tag-datalist-${escapeAttr(r.reviewId)}"></datalist>
              <select class="add-polarity-select" data-review-id="${escapeAttr(r.reviewId)}" style="height: 28px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 4px; background: var(--paper);">
                <option value="">向性</option>
                <option value="正向">正向</option>
                <option value="负向">负向</option>
                <option value="中性">中性</option>
                <option value="需求">需求</option>
              </select>
              <input class="add-note-input" data-review-id="${escapeAttr(r.reviewId)}" placeholder="备注（可选）" style="height: 28px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; background: var(--paper); min-width: 140px;">
              <button class="secondary-button compact-button confirm-add-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button" style="background: #1d4ed8; color: #fff; border-color: #1d4ed8;">确认</button>
              <button class="secondary-button compact-button cancel-add-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button">取消</button>
            </div>
          ` : `
            <button class="secondary-button compact-button show-add-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button">＋ 添加标签</button>
          `}
        </div>` : ''}
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
  `}).join('');

  // 编辑模式：绑定行内编辑事件
  if (editMode) {
    bindEditModeEvents(allDimensions);
  }
}

// 编辑模式：切换开关。
function toggleEditMode() {
  state.editMode = !state.editMode;
  state._addingTagForReviewId = null;
  renderFilteredReviews();
}

// 绑定编辑模式下的行内控件事件。
function bindEditModeEvents(allDimensions) {
  // 删除分类按钮
  els.classifiedTable.querySelectorAll('.badge-delete').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const row = btn.closest('tr');
      const reviewId = row.dataset.reviewId;
      const dimId = btn.dataset.dimId;
      const tagId = btn.dataset.tagId;
      await deleteClassification(reviewId, dimId, tagId);
    });
  });

  // 显示添加标签表单
  els.classifiedTable.querySelectorAll('.show-add-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state._addingTagForReviewId = btn.dataset.reviewId;
      renderFilteredReviews();
    });
  });

  // 取消添加标签
  els.classifiedTable.querySelectorAll('.cancel-add-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state._addingTagForReviewId = null;
      renderFilteredReviews();
    });
  });

  // 维度下拉联动标签建议（更新 datalist）
  els.classifiedTable.querySelectorAll('.add-dim-select').forEach((select) => {
    select.addEventListener('change', () => {
      const reviewId = select.dataset.reviewId;
      const dim = allDimensions.find((d) => d.id === select.value);
      const datalist = document.getElementById(`tag-datalist-${reviewId}`);
      if (datalist) {
        datalist.innerHTML = (dim ? dim.tags.map((tag) => `<option value="${escapeAttr(tag.name)}">`) : []).join('');
      }
    });
  });

  // 确认添加标签（支持自由输入自定义标签名、向性和备注）
  els.classifiedTable.querySelectorAll('.confirm-add-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimSelect = els.classifiedTable.querySelector(`.add-dim-select[data-review-id="${reviewId}"]`);
      const tagInput = els.classifiedTable.querySelector(`.add-tag-input[data-review-id="${reviewId}"]`);
      const polaritySelect = els.classifiedTable.querySelector(`.add-polarity-select[data-review-id="${reviewId}"]`);
      const noteInput = els.classifiedTable.querySelector(`.add-note-input[data-review-id="${reviewId}"]`);
      const dimId = dimSelect.value;
      const tagName = (tagInput.value || '').trim();
      const polarity = (polaritySelect?.value || '').trim();
      const note = (noteInput?.value || '').trim();

      if (!dimId || !tagName) {
        window.alert('请同时选择维度和输入标签名。');
        return;
      }

      await confirmAddTag(reviewId, dimId, tagName, allDimensions, polarity, note);
    });
  });

  // 最近标签快捷选中：点击芯片自动填充表单
  els.classifiedTable.querySelectorAll('.recent-tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const reviewId = chip.dataset.reviewId;
      const dimSelect = els.classifiedTable.querySelector(`.add-dim-select[data-review-id="${reviewId}"]`);
      const tagInput = els.classifiedTable.querySelector(`.add-tag-input[data-review-id="${reviewId}"]`);
      const polaritySelect = els.classifiedTable.querySelector(`.add-polarity-select[data-review-id="${reviewId}"]`);
      const datalist = document.getElementById(`tag-datalist-${reviewId}`);

      if (dimSelect) dimSelect.value = chip.dataset.dimId;
      if (tagInput) tagInput.value = chip.dataset.tagName;
      if (polaritySelect) polaritySelect.value = chip.dataset.polarity;

      // 更新 datalist 以匹配选中的维度
      if (datalist && dimSelect) {
        const dim = allDimensions.find((d) => d.id === dimSelect.value);
        datalist.innerHTML = (dim ? dim.tags.map((tag) => `<option value="${escapeAttr(tag.name)}">`) : []).join('');
      }
    });
  });
}

// 删除评论的某个分类。
async function deleteClassification(reviewId, dimId, tagId) {
  const review = (state.currentResults.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) return;

  const originalClasses = (review.classifications || []).map((c) => ({
    dimensionId: c.dimensionId, dimensionName: c.dimensionName,
    tagId: c.tagId, tagName: c.tagName, confidence: c.confidence
  }));

  // 移除匹配的分类
  const newClasses = (review.classifications || []).filter((c) =>
    !(c.dimensionId === dimId && (c.tagId === tagId || c.tagName === tagId))
  );

  try {
    await saveReviewClassifications(reviewId, newClasses);
    // 记录修正历史
    recordEditHistory(review, originalClasses, newClasses, 'tag_removed');
    // 更新本地状态
    review.classifications = newClasses;
    review.isLowConfidence = newClasses.length === 0;
    updateLocalSummary();
    await refreshResultsFromServer();
    // 保存当前筛选状态，避免重建下拉框后丢失
    const savedDimFilter = els.filterDimension.value;
    const savedTagFilter = els.filterTag.value;
    populateFilterDimension();
    if ([...els.filterDimension.options].some((o) => o.value === savedDimFilter)) {
      els.filterDimension.value = savedDimFilter;
    }
    populateFilterTag(els.filterDimension.value);
    if ([...els.filterTag.options].some((o) => o.value === savedTagFilter)) {
      els.filterTag.value = savedTagFilter;
    }
    renderFilteredReviews();
    renderDimensionStats();
    // 如果评论移到了低置信度，刷新待确认列表
    if (review.isLowConfidence) {
      renderLowConfidence();
    }
  } catch (error) {
    window.alert(`删除分类失败：${error.message}`);
  }
}

// 添加标签到评论。tagName 可以是已有标签名或自定义新标签名。
// polarity 和 note 可选，用于手工创建标签时填写向性和备注。
async function confirmAddTag(reviewId, dimId, tagName, allDimensions, polarity = '', note = '') {
  const review = (state.currentResults.reviews || []).find((r) => r.reviewId === reviewId);
  if (!review) return;

  const dim = allDimensions.find((d) => d.id === dimId);
  const existingTag = dim?.tags.find((t) => t.name === tagName || t.id === tagName);

  const originalClasses = (review.classifications || []).map((c) => ({
    dimensionId: c.dimensionId, dimensionName: c.dimensionName,
    tagId: c.tagId, tagName: c.tagName, confidence: c.confidence
  }));

  // 检查是否已存在相同分类
  const resolvedTagId = existingTag ? existingTag.id : `custom-${Date.now()}`;
  const resolvedTagName = existingTag ? existingTag.name : tagName;
  const exists = (review.classifications || []).some((c) =>
    c.dimensionId === dimId && (c.tagName === resolvedTagName || c.tagId === resolvedTagId)
  );
  if (exists) {
    window.alert('该标签已存在于此评论上。');
    return;
  }

  const newClass = {
    dimensionId: dimId,
    dimensionName: dim?.name || '',
    tagId: resolvedTagId,
    tagName: resolvedTagName,
    confidence: 1,
    manuallyAssigned: true
  };
  if (polarity) newClass.polarity = polarity;
  if (note) newClass.note = note;

  const newClasses = [...(review.classifications || []), newClass];

  try {
    await saveReviewClassifications(reviewId, newClasses);
    recordEditHistory(review, originalClasses, newClasses, 'tag_added');
    addRecentTag(dimId, dim?.name || '', resolvedTagName, polarity);
    review.classifications = newClasses;
    review.isLowConfidence = false;
    // 本地更新 template，确保 datalist 和建议列表立即包含新添加的自定义标签
    if (!existingTag && state.currentResults?.template?.dimensions) {
      const templateDim = state.currentResults.template.dimensions.find((d) => d.id === dimId);
      if (templateDim?.tags) {
        templateDim.tags.push({ id: resolvedTagId, name: resolvedTagName });
      }
    }
    state._addingTagForReviewId = null;
    updateLocalSummary();
    await refreshResultsFromServer();
    // 保存当前筛选状态，避免重建下拉框后丢失
    const savedDimFilter2 = els.filterDimension.value;
    const savedTagFilter2 = els.filterTag.value;
    populateFilterDimension();
    if ([...els.filterDimension.options].some((o) => o.value === savedDimFilter2)) {
      els.filterDimension.value = savedDimFilter2;
    }
    populateFilterTag(els.filterDimension.value);
    if ([...els.filterTag.options].some((o) => o.value === savedTagFilter2)) {
      els.filterTag.value = savedTagFilter2;
    }
    renderFilteredReviews();
    renderDimensionStats();
  } catch (error) {
    window.alert(`添加标签失败：${error.message}`);
  }
}

// 保存评论分类到后端（全量替换）。
async function saveReviewClassifications(reviewId, classifications) {
  return fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/reviews/${encodeURIComponent(reviewId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ classifications })
  });
}

// 从后端重新加载结果中的 dimensionStats、summary 和 template。
async function refreshResultsFromServer() {
  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/results`);
    state.currentResults.dimensionStats = data.dimensionStats;
    state.currentResults.summary = data.summary;
    state.currentResults.template = data.template;
    mergeCustomTagsIntoLocalTemplate();
  } catch {
    // 静默失败，前端已有乐观更新
  }
}

// 将评论中手工添加的自定义标签合并到本地模板缓存。
// 服务端模板不包含运行时创建的自定义标签，前端从实际分类数据中提取并补充。
function mergeCustomTagsIntoLocalTemplate() {
  const reviews = state.currentResults?.reviews || [];
  const template = state.currentResults?.template;
  if (!template?.dimensions) return;

  for (const review of reviews) {
    for (const c of (review.classifications || [])) {
      if (!c.manuallyAssigned && !c.suggested) continue;
      const dim = template.dimensions.find((d) => d.id === c.dimensionId);
      if (!dim) continue;
      if (!dim.tags) dim.tags = [];
      const exists = dim.tags.some((t) => t.id === c.tagId || t.name === c.tagName);
      if (!exists) {
        dim.tags.push({ id: c.tagId, name: c.tagName, polarity: c.polarity || '' });
      }
    }
  }
}

// 记录一条手动修正历史。
function recordEditHistory(review, originalClasses, newClasses, changeType) {
  state.editHistory.push({
    reviewId: review.reviewId,
    reviewText: review.reviewText || '',
    originalClasses,
    newClasses: newClasses.map((c) => ({
      dimensionId: c.dimensionId, dimensionName: c.dimensionName,
      tagId: c.tagId, tagName: c.tagName, confidence: c.confidence
    })),
    changeType
  });

  // 显示/隐藏优化按钮
  if (els.promptOptimizeBtn) {
    els.promptOptimizeBtn.hidden = state.editHistory.length === 0;
    if (state.editHistory.length > 0) {
      els.promptOptimizeBtn.textContent = `优化 Prompt（${state.editHistory.length}）`;
    }
  }
}

// 打开 Prompt 优化弹窗：发送修正记录到后端分析。
async function openPromptOptimization() {
  if (state.editHistory.length === 0) return;

  els.promptOptimizeModal.hidden = false;
  els.promptOptimizeContent.innerHTML = `
    <div style="text-align: center; padding: 24px;">
      <p>正在分析 ${state.editHistory.length} 条修正记录...</p>
      <p class="muted" style="margin-top: 8px;">调用 DeepSeek 分析修正模式并生成 prompt 改进建议</p>
    </div>
  `;

  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/prompt-optimization`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits: state.editHistory })
    });
    renderPromptOptimization(data);
  } catch (error) {
    els.promptOptimizeContent.innerHTML = `
      <div style="color: var(--danger); padding: 24px;">
        <p>分析失败：${escapeHtml(error.message)}</p>
        <button class="secondary-button" type="button" onclick="document.getElementById('promptOptimizeModal').hidden=true" style="margin-top: 12px;">关闭</button>
      </div>
    `;
  }
}

// 渲染 prompt 优化建议。
function renderPromptOptimization(data) {
  const suggestions = data.suggestions || [];
  const summary = data.summary || '';

  if (suggestions.length === 0) {
    els.promptOptimizeContent.innerHTML = `
      <p>未发现明显的修正模式，当前 prompt 表现良好。</p>
      <p class="muted" style="margin-top: 8px;">${summary || ''}</p>
    `;
    return;
  }

  const severityLabel = { high: '严重', medium: '一般', low: '轻微' };
  const severityColor = { high: 'var(--danger)', medium: '#f0a020', low: 'var(--muted)' };

  els.promptOptimizeContent.innerHTML = `
    ${summary ? `<div class="opt-summary"><strong>总结：</strong>${escapeHtml(summary)}</div>` : ''}
    ${suggestions.map((s, i) => `
      <div class="opt-suggestion" style="border-left: 3px solid ${severityColor[s.severity] || 'var(--line)'}; margin-bottom: 16px; padding: 12px 16px; background: var(--bg-card); border-radius: 8px;">
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
          <span class="opt-severity" style="background: ${severityColor[s.severity] || 'var(--line)'}; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 900;">${severityLabel[s.severity] || s.severity}</span>
          <span class="opt-category" style="font-size: 12px; color: var(--muted);">${escapeHtml(s.category || '')}</span>
        </div>
        <p style="font-weight: 900; margin-bottom: 6px;">${escapeHtml(s.problem || '')}</p>
        ${s.affectedTags && s.affectedTags.length > 0 ? `
          <p style="font-size: 12px; color: var(--muted); margin-bottom: 8px;">
            相关标签：${s.affectedTags.map((t) => `<code style="background: var(--bg); padding: 1px 6px; border-radius: 3px;">${escapeHtml(t)}</code>`).join(' ')}
          </p>
        ` : ''}
        <div class="opt-fix" style="background: var(--bg); padding: 10px 14px; border-radius: 6px; margin-bottom: 8px; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(s.promptFix || '')}</div>
        ${s.exampleReviews && s.exampleReviews.length > 0 ? `
          <p style="font-size: 12px; color: var(--muted);">示例评论：${s.exampleReviews.slice(0, 3).map((r) => `"${escapeHtml(r)}"`).join('、')}</p>
        ` : ''}
        ${i < suggestions.length - 1 ? '<hr style="border-color: var(--line); margin-top: 12px;">' : ''}
      </div>
    `).join('')}
    <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end;">
      <button class="secondary-button compact-button" type="button" onclick="document.getElementById('promptOptimizeModal').hidden=true">关闭</button>
      <button class="secondary-button compact-button" type="button" style="background: var(--accent); color: #fff; border-color: var(--accent);" onclick="navigator.clipboard.writeText(this.closest('.modal-body').querySelector('.opt-fix')?.textContent || '').then(()=>alert('已复制第一条建议到剪贴板'))">复制建议</button>
    </div>
  `;
}

// 关闭 Prompt 优化弹窗。
function closePromptOptimization() {
  els.promptOptimizeModal.hidden = true;
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

  // 构建 tagId → { polarity, tagName } 的索引
  const tagMetaMap = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagMetaMap.set(tag.id, { polarity: tag.polarity || '', tagName: tag.name });
    }
  }

  els.lowConfidenceTable.innerHTML = lowConf.map((r) => {
    const regularClasses = (r.classifications || []).filter((c) => !c.suggested);
    const suggestedClasses = (r.classifications || []).filter((c) => c.suggested);
    const allClasses = (r.classifications || []);
    const hasNotes = allClasses.some((c) => c.note && c.note.trim());

    return `
    <tr data-review-id="${escapeAttr(r.reviewId)}">
      <td style="max-width: 320px;">
        <div class="review-text-cell">${escapeHtml(r.reviewText || '')}</div>
      </td>
      <td>${'★'.repeat(Math.min(5, r.starRating || 0))} ${r.starRating || '-'}</td>
      <td>
        <div class="tag-badges">
          ${regularClasses.length > 0
            ? regularClasses.map((c) => {
                const polarity = c.polarity || tagMetaMap.get(c.tagId)?.polarity || '';
                const polClass = polarity === '正向' ? 'pol-positive' : polarity === '负向' ? 'pol-negative' : polarity === '需求' ? 'pol-demand' : 'pol-neutral';
                return `<span class="tag-badge" title="${escapeAttr(c.note || '')}"><span class="polarity-tag ${polClass}">${escapeHtml(polarity)}</span>${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round(c.confidence * 100)}%)</span>`;
              }).join('')
            : (suggestedClasses.length === 0 ? '<span class="muted">AI 未能匹配</span>' : '')}
          ${suggestedClasses.map((c) => {
            const polarity = c.polarity || tagMetaMap.get(c.tagId)?.polarity || '';
            const polClass = polarity === '正向' ? 'pol-positive' : polarity === '负向' ? 'pol-negative' : polarity === '需求' ? 'pol-demand' : 'pol-neutral';
            return `<span class="tag-badge tag-badge--suggested" title="${escapeAttr(c.note || '')}"><span class="polarity-tag ${polClass}">${escapeHtml(polarity)}</span>AI 建议: ${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round(c.confidence * 100)}%)</span>`;
          }).join('')}
        </div>
        ${hasNotes ? `
        <div class="tag-notes">
          ${allClasses.filter((c) => c.note && c.note.trim()).map((c) => `<span class="tag-note">📝 ${escapeHtml(c.note.trim())}</span>`).join('')}
        </div>` : ''}
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
        <button class="secondary-button compact-button reassign-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button">添加标签</button>
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
        (dim ? dim.tags.map((tag) => `<option value="${escapeAttr(tag.id || tag.name)}">${escapeHtml(tag.name)}</option>`).join('') : '');
    });
  });

  // 添加标签按钮：将手动选择的标签追加到评论分类中，保留已有的 AI 建议。
  els.lowConfidenceTable.querySelectorAll('.reassign-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimSelect = els.lowConfidenceTable.querySelector(`.reassign-dim-select[data-review-id="${reviewId}"]`);
      const tagSelect = els.lowConfidenceTable.querySelector(`.reassign-tag-select[data-review-id="${reviewId}"]`);
      const dimId = dimSelect.value;
      const tagValue = tagSelect.value; // 可能是 tagId 或 tagName（空 id 标签的回退）

      if (!dimId || !tagValue) {
        window.alert('请同时选择维度和标签。');
        return;
      }

      const dim = allDimensions.find((d) => d.id === dimId);
      const tag = dim?.tags.find((t) => t.id === tagValue || t.name === tagValue);
      const tagName = tag?.name || tagValue;
      const tagId = tag?.id || tagValue;

      const review = state.currentResults.reviews.find((r) => r.reviewId === reviewId);
      if (!review) return;

      // 检查是否已存在相同标签
      const exists = (review.classifications || []).some(
        (c) => c.dimensionId === dimId && (c.tagId === tagId || c.tagName === tagName)
      );
      if (exists) {
        window.alert('该标签已存在于此评论上。');
        return;
      }

      const originalClasses = (review.classifications || []).map((c) => ({
        dimensionId: c.dimensionId, dimensionName: c.dimensionName,
        tagId: c.tagId, tagName: c.tagName, confidence: c.confidence,
        suggested: !!c.suggested
      }));

      // 追加新标签，保留已有分类
      const newClasses = [...(review.classifications || []), {
        dimensionId: dimId,
        dimensionName: dim?.name || '',
        tagId: tagId,
        tagName: tagName,
        confidence: 1,
        manuallyAssigned: true
      }];

      try {
        await saveReviewClassifications(reviewId, newClasses);

        recordEditHistory(review, originalClasses, newClasses, 'tag_added');
        addRecentTag(dimId, dim?.name || '', tagName, tag?.polarity || '');
        review.classifications = newClasses;

        // 如果还有 AI 建议标签未处理，继续保留在待确认列表
        const hasSuggestions = newClasses.some((c) => c.suggested);
        const threshold = state.currentResults.summary?.confidenceThreshold || 0.6;
        if (!hasSuggestions && newClasses.length > 0) {
          const hasHighEnough = newClasses.some((c) => c.confidence >= threshold);
          review.isLowConfidence = !hasHighEnough;
        }

        updateLocalSummary();
        renderLowConfidence();
        renderDimensionStats();
      } catch (error) {
        window.alert(`添加标签失败：${error.message}`);
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
        // 记录最近使用的标签
        const sc = (review?.classifications || []).find(
          (c) => c.dimensionName === dimensionName && c.tagName === tagName
        );
        addRecentTag(data.dimensionId, dimensionName, tagName, sc?.polarity || '');
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
