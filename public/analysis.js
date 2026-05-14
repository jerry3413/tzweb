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
  _currentDimensionsDesc: '',    // 当前选中模板的维度描述文本，供版本切换时复用
  _selectedLowConfIds: new Set(), // 待确认列表多选的 reviewId 集合
  _selectedClassifiedIds: new Set() // 已分类列表多选的 reviewId 集合
};

const RECENT_TAGS_KEY = 'tzweb_recent_tags';
const RECENT_TAGS_MAX = 15;

function cleanDimName(name) {
  return (name || '').replace(/[（(][^）)]*[）)]\s*$/g, '').trim();
}

function cleanTagNameJS(name) {
  return (name || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

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
  createTemplateBtn: document.querySelector('#createTemplateBtn'),
  createTemplateModal: document.querySelector('#createTemplateModal'),
  createTemplateClose: document.querySelector('#createTemplateClose'),
  createTemplateTabs: document.querySelector('#createTemplateTabs'),
  importTemplateFileInput: document.querySelector('#importTemplateFileInput'),
  importJsonBtn: document.querySelector('#importJsonBtn'),
  createBlankBtn: document.querySelector('#createBlankBtn'),
  manualTemplateName: document.querySelector('#manualTemplateName'),
  closeTemplateEditor: document.querySelector('#closeTemplateEditor'),
  exportTemplateInEditorBtn: document.querySelector('#exportTemplateInEditorBtn'),
  saveTemplateBtn: document.querySelector('#saveTemplateBtn'),
  deleteTemplateBtn: document.querySelector('#deleteTemplateBtn'),
  resetTemplateBtn: document.querySelector('#resetTemplateBtn'),
  addDimensionBtn: document.querySelector('#addDimensionBtn'),
  // 表格生成（在新增模板弹窗 Tab 3 内）
  tableFileInput: document.querySelector('#tableFileInput'),
  tableTextInput: document.querySelector('#tableTextInput'),
  tableToTemplateApiKey: document.querySelector('#tableToTemplateApiKey'),
  tableToTemplateProvider: document.querySelector('#tableToTemplateProvider'),
  tableToTemplateModel: document.querySelector('#tableToTemplateModel'),
  parseTableBtn: document.querySelector('#parseTableBtn'),
  parseTableStatus: document.querySelector('#parseTableStatus'),
  // 分析创建
  appSelectWrapper: document.querySelector('#appSelectWrapper'),
  appSelectTrigger: document.querySelector('#appSelectTrigger'),
  appSelectDropdown: document.querySelector('#appSelectDropdown'),
  analysisTemplateSelect: document.querySelector('#analysisTemplateSelect'),
  confidenceThreshold: document.querySelector('#confidenceThreshold'),
  apiKeyInput: document.querySelector('#apiKeyInput'),
  toggleAdvancedBtn: document.querySelector('#toggleAdvancedBtn'),
  advancedSettings: document.querySelector('#advancedSettings'),
  providerSelect: document.querySelector('#providerSelect'),
  modelSelect: document.querySelector('#modelSelect'),
  customProviderConfig: document.querySelector('#customProviderConfig'),
  customApiBaseInput: document.querySelector('#customApiBaseInput'),
  customModelInput: document.querySelector('#customModelInput'),
  temperatureInput: document.querySelector('#temperatureInput'),
  maxTokensInput: document.querySelector('#maxTokensInput'),
  parallelTasksInput: document.querySelector('#parallelTasksInput'),
  maxReviewsPerBatchInput: document.querySelector('#maxReviewsPerBatchInput'),
  userPromptInput: document.querySelector('#userPromptInput'),
  promptVersionSelect: document.querySelector('#promptVersionSelect'),
  managePromptsBtn: document.querySelector('#managePromptsBtn'),
  promptManagerModal: document.querySelector('#promptManagerModal'),
  promptManagerCloseBtn: document.querySelector('#promptManagerCloseBtn'),
  promptVersionList: document.querySelector('#promptVersionList'),
  promptManagerEditor: document.querySelector('#promptManagerEditor'),
  newPromptVersionBtn: document.querySelector('#newPromptVersionBtn'),
  startAnalysisBtn: document.querySelector('#startAnalysisBtn'),
  // 自定义上传
  dataSourceTabs: document.querySelector('#dataSourceTabs'),
  downloadedSourcePanel: document.querySelector('#downloadedSourcePanel'),
  customSourcePanel: document.querySelector('#customSourcePanel'),
  customAppName: document.querySelector('#customAppName'),
  customCsvFileInput: document.querySelector('#customCsvFileInput'),
  customCsvInfo: document.querySelector('#customCsvInfo'),
  // 分析任务列表
  templatesSection: document.querySelector('#templatesSection'),
  analysisSection: document.querySelector('#analysisSection'),
  analysisJobsSection: document.querySelector('#analysisJobsSection'),
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
  listClusterBtn: document.querySelector('#listClusterBtn'),
  filterDimension: document.querySelector('#filterDimension'),
  filterTag: document.querySelector('#filterTag'),
  filterConfidence: document.querySelector('#filterConfidence'),
  filterPolarity: document.querySelector('#filterPolarity'),
  filterHasNote: document.querySelector('#filterHasNote'),
  filterLevel3: document.querySelector('#filterLevel3'),
  filterLevel3Label: document.querySelector('#filterLevel3Label'),
  classifiedTable: document.querySelector('#classifiedTable'),
  lowConfidenceTable: document.querySelector('#lowConfidenceTable'),
  lowConfidenceSummary: document.querySelector('#lowConfidenceSummary'),
  lowConfBadge: document.querySelector('#lowConfBadge'),
  lowConfBatchBar: document.querySelector('#lowConfBatchBar'),
  lowConfSelectAll: document.querySelector('#lowConfSelectAll'),
  lowConfSelectedCount: document.querySelector('#lowConfSelectedCount'),
  batchDeleteTagsBtn: document.querySelector('#batchDeleteTagsBtn'),
  batchAddTagBtn: document.querySelector('#batchAddTagBtn'),
  batchReclassifyBtn: document.querySelector('#batchReclassifyBtn'),
  batchClearSelectionBtn: document.querySelector('#batchClearSelectionBtn'),
  classifiedBatchBar: document.querySelector('#classifiedBatchBar'),
  classifiedSelectAll: document.querySelector('#classifiedSelectAll'),
  classifiedSelectedCount: document.querySelector('#classifiedSelectedCount'),
  classifiedBatchDeleteBtn: document.querySelector('#classifiedBatchDeleteBtn'),
  classifiedBatchAddTagBtn: document.querySelector('#classifiedBatchAddTagBtn'),
  classifiedClearSelectionBtn: document.querySelector('#classifiedClearSelectionBtn'),
  batchDeleteTagsModal: document.querySelector('#batchDeleteTagsModal'),
  batchDeleteTagsClose: document.querySelector('#batchDeleteTagsClose'),
  batchDeleteTagsList: document.querySelector('#batchDeleteTagsList'),
  batchDeleteSelectAllTags: document.querySelector('#batchDeleteSelectAllTags'),
  batchDeleteConfirmBtn: document.querySelector('#batchDeleteConfirmBtn'),
  batchDeleteCancelBtn: document.querySelector('#batchDeleteCancelBtn'),
  reclassifyModal: document.querySelector('#reclassifyModal'),
  reclassifyModalClose: document.querySelector('#reclassifyModalClose'),
  reclassifyReviewText: document.querySelector('#reclassifyReviewText'),
  reclassifyResult: document.querySelector('#reclassifyResult'),
  reclassifyActions: document.querySelector('#reclassifyActions'),
  resultsTabs: document.querySelector('#resultsTabs'),
  backToJobsBtn: document.querySelector('#backToJobsBtn'),
  exportResultsBtn: document.querySelector('#exportResultsBtn'),
  // 编辑模式 + Prompt 优化
  editToggleBtn: document.querySelector('#editToggleBtn'),
  promptOptimizeBtn: document.querySelector('#promptOptimizeBtn'),
  promptOptimizeModal: document.querySelector('#promptOptimizeModal'),
  promptOptimizeClose: document.querySelector('#promptOptimizeClose'),
  promptOptimizeContent: document.querySelector('#promptOptimizeContent'),
  // 翻译
  translateBtn: document.querySelector('#translateBtn'),
  translateModal: document.querySelector('#translateModal'),
  translateModalClose: document.querySelector('#translateModalClose'),
  translateProviderSelect: document.querySelector('#translateProviderSelect'),
  translateModelSelect: document.querySelector('#translateModelSelect'),
  translateCustomConfig: document.querySelector('#translateCustomConfig'),
  translateCustomApiBase: document.querySelector('#translateCustomApiBase'),
  translateCustomModel: document.querySelector('#translateCustomModel'),
  translateApiKey: document.querySelector('#translateApiKey'),
  translateTargetLang: document.querySelector('#translateTargetLang'),
  translateTemperature: document.querySelector('#translateTemperature'),
  translateParallelTasks: document.querySelector('#translateParallelTasks'),
  translateBatchSize: document.querySelector('#translateBatchSize'),
  translateScope: document.querySelector('#translateScope'),
  translateSystemPrompt: document.querySelector('#translateSystemPrompt'),
  startTranslateBtn: document.querySelector('#startTranslateBtn'),
  translateProgress: document.querySelector('#translateProgress')
};

init();

// 批量标记全部待确认评论为无意义（由待确认列表按钮 onclick 调用）
window._batchMarkMeaningless = async function () {
  const reviews = state.currentResults?.reviews || [];
  const lowConf = reviews.filter((r) => r.isLowConfidence);
  if (!window.confirm(`确定要将全部 ${lowConf.length} 条待确认评论标记为"无意义"吗？此操作不可撤销。`)) return;

  const reviewIds = lowConf.map((r) => r.reviewId);
  state._selectedLowConfIds.clear();
  const btn = els.lowConfidenceSummary.querySelector('.batch-meaningless-btn');
  const originalText = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = '标记中...'; }

  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/low-confidence/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewIds,
        dimensionId: '_meaningless', tagId: '_meaningless',
        dimensionName: '无意义', tagName: '无意义'
      })
    });

    const idSet = new Set(reviewIds);
    for (const review of reviews) {
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
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
};

async function init() {
  bindEvents();
  showRuntimeNoticeIfNeeded();

  try {
    await Promise.all([
      loadTemplates(),
      loadDownloadJobs(),
      loadPromptVersions(),
      loadProviders()
    ]);
    await loadAnalyses();
    startPolling();

    // 如果 URL 带有 analysisId，自动加载对应结果
    var initParams = new URLSearchParams(window.location.search);
    var autoAnalysisId = initParams.get('analysisId');
    if (autoAnalysisId) {
      try {
        await viewResults(autoAnalysisId);
      } catch (_) {
        // 分析可能已被删除，忽略错误
      }
    }
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

  els.createTemplateBtn.addEventListener('click', openCreateTemplateModal);
  els.closeTemplateEditor.addEventListener('click', closeTemplateEditorFn);
  els.exportTemplateInEditorBtn.addEventListener('click', exportCurrentTemplate);
  els.saveTemplateBtn.addEventListener('click', saveTemplate);
  els.deleteTemplateBtn.addEventListener('click', deleteTemplate);
  els.resetTemplateBtn.addEventListener('click', resetTemplate);
  els.addDimensionBtn.addEventListener('click', addDimensionToEditor);

  // 新增模板弹窗事件
  els.createTemplateClose.addEventListener('click', closeCreateTemplateModal);
  els.createTemplateModal.addEventListener('click', (e) => {
    if (e.target === els.createTemplateModal) closeCreateTemplateModal();
  });
  els.createTemplateTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.results-tab');
    if (!tab) return;
    const tabName = tab.dataset.tab;
    els.createTemplateTabs.querySelectorAll('.results-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    els.createTemplateModal.querySelectorAll('.results-tab-panel').forEach(p => p.hidden = true);
    const panel = els.createTemplateModal.querySelector(`#tab-${tabName}`);
    if (panel) panel.hidden = false;
  });
  els.createBlankBtn.addEventListener('click', () => {
    const name = els.manualTemplateName.value.trim();
    if (!name) { window.alert('请输入模板名称。'); return; }
    closeCreateTemplateModal();
    openTemplateEditor({ name, category: '', description: '', dimensions: [] });
  });
  els.importJsonBtn.addEventListener('click', handleImportJsonFromModal);
  els.tableFileInput.addEventListener('change', handleTableFileUpload);
  els.tableToTemplateProvider.addEventListener('change', onTableProviderChange);
  els.parseTableBtn.addEventListener('click', submitTableParse);

  els.startAnalysisBtn.addEventListener('click', submitAnalysis);

  // 数据源切换
  els.dataSourceTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.results-tab');
    if (!tab) return;
    const source = tab.dataset.source;
    els.dataSourceTabs.querySelectorAll('.results-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    els.downloadedSourcePanel.hidden = source !== 'downloaded';
    els.customSourcePanel.hidden = source !== 'custom';
    if (source === 'custom') {
      state._selectedJobIds = null;
      if (els.appSelectTrigger) els.appSelectTrigger.querySelector('.custom-select-placeholder').textContent = '-- 选择已下载的 App --';
    } else {
      els.customCsvFileInput.value = '';
      els.customCsvInfo.hidden = true;
    }
  });

  // 自定义上传：文件选中后快速统计行数
  els.customCsvFileInput.addEventListener('change', () => {
    const file = els.customCsvFileInput.files[0];
    if (!file) { els.customCsvInfo.hidden = true; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const lines = text.split('\n').filter(l => l.trim());
      const count = Math.max(0, lines.length - 1); // 减去表头
      els.customCsvInfo.textContent = `已识别 ${count} 条评论（${lines.length} 行含表头）`;
      els.customCsvInfo.hidden = false;
    };
    reader.onerror = () => { els.customCsvInfo.hidden = true; };
    reader.readAsText(file);
  });

  els.managePromptsBtn.addEventListener('click', openPromptManager);
  els.promptManagerCloseBtn.addEventListener('click', closePromptManager);
  els.newPromptVersionBtn.addEventListener('click', handleNewPromptVersion);
  els.promptManagerModal.addEventListener('click', (e) => { if (e.target === els.promptManagerModal) closePromptManager(); });
  els.toggleAdvancedBtn.addEventListener('click', toggleAdvancedSettings);
  els.analysisTemplateSelect.addEventListener('change', updateDefaultPrompts);
  els.providerSelect.addEventListener('change', onProviderChange);

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
  els.filterLevel3.addEventListener('change', renderFilteredReviews);
  els.filterPolaritySummary.addEventListener('change', renderDimensionStats);
  els.polaritySortBtn.addEventListener('click', showPolaritySortModal);
  els.polaritySortClose.addEventListener('click', () => { els.polaritySortModal.hidden = true; });
  els.polaritySortModal.addEventListener('click', (e) => { if (e.target === els.polaritySortModal) els.polaritySortModal.hidden = true; });
  els.listClusterBtn.addEventListener('click', showListClusterModal);

  // 监听 list-cluster 页面发来的导航请求（跨标签页跳转到已分类 Tab 并设置筛选）
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type !== 'listClusterNavigate') return;
    const { dimId, tagId } = e.data;
    els.filterDimension.value = dimId || '';
    populateFilterTag(dimId);
    setTimeout(() => { els.filterTag.value = `${dimId}::${tagId}`; renderFilteredReviews(); }, 50);
    switchResultsTab('classified');
  });

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

  // 批量操作栏事件
  els.lowConfSelectAll.addEventListener('change', () => {
    const checked = els.lowConfSelectAll.checked;
    els.lowConfidenceTable.querySelectorAll('.low-conf-checkbox').forEach((cb) => {
      cb.checked = checked;
      const rid = cb.dataset.reviewId;
      if (checked) state._selectedLowConfIds.add(rid);
      else state._selectedLowConfIds.delete(rid);
    });
    updateBatchBar();
  });
  els.batchClearSelectionBtn.addEventListener('click', clearLowConfSelection);
  els.batchDeleteTagsBtn.addEventListener('click', batchDeleteTags);
  els.batchAddTagBtn.addEventListener('click', () => {
    showBatchAddForm('lowConf');
  });
  els.batchReclassifyBtn.addEventListener('click', batchReclassify);

  // 已分类批量操作栏事件（事件委托 + 全选）
  els.classifiedTable.addEventListener('change', (event) => {
    const cb = event.target.closest('.classified-checkbox');
    if (!cb) return;
    const rid = cb.dataset.reviewId;
    if (cb.checked) state._selectedClassifiedIds.add(rid);
    else state._selectedClassifiedIds.delete(rid);
    updateClassifiedBatchBar();
  });
  els.classifiedSelectAll.addEventListener('change', () => {
    const checked = els.classifiedSelectAll.checked;
    els.classifiedTable.querySelectorAll('.classified-checkbox').forEach((cb) => {
      cb.checked = checked;
      const rid = cb.dataset.reviewId;
      if (checked) state._selectedClassifiedIds.add(rid);
      else state._selectedClassifiedIds.delete(rid);
    });
    updateClassifiedBatchBar();
  });
  els.classifiedClearSelectionBtn.addEventListener('click', clearClassifiedSelection);
  els.classifiedBatchDeleteBtn.addEventListener('click', batchDeleteClassifiedTags);
  els.classifiedBatchAddTagBtn.addEventListener('click', () => {
    showBatchAddForm('classified');
  });

  // 批量删除标签弹窗事件
  els.batchDeleteTagsClose.addEventListener('click', () => { els.batchDeleteTagsModal.hidden = true; });
  els.batchDeleteCancelBtn.addEventListener('click', () => { els.batchDeleteTagsModal.hidden = true; });
  els.batchDeleteSelectAllTags.addEventListener('change', onBatchDeleteSelectAllChange);
  els.batchDeleteConfirmBtn.addEventListener('click', () => {
    const modal = els.batchDeleteTagsModal;
    const allTags = modal._allTags || [];
    const reviewIds = modal._reviewIds || [];
    const context = modal._context || 'lowConf';
    const checkboxes = els.batchDeleteTagsList.querySelectorAll('.batch-delete-tag-checkbox');
    const selectedTags = [];
    checkboxes.forEach((cb) => {
      if (cb.checked) {
        const idx = parseInt(cb.dataset.index, 10);
        if (idx >= 0 && idx < allTags.length) {
          selectedTags.push({ dimensionId: allTags[idx].dimensionId, tagId: allTags[idx].tagId });
        }
      }
    });
    if (selectedTags.length === 0) {
      window.alert('请至少选择一个标签。');
      return;
    }
    executeBatchDelete(reviewIds, context, selectedTags);
  });

  // AI 重分类弹窗关闭
  els.reclassifyModalClose.addEventListener('click', () => { els.reclassifyModal.hidden = true; });

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

  // 翻译弹窗事件
  els.translateBtn.addEventListener('click', openTranslateModal);
  els.translateModalClose.addEventListener('click', closeTranslateModal);
  els.translateModal.addEventListener('click', (e) => { if (e.target === els.translateModal) closeTranslateModal(); });
  els.translateProviderSelect.addEventListener('change', onTranslateProviderChange);
  els.startTranslateBtn.addEventListener('click', startTranslation);

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
  if (templateId && typeof templateId === 'object') {
    // 直接使用传入的模板数据（预填）
    state.currentTemplate = {
      id: null,
      name: templateId.name || '',
      category: templateId.category || '',
      description: templateId.description || '',
      isBuiltIn: false,
      dimensions: (templateId.dimensions || []).map((dim, di) => ({
        id: dim.id || `d${di + 1}`,
        name: dim.name || '',
        productMeaning: dim.productMeaning || '',
        tags: (dim.tags || []).map((tag, ti) => ({
          id: tag.id || `d${di + 1}t${ti + 1}`,
          name: tag.name || '',

          productMeaning: tag.productMeaning || ''
        }))
      }))
    };
    els.templateEditorTitle.textContent = '新建模板';
    els.deleteTemplateBtn.style.display = 'none';
    els.resetTemplateBtn.style.display = 'none';
    els.saveTemplateBtn.textContent = '保存模板';
  } else if (templateId) {
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

// 导出模板：获取完整 JSON 并触发浏览器下载。
async function exportTemplate(templateId) {
  try {
    const data = await fetchJson(`/api/templates/${encodeURIComponent(templateId)}`);
    if (!data || !data.template) throw new Error('模板数据为空。');
    const tpl = data.template;
    // 导出时剥离内部字段，只保留模板定义
    const exported = {
      name: tpl.name || '',
      category: tpl.category || '',
      description: tpl.description || '',
      dimensions: (tpl.dimensions || []).map((dim) => ({
        name: dim.name || '',
        productMeaning: dim.productMeaning || '',
        tags: (dim.tags || []).map((tag) => ({
          name: tag.name || '',
  
          productMeaning: tag.productMeaning || ''
        }))
      }))
    };
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = exported.name.replace(/[<>:"/\\|?*]/g, '_') || 'template';
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(`导出模板失败：${error.message}`);
  }
}

// 从弹窗 Tab 2 导入 JSON：读取文件，打开模板编辑器预览确认。
async function handleImportJsonFromModal() {
  const file = els.importTemplateFileInput.files[0];
  if (!file) { window.alert('请选择 JSON 文件。'); return; }
  try {
    const text = await file.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('文件不是有效的 JSON 格式。');
    }
    if (!json.name || !Array.isArray(json.dimensions) || json.dimensions.length === 0) {
      throw new Error('模板必须有名称（name）和至少一个维度（dimensions）。');
    }
    closeCreateTemplateModal();
    openTemplateEditor(json);
  } catch (error) {
    window.alert(`导入模板失败：${error.message}`);
  } finally {
    els.importTemplateFileInput.value = '';
  }
}

// ===== 表格生成模板 =====

function openCreateTemplateModal() {
  // 预填 API Key
  try {
    const savedKey = localStorage.getItem('tzweb_api_key');
    if (savedKey) els.tableToTemplateApiKey.value = savedKey;
  } catch {}

  // 填充提供商下拉（Tab 3 用）
  const providers = state.providers || [];
  els.tableToTemplateProvider.innerHTML = providers.map((p) =>
    `<option value="${escapeAttr(p.id)}" ${p.id === (state.defaultProvider || 'deepseek') ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');
  onTableProviderChange();

  // 重置为 Tab 1
  els.createTemplateTabs.querySelectorAll('.results-tab').forEach(t => t.classList.remove('active'));
  const firstTab = els.createTemplateTabs.querySelector('[data-tab="manual"]');
  if (firstTab) firstTab.classList.add('active');
  els.createTemplateModal.querySelectorAll('.results-tab-panel').forEach(p => p.hidden = true);
  const manualPanel = els.createTemplateModal.querySelector('#tab-manual');
  if (manualPanel) manualPanel.hidden = false;

  els.manualTemplateName.value = '';
  els.tableTextInput.value = '';
  els.tableFileInput.value = '';
  els.importTemplateFileInput.value = '';
  els.parseTableStatus.hidden = true;

  els.createTemplateModal.hidden = false;
}

function closeCreateTemplateModal() {
  els.createTemplateModal.hidden = true;
}

function onTableProviderChange() {
  const providerId = els.tableToTemplateProvider.value;
  const providers = state.providers || [];
  const provider = providers.find((p) => p.id === providerId);
  if (provider && !provider.custom) {
    els.tableToTemplateModel.innerHTML = (provider.models || []).map((m) =>
      `<option value="${escapeAttr(m.id)}">${escapeHtml(m.name)}</option>`
    ).join('');
  } else {
    els.tableToTemplateModel.innerHTML = '<option value="">请选择模型</option>';
  }
}

async function handleTableFileUpload() {
  const file = els.tableFileInput.files[0];
  if (!file) return;

  els.parseTableStatus.hidden = false;
  els.parseTableStatus.textContent = '正在读取文件...';

  try {
    if (file.name.endsWith('.csv')) {
      const text = await file.text();
      els.tableTextInput.value = text;
      els.parseTableStatus.textContent = `已读取 CSV 文件：${text.split('\n').length} 行。`;
    } else if (file.name.endsWith('.xlsx')) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let base64 = '';
      for (let i = 0; i < bytes.length; i++) {
        base64 += String.fromCharCode(bytes[i]);
      }
      base64 = btoa(base64);
      const data = await fetchJson('/api/templates/parse-xlsx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64: base64, fileName: file.name })
      });
      els.tableTextInput.value = data.tableText || '';
      els.parseTableStatus.textContent = `已读取 Excel 文件：${(data.tableText || '').split('\n').length} 行。`;
    } else {
      throw new Error('不支持的文件格式，请上传 .xlsx 或 .csv 文件。');
    }
  } catch (error) {
    window.alert(`读取文件失败：${error.message}`);
    els.parseTableStatus.hidden = true;
  }
}

async function submitTableParse() {
  const tableText = els.tableTextInput.value.trim();
  if (!tableText) {
    window.alert('请粘贴表格内容或上传文件。');
    return;
  }

  const apiKey = els.tableToTemplateApiKey.value.trim();
  if (!apiKey) {
    window.alert('请输入 API Key。');
    return;
  }
  try { localStorage.setItem('tzweb_api_key', apiKey); } catch {}

  const providerId = els.tableToTemplateProvider.value;

  els.parseTableBtn.disabled = true;
  els.parseTableBtn.textContent = 'AI 正在解析表格...';
  els.parseTableStatus.hidden = false;
  els.parseTableStatus.innerHTML = '<div class="progress-track" style="width:100%;margin-bottom:6px;"><div class="progress-fill" style="width:0%"></div></div><div class="muted">正在提交任务...</div>';

  try {
    // 提交异步任务
    const submitData = await fetchJson('/api/templates/parse-table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableText,
        providerId,
        apiKey,
        model: els.tableToTemplateModel.value
      })
    });

    if (!submitData.taskId) throw new Error('服务器未返回任务 ID。');

    // 轮询进度
    const taskId = submitData.taskId;
    const pollInterval = 1500;
    const maxPolls = 120; // 最多等 3 分钟
    let polls = 0;

    const finalStatus = await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        polls += 1;
        try {
          const status = await fetchJson(`/api/templates/parse-table/${encodeURIComponent(taskId)}?t=${Date.now()}`);
          const pct = status.progress || 0;
          const step = status.currentStep || '处理中...';
          els.parseTableStatus.innerHTML = `<div class="progress-track" style="width:100%;margin-bottom:6px;"><div class="progress-fill" style="width:${pct}%"></div></div><div class="muted">${pct}% ${escapeHtml(step)}</div>`;

          if (status.status === 'completed') {
            clearInterval(poll);
            resolve(status);
          } else if (status.status === 'failed') {
            clearInterval(poll);
            reject(new Error(status.error || 'AI 解析失败'));
          } else if (polls >= maxPolls) {
            clearInterval(poll);
            reject(new Error('AI 解析超时，请重试。'));
          }
        } catch (error) {
          clearInterval(poll);
          reject(error);
        }
      }, pollInterval);
    });

    if (!finalStatus.template) throw new Error('AI 未返回有效模板。');

    closeCreateTemplateModal();
    openTemplateEditor(finalStatus.template);

  } catch (error) {
    window.alert(`AI 解析表格失败：${error.message}`);
  } finally {
    els.parseTableBtn.disabled = false;
    els.parseTableBtn.textContent = 'AI 解析生成模板';
    els.parseTableStatus.hidden = true;
  }
}

function closeTemplateEditorFn() {
  els.templateEditor.hidden = true;
  state.currentTemplate = null;
}

// 导出当前编辑器中的模板为 JSON 文件。
function exportCurrentTemplate() {
  const tpl = state.currentTemplate;
  if (!tpl) {
    window.alert('没有可导出的模板数据。');
    return;
  }
  const exported = {
    name: tpl.name || '',
    category: tpl.category || '',
    description: tpl.description || '',
    dimensions: (tpl.dimensions || []).map((dim) => ({
      name: dim.name || '',
      productMeaning: dim.productMeaning || '',
      tags: (dim.tags || []).map((tag) => ({
        name: tag.name || '',

        productMeaning: tag.productMeaning || ''
      }))
    }))
  };
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (exported.name || 'template').replace(/[<>:"/\\|?*]/g, '_');
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

// 加载 AI 提供商列表，填充下拉框。
async function loadProviders() {
  try {
    const data = await fetchJson('/api/providers');
    state.providers = data.providers || [];
    state.defaultProvider = data.default || 'deepseek';
    renderProviderSelect();
  } catch {
    els.providerSelect.innerHTML = '<option value="">无法加载提供商列表</option>';
  }
}

function renderProviderSelect() {
  const providers = state.providers || [];
  els.providerSelect.innerHTML = providers.map((p) =>
    `<option value="${escapeAttr(p.id)}" ${p.id === state.defaultProvider ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');
  onProviderChange();
}

function onProviderChange() {
  const providerId = els.providerSelect.value;
  const providers = state.providers || [];
  const provider = providers.find((p) => p.id === providerId);

  if (provider?.custom) {
    els.customProviderConfig.style.display = 'block';
    els.modelSelect.innerHTML = '<option value="">请填写模型 ID</option>';
    els.modelSelect.disabled = true;
  } else {
    els.customProviderConfig.style.display = 'none';
    els.modelSelect.disabled = false;
    els.modelSelect.innerHTML = (provider?.models || []).map((m) =>
      `<option value="${escapeAttr(m.id)}">${escapeHtml(m.name)}</option>`
    ).join('');
    // 默认选中第一个模型
    if (provider?.models?.length > 0) {
      els.modelSelect.value = provider.models[0].id;
    }
  }
}

// 将指定版本的 prompt 模板填入 textarea。
// dimensionsDesc 从 state._currentDimensionsDesc 读取。
async function applyPromptVersion(version) {
  // 版本已在 promptVersionSelect 中跟踪，提交分析时直接使用
  // 不再需要填充 textarea（System Prompt textarea 已移除）
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
  // 过滤掉无意义的标签：id 为空或 name 为空的标签不传给 AI
  const dims = tpl.dimensions || [];
  const dimensionsDesc = dims.map((dim) => {
    const validTags = (dim.tags || []).filter((tag) => tag.id && tag.name);
    if (validTags.length === 0) return '';
    const tagsDesc = validTags.map((tag) => {
      const meaning = tag.productMeaning ? ` — ${tag.productMeaning}` : '';
      return `  "${tag.name}"${meaning}`;
    }).join('\n');
    return `- ${dim.name}（${dim.productMeaning || ''}）：\n${tagsDesc}`;
  }).filter(Boolean).join('\n');

  // 缓存维度描述和模板模式，供版本切换时复用
  state._currentDimensionsDesc = dimensionsDesc;


  els.userPromptInput.value = `以下是需要分类的 __BATCH_SIZE__ 条评论（每条包含 index、starRating 和 text）：

__REVIEWS_JSON__

请输出分类结果 JSON 数组：`;


}

// ===== 分析任务创建 =====

// 判断当前选中的数据源
function getActiveDataSource() {
  const tab = els.dataSourceTabs?.querySelector('.results-tab.active');
  return tab ? tab.dataset.source : 'downloaded';
}

// 读取文件为 base64 字符串
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      // 去掉 data:...;base64, 前缀
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('文件读取失败。'));
    reader.readAsDataURL(file);
  });
}

async function submitAnalysis() {
  const dataSource = getActiveDataSource();

  if (dataSource === 'downloaded') {
    const jobIdsJson = state._selectedJobIds;
    if (!jobIdsJson) {
      window.alert('请先选择已下载的目标 App。');
      return;
    }
    var downloadJobIds = JSON.parse(jobIdsJson);
  } else {
    const appName = els.customAppName.value.trim();
    if (!appName) {
      window.alert('请输入 App 名称。');
      return;
    }
    const file = els.customCsvFileInput.files[0];
    if (!file) {
      window.alert('请上传评论 CSV 文件。');
      return;
    }
    var customAppName = appName;
  }

  const templateId = els.analysisTemplateSelect.value;
  if (!templateId) {
    window.alert('请选择分析模板。');
    return;
  }

  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    window.alert('请输入 API Key。');
    return;
  }
  // 记住上次使用的 API Key
  try { localStorage.setItem('tzweb_api_key', apiKey); } catch {}

  const originalText = els.startAnalysisBtn.textContent;
  els.startAnalysisBtn.disabled = true;
  els.startAnalysisBtn.textContent = '正在创建任务...';

  try {
    const providerId = els.providerSelect.value || 'deepseek';
    const providers = state.providers || [];
    const provider = providers.find((p) => p.id === providerId);
    const model = provider?.custom ? (els.customModelInput.value || '') : els.modelSelect.value;

    const payload = {
      templateId,
      apiKey,
      providerId,
      model,
      confidenceThreshold: parseFloat(els.confidenceThreshold.value),
      parallelTasks: parseInt(els.parallelTasksInput.value, 10) || 20,
      maxReviewsPerBatch: parseInt(els.maxReviewsPerBatchInput.value, 10) || 0,
      temperature: !isNaN(parseFloat(els.temperatureInput.value)) ? parseFloat(els.temperatureInput.value) : undefined,
      maxTokens: parseInt(els.maxTokensInput.value, 10) || 8192,
      userPromptTemplate: els.userPromptInput.value.trim() || undefined,
      promptVersion: els.promptVersionSelect.value || undefined
    };

    if (dataSource === 'custom') {
      const file = els.customCsvFileInput.files[0];
      payload.customCsvBase64 = await readFileAsBase64(file);
      payload.customAppName = customAppName;
    } else {
      payload.downloadJobIds = downloadJobIds;
    }

    // 自定义提供商时传递 API 端点
    if (provider?.custom && els.customApiBaseInput.value) {
      payload.customApiBase = els.customApiBaseInput.value.trim();
    }

    const data = await fetchJson('/api/analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // 分析任务创建成功，立即加入列表顶部
    state.analyses.unshift(data.analysis);
    renderAnalyses();
    // 自定义上传成功后清空文件选择
    if (dataSource === 'custom') {
      els.customCsvFileInput.value = '';
      els.customCsvInfo.hidden = true;
    }
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
  const model = config.model || '';
  const pv = config.promptVersion ? ` · Prompt v${escapeHtml(config.promptVersion)}` : '';
  const providerId = config.providerId;
  let providerName = '';
  if (providerId && state.providers) {
    const p = state.providers.find((x) => x.id === providerId);
    providerName = p ? p.name : providerId;
  }
  const providerStr = providerName ? `${escapeHtml(providerName)} · ` : '';
  const batchInfo = config.maxReviewsPerBatch > 0 ? ` · 单次${config.maxReviewsPerBatch}条` : '';
  return `${providerStr}${escapeHtml(model)} · ${config.parallelTasks || 20} 并行${batchInfo} · 阈值 ${config.confidenceThreshold || 0.6}${pv}`;
}

// ===== 翻译功能 =====

const DEFAULT_TRANSLATE_PROMPT = `你是一个专业的 APP 用户评论翻译助手。请将以下用户评论翻译成目标语言。

要求：
1. 保持原文的语气、情感和风格
2. 俚语和口语化表达应翻译为目标语言中对应的自然表达
3. 只输出翻译后的文本，不要添加任何解释或注释
4. 如果原文已经是目标语言，则原样输出`;

function openTranslateModal() {
  // 预填 API Key（复用分析任务中的 Key）
  const currentAnalysis = findCurrentAnalysisJob();
  els.translateApiKey.value = currentAnalysis?.apiKey || currentAnalysis?.deepseekApiKey || '';

  // 填充提供商下拉
  const providers = state.providers || [];
  els.translateProviderSelect.innerHTML = providers.map((p) =>
    `<option value="${escapeAttr(p.id)}" ${p.id === (state.defaultProvider || 'deepseek') ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
  ).join('');
  els.translateCustomConfig.style.display = 'none';
  onTranslateProviderChange();

  // 预填默认翻译 prompt
  if (!els.translateSystemPrompt.value) {
    els.translateSystemPrompt.value = DEFAULT_TRANSLATE_PROMPT;
  }

  // 重置进度
  els.translateProgress.hidden = true;
  els.translateProgress.textContent = '';
  els.startTranslateBtn.disabled = false;

  els.translateModal.hidden = false;
}

function closeTranslateModal() {
  els.translateModal.hidden = true;
}

function onTranslateProviderChange() {
  const providerId = els.translateProviderSelect.value;
  const providers = state.providers || [];
  const provider = providers.find((p) => p.id === providerId);

  if (provider?.custom) {
    els.translateCustomConfig.style.display = 'block';
    els.translateModelSelect.innerHTML = '<option value="">请填写模型 ID</option>';
    els.translateModelSelect.disabled = true;
  } else {
    els.translateCustomConfig.style.display = 'none';
    els.translateModelSelect.disabled = false;
    els.translateModelSelect.innerHTML = (provider?.models || []).map((m) =>
      `<option value="${escapeAttr(m.id)}">${escapeHtml(m.name)}</option>`
    ).join('');
    if (provider?.models?.length > 0) {
      els.translateModelSelect.value = provider.models[0].id;
    }
  }
}

function findCurrentAnalysisJob() {
  const results = state.currentResults;
  if (!results) return null;
  return (state.analyses || []).find((a) => a.id === results.id) || null;
}

async function startTranslation() {
  const apiKey = els.translateApiKey.value.trim();
  if (!apiKey) {
    window.alert('请输入 API Key。');
    return;
  }
  const isCustom = els.translateCustomConfig.style.display === 'block';
  if (!isCustom && !els.translateModelSelect.value) {
    window.alert('请选择 AI 提供商和模型。');
    return;
  }
  if (isCustom && !els.translateCustomModel.value.trim()) {
    window.alert('请填写自定义模型 ID。');
    return;
  }

  const results = state.currentResults;
  if (!results) {
    window.alert('没有可翻译的结果。');
    return;
  }

  els.startTranslateBtn.disabled = true;
  els.translateProgress.hidden = false;
  els.translateProgress.textContent = '翻译中...';

  try {
    const data = await fetchJson(`/api/analysis/${encodeURIComponent(results.id)}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        providerId: els.translateProviderSelect.value,
        model: els.translateCustomConfig.style.display === 'block' ? (els.translateCustomModel.value.trim() || els.translateModelSelect.value) : els.translateModelSelect.value,
        targetLang: els.translateTargetLang.value,
        temperature: parseFloat(els.translateTemperature.value) || 0.1,
        systemPrompt: els.translateSystemPrompt.value.trim() || undefined,
        scope: els.translateScope.value,
        parallelTasks: parseInt(els.translateParallelTasks.value) || 3,
        batchSize: parseInt(els.translateBatchSize.value) || 15,
        customApiBase: els.translateCustomConfig.style.display === 'block' ? els.translateCustomApiBase.value.trim() : undefined
      })
    });

    els.translateProgress.textContent = `完成：${data.translatedCount} / ${data.total} 条已翻译`;
    els.startTranslateBtn.disabled = false;

    // 重新加载结果以获取翻译数据
    await refreshResultsFromServer();
    renderFilteredReviews();
    renderLowConfidence();
  } catch (error) {
    els.translateProgress.textContent = `翻译失败：${error.message}`;
    els.startTranslateBtn.disabled = false;
  }
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
    state._selectedLowConfIds.clear();
    state._selectedClassifiedIds.clear();
    els.editToggleBtn.classList.remove('edit-toggle--active');
    els.editToggleBtn.textContent = '编辑标签';
    if (els.promptOptimizeBtn) els.promptOptimizeBtn.hidden = true;
    els.translateBtn.hidden = false;
    // 作为二级页面：隐藏主列表区，只显示结果
    els.templatesSection.style.display = 'none';
    els.analysisSection.style.display = 'none';
    els.analysisJobsSection.style.display = 'none';
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
    els.filterLevel3.value = '';
    renderFilteredReviews();
    renderLowConfidence();

    // 检查 URL 参数，支持从 list-cluster 页面跳转并预设筛选条件
    var urlParams = new URLSearchParams(window.location.search);
    var presetDimId = urlParams.get('dimId');
    var presetTagId = urlParams.get('tagId');
    if (presetDimId && presetTagId) {
      els.filterDimension.value = presetDimId;
      populateFilterTag(presetDimId);
      setTimeout(function () {
        els.filterTag.value = presetDimId + '::' + presetTagId;
        renderFilteredReviews();
      }, 50);
      switchResultsTab('classified');
      // 清除 URL 参数，避免刷新后重复应用
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      switchResultsTab('summary');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    window.alert(`加载分析结果失败：${error.message}`);
  }
}

function hideResults() {
  els.resultsSection.hidden = true;
  els.templatesSection.style.display = '';
  els.analysisSection.style.display = '';
  els.analysisJobsSection.style.display = '';
  state.currentResults = null;
  state.editMode = false;
  state.editHistory = [];
  state._addingTagForReviewId = null;
  els.editToggleBtn.classList.remove('edit-toggle--active');
  els.editToggleBtn.textContent = '编辑标签';
  if (els.promptOptimizeBtn) els.promptOptimizeBtn.hidden = true;
  els.translateBtn.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 导出当前解析结果为 CSV 文件（每个分类一行，无分类的评论也导出一行）。
function exportResultsCSV() {
  const results = state.currentResults;
  if (!results || !results.reviews) return;

  const template = results.template;
  const allDimensions = template?.dimensions || [];
  const getPolarity = (c) => c.polarity || '';

  const hasTranslation = results.reviews.some((r) => r.translatedText);
  const headers = ['评论内容', '评分', 'App 版本', '评论者', '评论日期', '维度', '标签', '向性', '置信度', '备注', '用户建议', '人工标注', '低置信度'];
  headers.push('3级分类');
  if (hasTranslation) {
    headers.push('翻译');
  }

  const rows = [];
  for (const review of results.reviews) {
    const suggestions = (review.suggestions || []).map((s) => `${s.category || ''}: ${s.description || ''}`).join('；');
    const classifications = review.classifications || [];
    const level3Val = review.level3 || '';
    const translatedVal = review.translatedText || '';

    if (classifications.length === 0) {
      const row = [review.reviewText || '', review.starRating || '', review.appVersion || '', review.reviewerName || '', review.reviewDate || '', '', '', '', '', '', suggestions, '', review.isLowConfidence ? '是' : ''];
      row.push(level3Val);
      if (hasTranslation) row.push(translatedVal);
      rows.push(row);
    } else {
      for (const c of classifications) {
        const row = [
          review.reviewText || '',
          review.starRating || '',
          review.appVersion || '',
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
        ];
        row.push(level3Val);
        if (hasTranslation) row.push(translatedVal);
        rows.push(row);
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

  const getPolarity = (c) => c.polarity || '';

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
      // 统计该标签下各向性的出现次数，取最多的作为代表向性
      let pol = '';
      if (tag.tagId) {
        const polCounts = {};
        for (const review of (state.currentResults?.reviews || [])) {
          if (review.isLowConfidence) continue;
          for (const c of (review.classifications || [])) {
            if (c.tagId === tag.tagId && c.polarity) {
              polCounts[c.polarity] = (polCounts[c.polarity] || 0) + 1;
            }
          }
        }
        let maxCount = 0;
        for (const [p, n] of Object.entries(polCounts)) {
          if (n > maxCount) { maxCount = n; pol = p; }
        }
      }
      const polClass = pol === '正向' ? 'pol-positive' : pol === '负向' ? 'pol-negative' : pol === '需求' ? 'pol-demand' : 'pol-neutral';
      return `<span class="tag-badge" data-dim-id="${escapeAttr(dim.dimensionId)}" data-tag-id="${escapeAttr(tag.tagId || '')}" style="cursor: pointer;">${pol ? `<span class="polarity-tag ${polClass}">${escapeHtml(pol)}</span>` : ''}${escapeHtml(tag.tagName)} (${tag.count})</span>`;
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

  // polarity → Map<dimId::tagId, { dimId, tagId, dimName, tagName, count }>
  const groupMaps = { '正向': new Map(), '负向': new Map(), '需求': new Map(), '中性': new Map(), '未标记': new Map() };

  for (const review of reviews) {
    if (review.isLowConfidence) continue;
    for (const c of (review.classifications || [])) {
      const polarity = c.polarity || '未标记';
      const gm = groupMaps[polarity] || (groupMaps[polarity] = new Map());
      const key = `${c.dimensionId}::${c.tagId}`;
      const entry = gm.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        gm.set(key, { dimId: c.dimensionId, tagId: c.tagId, dimName: c.dimensionName, tagName: c.tagName, count: 1 });
      }
    }
  }

  const order = ['未标记', '负向', '正向', '需求', '中性'];
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

// ── list聚类：按三大类别统计维度·标签 ──────────────────────────────

const CATEGORY_MAP = new Map([
  // 体验类
  ['广告·广告多', '体验类'], ['广告·抱怨广告', '体验类'], ['广告·广告干扰', '体验类'],
  ['图片·效果不好', '体验类'], ['订阅相关·抱怨订阅', '体验类'], ['APP本身·操作复杂', '体验类'],
  ['其他·未明确', '体验类'], ['PDF转Word·格式变了', '体验类'], ['PDF转Word·字体问题', '体验类'],
  ['订阅相关·取消订阅/退款', '体验类'], ['裁剪·自动裁剪不好', '体验类'], ['PDF转Word·页面增加', '体验类'],
  ['订阅相关·订阅价格贵', '体验类'], ['APP本身·要求评分太早', '体验类'], ['PDF转Word·缺少内容', '体验类'],
  ['订阅相关·订阅问题', '体验类'], ['APP本身·不会用', '体验类'], ['APP本身·抱怨评分', '体验类'],
  ['订阅相关·抱怨订阅提示频繁', '体验类'], ['PDF转Word·质量差', '体验类'], ['APP本身·不工作', '体验类'],
  ['广告·广告长', '体验类'], ['裁剪·裁剪难', '体验类'], ['广告·无法关闭广告', '体验类'],
  ['PDF转Word·文本错乱', '体验类'], ['格式转换·转换时error', '体验类'], ['滤镜·AI滤镜不工作', '体验类'],
  ['PDF·文字显示问题', '体验类'], ['图片·图像顺序问题', '体验类'], ['文件管理·不保存', '体验类'],
  ['订阅相关·抱怨试用需提供银行卡', '体验类'], ['格式转换·不转换', '体验类'], ['格式转换·转换后文本不一致', '体验类'],
  ['滤镜·滤镜不好', '体验类'], ['裁剪·裁剪结果与设置的不一致', '体验类'], ['Word转PDF·内容缺失', '体验类'],
  ['Word转PDF·字体被更改', '体验类'], ['其他·隐私', '体验类'], ['PDF转PPT·缺失内容', '体验类'],
  ['图片·导入图片异常', '体验类'], ['文件管理·文件丢失', '体验类'], ['APP本身·打不开', '体验类'],
  ['PDF·白边', '体验类'], ['PDF转PPT·字体改变', '体验类'], ['Reader功能·文件打不开', '体验类'],
  ['APP本身·操作指示', '体验类'], ['APP本身·无法退出', '体验类'], ['Word转PDF·格式问题', '体验类'],
  ['图片·清晰度', '体验类'], ['拍照·拍摄不好', '体验类'], ['订阅相关·找不到免费试用', '体验类'],
  ['PDF·内容未对齐', '体验类'], ['其他·付费', '体验类'], ['文件管理·压缩文件异常', '体验类'],
  ['PDF·白屏', '体验类'], ['其他·病毒问题', '体验类'], ['广告·抱怨广告遮挡导航栏', '体验类'],
  ['PDF·黑图', '体验类'], ['PDF·黑边', '体验类'], ['PDF转PPT·格式移动', '体验类'],
  ['PDF转Word·不是文档格式', '体验类'], ['PDF转Word·书写方向变了', '体验类'], ['Reader功能·PDF打不开', '体验类'],
  ['其他·不是扫描仪', '体验类'], ['文件管理·分享后文件打不开', '体验类'], ['文件管理·抱怨分享时的链接', '体验类'],
  ['PDF转PPT·不清晰', '体验类'], ['PPT转PDF·内容不完整', '体验类'], ['PPT转PDF·字体不一致', '体验类'],
  ['PPT转PDF·格式不一致', '体验类'], ['Reader功能·导入文件异常', '体验类'], ['Reader功能·添加的字体太大', '体验类'],
  ['其他·抱怨cookies', '体验类'], ['其他·文案问题', '体验类'], ['拍照·不会拍照', '体验类'],
  ['拍照·不扫描', '体验类'], ['拍照·拍摄返回问题', '体验类'], ['文件管理·文件大小预估不准', '体验类'],
  ['APP本身·不下载', '体验类'], ['Word转PDF·文本乱', '体验类'], ['Word转PDF·质量下降', '体验类'],
  ['广告·色情广告', '体验类'], ['文件管理·分享后文件变空白', '体验类'], ['文件管理·忘记安全问题答案', '体验类'],
  ['文件管理·未设置密码但被加密', '体验类'],
  // 功能类
  ['文件管理·压缩文件大小', '功能类'], ['编辑/工具·编辑PDF', '功能类'], ['格式转换·其他转PDF', '功能类'],
  ['编辑/工具·OCR', '功能类'], ['编辑/工具·添加文本/书写', '功能类'], ['编辑/工具·编辑文字', '功能类'],
  ['语言/UI·UI', '功能类'], ['文件管理·自定义文件大小', '功能类'], ['编辑/工具·插入图像', '功能类'],
  ['文件管理·找不到文件位置', '功能类'], ['订阅相关·支持一次性购买', '功能类'], ['订阅相关·付费去广告', '功能类'],
  ['文件管理·文件顺序', '功能类'], ['文件管理·文件打印', '功能类'], ['编辑/工具·拼贴', '功能类'],
  ['编辑/工具·编辑的内容未保存', '功能类'], ['编辑/工具·图片编辑', '功能类'], ['编辑/工具·支持复制/粘贴', '功能类'],
  ['文件管理·分享', '功能类'], ['文件管理·恢复文件', '功能类'], ['格式转换·PDF转其他', '功能类'],
  ['裁剪·更多裁剪功能', '功能类'], ['语言/UI·XXX语', '功能类'], ['图片·图像大小', '功能类'],
  ['图片·旋转', '功能类'], ['编辑/工具·PDF合并', '功能类'], ['APP本身·屏幕旋转', '功能类'],
  ['编辑/工具·支持分页', '功能类'], ['编辑/工具·添加字体样式', '功能类'], ['订阅相关·提供更长的试用期', '功能类'],
  ['Reader功能·合并页面', '功能类'], ['拍照·边缘检测', '功能类'], ['编辑/工具·手动调图像参数', '功能类'],
  ['编辑/工具·更换背景', '功能类'], ['编辑/工具·添加自动清理功能', '功能类'], ['编辑/工具·签名', '功能类'],
  ['裁剪·裁剪应用于所有', '功能类'], ['语言/UI·黑色主题', '功能类'], ['APP本身·无法离线使用', '功能类'],
  ['文件管理·下载文件', '功能类'], ['文件管理·权限', '功能类'], ['文件管理·自定义页面大小', '功能类'],
  ['编辑/工具·橡皮擦', '功能类'], ['编辑/工具·翻译', '功能类'], ['APP本身·添加AI', '功能类'],
  ['PDF·旋转PDF', '功能类'], ['PDF·直接创建PDF', '功能类'], ['拍照·自动扫描', '功能类'],
  ['文件管理·多选共享', '功能类'], ['编辑/工具·删除水印', '功能类'], ['编辑/工具·拉直/居中', '功能类'],
  ['编辑/工具·添加水印', '功能类'], ['编辑/工具·添加注释', '功能类'], ['PDF·预览', '功能类'],
  ['Reader功能·重新排序页面', '功能类'], ['文件管理·分享文件链接', '功能类'], ['文件管理·删除文件', '功能类'],
  ['文件管理·密码', '功能类'], ['文件管理·添加页面', '功能类'], ['文件管理·生成摘要', '功能类'],
  ['文件管理·隐藏缩略图', '功能类'], ['文件管理·页面大小', '功能类'], ['格式转换·批量生成单独的文件', '功能类'],
  ['格式转换·转其他格式', '功能类'], ['滤镜·添加更多滤镜', '功能类'], ['编辑/工具·PDF拆分', '功能类'],
  ['编辑/工具·撤销/后退选项', '功能类'], ['编辑/工具·旋转添加的文本', '功能类'], ['编辑/工具·透视校正', '功能类'],
  ['APP本身·横屏模式', '功能类'], ['PDF·缩放', '功能类'], ['PDF·自定义PDF设置', '功能类'],
  ['Reader功能·添加音乐', '功能类'], ['Reader功能·调整页面大小', '功能类'], ['图片·从相册导入图片', '功能类'],
  ['图片·排序时查看全图', '功能类'], ['图片·文件夹导入多张', '功能类'], ['图片·重拍/更换图像', '功能类'],
  ['文件管理·修改文件名称', '功能类'], ['文件管理·删除页面', '功能类'], ['文件管理·按日期搜索文件', '功能类'],
  ['文件管理·文件名支持特殊符号', '功能类'], ['文件管理·文件搜索', '功能类'], ['文件管理·更改存储位置', '功能类'],
  ['文件管理·自动文件命名', '功能类'], ['格式转换·批量转换', '功能类'], ['格式转换·支持后台转换', '功能类'],
  ['滤镜·滤镜应用于所有', '功能类'], ['编辑/工具·reader', '功能类'], ['编辑/工具·制作简历', '功能类'],
  ['编辑/工具·图像分割', '功能类'], ['编辑/工具·批量编辑', '功能类'], ['编辑/工具·文件分类', '功能类'],
  ['编辑/工具·涂鸦时隐藏底部菜单', '功能类'], ['编辑/工具·自定义图片分辨率', '功能类'], ['裁剪·不会自动裁剪', '功能类'],
  ['裁剪·批量裁剪', '功能类'], ['裁剪·更多裁剪形状', '功能类'],
  // 性能类
  ['慢·速度慢（无具体描述）', '性能类'], ['其他·crash & anr', '性能类'], ['其他·卡顿', '性能类'],
  ['PDF转Word·处理速度慢', '性能类'], ['慢·启动慢', '性能类'], ['慢·转换慢', '性能类'],
  ['Word转PDF·转换缓慢', '性能类'], ['APP本身·占用内存太大', '性能类'], ['PDF转PPT·转换速度慢', '性能类'],
  ['慢·文件打开慢', '性能类'], ['慢·裁剪慢', '性能类'], ['慢·旋转慢', '性能类'],
  ['慢·添加新图片慢', '性能类'], ['慢·AI滤镜加载慢', '性能类'], ['慢·下载慢', '性能类'],
  ['慢·分享慢', '性能类'], ['慢·排序慢', '性能类'], ['慢·文件加载慢', '性能类'],
]);

function buildListClusterStats() {
  const reviews = state.currentResults?.reviews || [];
  // category → Map<key, { dimName, tagName, dimId, tagId, count, polarities: {} }>
  const catMaps = new Map();
  const categoryOrder = ['体验类', '功能类', '性能类', '其他'];

  for (const cat of categoryOrder) catMaps.set(cat, new Map());

  for (const review of reviews) {
    if (review.isLowConfidence) continue;
    for (const c of (review.classifications || [])) {
      const dimName = c.dimensionName || '';
      const tagName = c.tagName || '';
      const key = `${dimName}·${tagName}`;
      const category = CATEGORY_MAP.get(key) || '其他';
      const cm = catMaps.get(category);
      let entry = cm.get(key);
      if (!entry) {
        entry = { dimName, tagName, dimId: c.dimensionId, tagId: c.tagId, count: 0, polarities: {} };
        cm.set(key, entry);
      }
      entry.count += 1;
      const pol = c.polarity || '中性';
      entry.polarities[pol] = (entry.polarities[pol] || 0) + 1;
      // 关联原文
      if (!entry._reviews) entry._reviews = [];
      if (entry._reviews.length < 20) {
        entry._reviews.push({
          reviewId: review.reviewId,
          reviewText: review.reviewText || '',
          translatedText: review.translatedText || '',
          starRating: review.starRating || 0,
          level3: review.level3 || null,
          appVersion: review.appVersion || '',
          classifications: review.classifications || [],
          isLowConfidence: review.isLowConfidence
        });
      }
    }
  }

  // 每个类别内按 count 降序排列
  const result = new Map();
  for (const [cat, cm] of catMaps) {
    const entries = [...cm.values()].sort((a, b) => b.count - a.count);
    if (entries.length > 0) result.set(cat, entries);
  }
  return { stats: result, categoryOrder };
}

const POLARITY_LABELS = ['正向', '负向', '中性', '需求'];
const POLARITY_CLASS = { '正向': 'pol-positive', '负向': 'pol-negative', '中性': 'pol-neutral', '需求': 'pol-demand' };

function showListClusterModal() {
  const { stats, categoryOrder } = buildListClusterStats();
  if (stats.size === 0) { alert('暂无已分类数据。'); return; }

  let totalAll = 0;
  let totalClassified = 0;
  for (const entries of stats.values()) {
    totalAll += entries.length;
    totalClassified += entries.reduce((s, e) => s + e.count, 0);
  }

  // 序列化 Map → 普通对象，存入 sessionStorage 供新标签页读取
  const categories = {};
  for (const [cat, entries] of stats) {
    categories[cat] = entries;
  }

  const appName = state.currentResults?.appName || state.currentResults?.template?.name || '';

  sessionStorage.setItem('listClusterData', JSON.stringify({
    categoryOrder,
    totalAll,
    totalClassified,
    categories,
    analysisId: (state.currentResults && state.currentResults.id) || '',
    appName
  }));

  window.open('/list-cluster.html', '_blank');
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
      // 如果已选了维度，只补充该维度下的自定义标签
      if (dimensionId && c.dimensionId !== dimensionId) continue;
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
  // 获取分类的实际向性
  const getPolarity = (c) => c.polarity || '';

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

  // 3级分类筛选
  if (!els.filterLevel3.hidden && els.filterLevel3.value) {
    const l3v = els.filterLevel3.value;
    filtered = l3v === 'null'
      ? filtered.filter((r) => !r.level3)
      : filtered.filter((r) => r.level3 === l3v);
  }

  // 更新编辑按钮文案和状态
  els.editToggleBtn.textContent = state.editMode ? '退出编辑' : '编辑标签';
  els.editToggleBtn.classList.toggle('edit-toggle--active', state.editMode);

  if (filtered.length === 0) {
    els.classifiedTable.innerHTML = '<tr><td colspan="7" class="empty">没有匹配的评论。</td></tr>';
    els.classifiedBatchBar.hidden = true;
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
    const isChecked = state._selectedClassifiedIds.has(r.reviewId);

    return `
    <tr data-review-id="${escapeAttr(r.reviewId)}">
      <td style="width: 32px; text-align: center;"><input type="checkbox" class="classified-checkbox" data-review-id="${escapeAttr(r.reviewId)}" ${isChecked ? 'checked' : ''}></td>
      <td style="max-width: 320px;">
        <div class="review-text-cell">${escapeHtml(r.reviewText || '')}</div>
        ${r.translatedText ? `<div class="translated-text-cell">🌐 ${escapeHtml(r.translatedText)}</div>` : ''}
        ${r.reviewerName ? `<div class="muted" style="margin-top: 4px;">— ${escapeHtml(r.reviewerName)}</div>` : ''}
      </td>
      <td>${'★'.repeat(Math.min(5, r.starRating || 0))}${r.starRating ? ` ${r.starRating}` : ''}</td>
      <td class="muted" style="font-size: 12px;">${escapeHtml(r.appVersion || '-')}</td>
      <td>
        ${r.level3 ? `<span class="level3-badge l3-${r.level3 === 'bug' ? 'bug' : r.level3 === '需求/建议' ? 'suggestion' : r.level3 === '不会操作' ? 'operation' : r.level3 === '吐槽' ? 'rant' : 'unrelated'}">${escapeHtml(r.level3)}</span>` : ''}
        <div class="tag-badges">
          ${(r.classifications || []).map((c) => {
            const isMatch = filterTagRaw && c.dimensionId === filterTagDimId && (c.tagId === filterTagId || c.tagName === filterTagId);
            const polarity = c.polarity || '';
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
              <input class="add-tag-input" data-review-id="${escapeAttr(r.reviewId)}" list="tag-datalist-${escapeAttr(r.reviewId)}" placeholder="搜索或输入新标签" style="height: 28px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; background: var(--paper);">
              <datalist id="tag-datalist-${escapeAttr(r.reviewId)}">
                ${allDimensions.flatMap((dim) => (dim.tags || []).map((tag) => `<option value="${escapeAttr(tag.name)}">${escapeHtml(dim.name)}</option>`)).join('')}
              </datalist>
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

  // 多选复选框事件
  els.classifiedTable.querySelectorAll('.classified-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const rid = cb.dataset.reviewId;
      if (cb.checked) state._selectedClassifiedIds.add(rid);
      else state._selectedClassifiedIds.delete(rid);
      updateClassifiedBatchBar();
    });
  });
  updateClassifiedBatchBar();
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
    // 更新本地状态：有剩余建议或完全没有分类→待确认；否则→已分类
    review.classifications = newClasses;
    const hasSuggestions = newClasses.some((c) => c.suggested);
    if (hasSuggestions || newClasses.length === 0) {
      review.isLowConfidence = true;
    } else {
      const threshold = state.currentResults.summary?.confidenceThreshold || 0.6;
      const hasHighEnough = newClasses.some((c) => c.confidence >= threshold);
      review.isLowConfidence = !hasHighEnough;
    }
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
    // 同步翻译数据（服务端翻译后写回 reviews，前端需拉取最新 translatedText）
    const freshReviews = data.reviews || [];
    const localReviews = state.currentResults.reviews || [];
    for (let i = 0; i < Math.min(localReviews.length, freshReviews.length); i++) {
      if (freshReviews[i].translatedText) {
        localReviews[i].translatedText = freshReviews[i].translatedText;
      }
    }
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
      <p class="muted" style="margin-top: 8px;">调用 AI 分析修正模式并生成 prompt 改进建议</p>
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

// ===== 批量操作辅助函数 =====

function updateBatchBar() {
  const count = state._selectedLowConfIds.size;
  els.lowConfBatchBar.hidden = count === 0;
  els.lowConfSelectedCount.textContent = count;
  // 同步全选复选框状态
  const totalCbs = els.lowConfidenceTable.querySelectorAll('.low-conf-checkbox');
  if (totalCbs.length > 0) {
    els.lowConfSelectAll.checked = count === totalCbs.length;
    els.lowConfSelectAll.indeterminate = count > 0 && count < totalCbs.length;
  }
}

function clearLowConfSelection() {
  state._selectedLowConfIds.clear();
  els.lowConfidenceTable.querySelectorAll('.low-conf-checkbox').forEach((cb) => { cb.checked = false; });
  els.lowConfSelectAll.checked = false;
  els.lowConfSelectAll.indeterminate = false;
  updateBatchBar();
  const form = document.querySelector('#batchAddTagForm');
  if (form) form.remove();
}

// 已分类批量操作栏状态更新
function updateClassifiedBatchBar() {
  const count = state._selectedClassifiedIds.size;
  els.classifiedBatchBar.hidden = count === 0;
  els.classifiedSelectedCount.textContent = count;
  const totalCbs = els.classifiedTable.querySelectorAll('.classified-checkbox');
  if (totalCbs.length > 0) {
    els.classifiedSelectAll.checked = count === totalCbs.length;
    els.classifiedSelectAll.indeterminate = count > 0 && count < totalCbs.length;
  }
}

function clearClassifiedSelection() {
  state._selectedClassifiedIds.clear();
  els.classifiedTable.querySelectorAll('.classified-checkbox').forEach((cb) => { cb.checked = false; });
  els.classifiedSelectAll.checked = false;
  els.classifiedSelectAll.indeterminate = false;
  updateClassifiedBatchBar();
  const form = document.querySelector('#batchAddTagForm');
  if (form) form.remove();
}

async function batchDeleteTags() {
  const ids = [...state._selectedLowConfIds];
  if (ids.length === 0) {
    window.alert('请先在表格中勾选需要操作的评论。');
    return;
  }
  showBatchDeleteTagsModal(ids, 'lowConf');
}

async function batchDeleteClassifiedTags() {
  const ids = [...state._selectedClassifiedIds];
  if (ids.length === 0) {
    window.alert('请先在表格中勾选需要操作的评论。');
    return;
  }
  showBatchDeleteTagsModal(ids, 'classified');
}

// 显示批量删除标签选择弹窗
function showBatchDeleteTagsModal(reviewIds, context) {
  const reviews = state.currentResults?.reviews || [];
  const idSet = new Set(reviewIds);
  const selectedReviews = reviews.filter((r) => idSet.has(r.reviewId));

  // 收集所有唯一标签（去重），统计每个标签出现的次数
  const tagMap = new Map(); // key: "dimId::tagId" → { dimensionId, tagId, dimensionName, tagName, count }
  for (const r of selectedReviews) {
    for (const c of (r.classifications || [])) {
      if (c.suggested) continue;
      const key = `${c.dimensionId}::${c.tagId || c.tagName}`;
      if (tagMap.has(key)) {
        tagMap.get(key).count++;
      } else {
        tagMap.set(key, {
          dimensionId: c.dimensionId,
          tagId: c.tagId || c.tagName,
          dimensionName: c.dimensionName || '',
          tagName: c.tagName || '',
          count: 1
        });
      }
    }
  }

  const allTags = [...tagMap.values()];
  if (allTags.length === 0) {
    window.alert('所选评论没有已分配的标签。');
    return;
  }

  // 如果只有 1 个标签，直接确认删除
  if (allTags.length === 1) {
    if (!window.confirm(`确定要删除已选 ${reviewIds.length} 条评论的标签"${allTags[0].dimensionName} · ${allTags[0].tagName}"吗？`)) return;
    executeBatchDelete(reviewIds, context, null);
    return;
  }

  // 多个标签：显示弹窗让用户选择
  els.batchDeleteTagsList.innerHTML = allTags.map((t, i) => `
    <label style="display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer; font-size: 13px; border-bottom: 1px solid var(--line);">
      <input type="checkbox" class="batch-delete-tag-checkbox" data-index="${i}" checked>
      <span>${escapeHtml(t.dimensionName)} · ${escapeHtml(t.tagName)}</span>
      <span class="muted" style="font-size: 11px; margin-left: auto;">${t.count} 条评论</span>
    </label>
  `).join('');

  els.batchDeleteSelectAllTags.checked = true;
  els.batchDeleteTagsModal._allTags = allTags;
  els.batchDeleteTagsModal._context = context;
  els.batchDeleteTagsModal._reviewIds = reviewIds;
  els.batchDeleteTagsModal.hidden = false;
}

// 全选/取消全选
function onBatchDeleteSelectAllChange() {
  const checked = els.batchDeleteSelectAllTags.checked;
  els.batchDeleteTagsList.querySelectorAll('.batch-delete-tag-checkbox').forEach((cb) => { cb.checked = checked; });
}

// 执行批量删除
async function executeBatchDelete(reviewIds, context, selectedTags) {
  const btn = context === 'classified' ? els.classifiedBatchDeleteBtn : els.batchDeleteTagsBtn;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '删除中...';
  try {
    const body = { reviewIds };
    if (selectedTags && selectedTags.length > 0) {
      body.tags = selectedTags;
    }

    await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/reviews/batch-delete-tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    const idSet = new Set(reviewIds);
    if (selectedTags && selectedTags.length > 0) {
      // 选择性删除：只移除匹配的标签
      const tagSet = new Set(selectedTags.map((t) => `${t.dimensionId}::${t.tagId}`));
      for (const r of (state.currentResults.reviews || [])) {
        if (idSet.has(r.reviewId)) {
          r.classifications = (r.classifications || []).filter((c) => {
            const key = `${c.dimensionId}::${c.tagId || c.tagName}`;
            return !tagSet.has(key);
          });
          if (r.classifications.length === 0) {
            r.isLowConfidence = true;
            r.level3 = null;
          }
        }
      }
    } else {
      // 全量删除
      for (const r of (state.currentResults.reviews || [])) {
        if (idSet.has(r.reviewId)) {
          r.classifications = [];
          r.isLowConfidence = true;
          r.level3 = null;
        }
      }
    }
    updateLocalSummary();
    // 操作后保留多选：根据 isLowConfidence 状态同步选中 ID 到对应的 tab
    const idSet2 = new Set(reviewIds);
    for (const r of (state.currentResults.reviews || [])) {
      if (!idSet2.has(r.reviewId)) continue;
      if (r.isLowConfidence) {
        state._selectedClassifiedIds.delete(r.reviewId);
        state._selectedLowConfIds.add(r.reviewId);
      } else {
        state._selectedLowConfIds.delete(r.reviewId);
        state._selectedClassifiedIds.add(r.reviewId);
      }
    }
    renderFilteredReviews();
    renderLowConfidence();
    renderDimensionStats();
  } catch (error) {
    window.alert(`批量删除失败：${error.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
  els.batchDeleteTagsModal.hidden = true;
}

// 显示 AI 重分类结果弹窗
function showReclassifyModal(review, aiResult) {
  const classifications = aiResult.classifications || [];
  const level3 = aiResult.level3 || null;
  const allDimensions = state.currentResults?.template?.dimensions || [];

  els.reclassifyReviewText.innerHTML = `<strong>评论原文：</strong><br>${escapeHtml(review.reviewText || '')}${review.translatedText ? `<br><span class="muted">🌐 ${escapeHtml(review.translatedText)}</span>` : ''}`;

  if (classifications.length === 0 && !level3) {
    els.reclassifyResult.innerHTML = '<p class="muted">AI 未能匹配到任何分类标签。</p>';
  } else {
    let tagsHtml = '';
    for (const c of classifications) {
      const isSuggested = c.suggested;
      tagsHtml += `<span class="tag-badge ${isSuggested ? 'tag-badge--suggested' : ''}" style="margin: 2px;">
        ${isSuggested ? 'AI 建议: ' : ''}${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round((c.confidence || 0.5) * 100)}%)
      </span>`;
    }
    if (level3) {
      const l3Class = level3 === 'bug' ? 'l3-bug' : level3 === '需求/建议' ? 'l3-suggestion' : level3 === '不会操作' ? 'l3-operation' : level3 === '吐槽' ? 'l3-rant' : 'l3-unrelated';
      tagsHtml += `<span class="level3-badge ${l3Class}">${escapeHtml(level3)}</span>`;
    }
    els.reclassifyResult.innerHTML = `<div style="display: flex; flex-wrap: wrap; gap: 4px;">${tagsHtml}</div>`;
  }

  // 构建操作按钮
  els.reclassifyActions.innerHTML = '';
  if (classifications.length > 0) {
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'primary-button';
    acceptBtn.textContent = '接受此分类';
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      acceptBtn.textContent = '保存中...';
      try {
        // 处理 suggested 标签：确认后在模板中创建
        const newClasses = [];
        for (const c of classifications) {
          let dimId = c.dimensionId;
          let tagId = c.tagId;
          if (c.suggested) {
            // 在模板中查找或创建维度/标签
            let dim = allDimensions.find((d) => d.name === c.dimensionName || d.id === c.dimensionId);
            if (!dim) {
              dimId = `dim-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            } else {
              dimId = dim.id;
            }
            tagId = `tag-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          }
          newClasses.push({
            dimensionId: dimId,
            dimensionName: c.dimensionName,
            tagId: tagId,
            tagName: c.tagName,
  
            confidence: c.confidence || 0.5,
            manuallyAssigned: true,
            suggested: c.suggested || undefined
          });
        }

        // 保存到服务器（全量替换）
        await saveReviewClassifications(review.reviewId, newClasses);
        // 同步模板
        if (state.currentResults.template) {
          for (const c of newClasses) {
            if (c.suggested) continue;
            let dim = (state.currentResults.template.dimensions || []).find((d) => d.id === c.dimensionId);
            if (dim) {
              if (!dim.tags) dim.tags = [];
              if (!dim.tags.find((t) => t.id === c.tagId || t.name === c.tagName)) {
                dim.tags.push({ id: c.tagId, name: c.tagName });
              }
            }
          }
        }
        review.classifications = newClasses;
        if (level3) review.level3 = level3;
        const hasSuggestions = newClasses.some((c) => c.suggested);
        review.isLowConfidence = hasSuggestions;
        updateLocalSummary();
        renderLowConfidence();
        renderDimensionStats();
        els.reclassifyModal.hidden = true;
      } catch (error) {
        window.alert(`保存失败：${error.message}`);
        acceptBtn.disabled = false;
        acceptBtn.textContent = '接受此分类';
      }
    });
    els.reclassifyActions.appendChild(acceptBtn);
  }

  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'secondary-button';
  rejectBtn.textContent = '拒绝（保留原分类）';
  rejectBtn.style.cssText = 'background: transparent; border-color: var(--line);';
  rejectBtn.addEventListener('click', () => { els.reclassifyModal.hidden = true; });
  els.reclassifyActions.appendChild(rejectBtn);

  els.reclassifyModal.hidden = false;
}

async function batchReclassify() {
  const ids = [...state._selectedLowConfIds];
  if (ids.length === 0) {
    window.alert('请先在表格中勾选需要操作的评论。');
    return;
  }

  const btn = els.batchReclassifyBtn;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '分类中...';

  let data;
  try {
    const apiKey = document.querySelector('#apiKeyInput')?.value?.trim() || '';
    const providerId = document.querySelector('#providerSelect')?.value || 'deepseek';
    const model = document.querySelector('#modelSelect')?.value || 'deepseek-v4-pro';

    data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/reviews/batch-reclassify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewIds: ids, apiKey, providerId, model })
    });
  } catch (error) {
    window.alert(`批量AI重分类失败：${error.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
    return;
  }

  btn.disabled = false;
  btn.textContent = originalText;
  showBatchReclassifyModal(ids, data.results);
}

function showBatchReclassifyModal(reviewIds, aiResults) {
  const reviews = state.currentResults?.reviews || [];
  const allDimensions = state.currentResults?.template?.dimensions || [];
  const resultMap = new Map();
  for (const r of aiResults) {
    resultMap.set(r.reviewId, r);
  }

  // 移除已有弹窗
  const existing = document.querySelector('#batchReclassifyModal');
  if (existing) existing.remove();

  let rowsHtml = '';
  for (const rid of reviewIds) {
    const review = reviews.find((r) => r.reviewId === rid);
    if (!review) continue;
    const aiResult = resultMap.get(rid);
    const classifications = aiResult?.classifications || [];
    const level3 = aiResult?.level3 || null;
    const text = (review.reviewText || '').slice(0, 100) + ((review.reviewText || '').length > 100 ? '...' : '');

    let tagsHtml = '';
    if (classifications.length === 0 && !level3) {
      tagsHtml = '<span class="muted">AI 未能匹配</span>';
    } else {
      for (const c of classifications) {
        const isSuggested = c.suggested;
        tagsHtml += `<span class="tag-badge ${isSuggested ? 'tag-badge--suggested' : ''}" style="margin: 2px; display: inline-block;">
          ${isSuggested ? 'AI 建议: ' : ''}${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round((c.confidence || 0.5) * 100)}%)
        </span>`;
      }
      if (level3) {
        const l3Class = level3 === 'bug' ? 'l3-bug' : level3 === '需求/建议' ? 'l3-suggestion' : level3 === '不会操作' ? 'l3-operation' : level3 === '吐槽' ? 'l3-rant' : 'l3-unrelated';
        tagsHtml += `<span class="level3-badge ${l3Class}">${escapeHtml(level3)}</span>`;
      }
    }

    rowsHtml += `
      <div style="border-bottom: 1px solid var(--line); padding: 10px 0;">
        <div style="font-size: 13px; margin-bottom: 6px; color: var(--text);">${escapeHtml(text)}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">${tagsHtml}</div>
      </div>`;
  }

  const modal = document.createElement('div');
  modal.id = 'batchReclassifyModal';
  modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 10000;';
  modal.innerHTML = `
    <div style="background: var(--paper); border-radius: 12px; padding: 24px; max-width: 700px; width: 90%; max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.18);">
      <h3 style="margin: 0 0 8px 0;">批量AI重分类结果</h3>
      <p class="muted" style="margin: 0 0 16px 0;">共 ${reviewIds.length} 条评论，AI 已给出分类建议。请确认是否接受。</p>
      <div style="margin-bottom: 16px;">${rowsHtml}</div>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="batchReclassifyRejectBtn" class="secondary-button" type="button" style="background: transparent; border-color: var(--line);">拒绝（保留原分类）</button>
        <button id="batchReclassifyAcceptBtn" class="primary-button" type="button">全部接受</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  // 关闭弹窗
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('#batchReclassifyRejectBtn').addEventListener('click', () => {
    modal.remove();
    // 保持选择
  });

  modal.querySelector('#batchReclassifyAcceptBtn').addEventListener('click', async () => {
    const acceptBtn = modal.querySelector('#batchReclassifyAcceptBtn');
    acceptBtn.disabled = true;
    acceptBtn.textContent = '保存中...';

    try {
      let savedCount = 0;
      for (const rid of reviewIds) {
        const aiResult = resultMap.get(rid);
        if (!aiResult) continue;
        const review = reviews.find((r) => r.reviewId === rid);
        if (!review) continue;

        const classifications = aiResult.classifications || [];
        const level3 = aiResult.level3 || null;

        if (classifications.length === 0 && !level3) continue;

        const newClasses = [];
        for (const c of classifications) {
          let dimId = c.dimensionId;
          let tagId = c.tagId;
          if (c.suggested) {
            let dim = allDimensions.find((d) => d.name === c.dimensionName || d.id === c.dimensionId);
            if (!dim) {
              dimId = `dim-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            } else {
              dimId = dim.id;
            }
            tagId = `tag-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          }
          newClasses.push({
            dimensionId: dimId,
            dimensionName: c.dimensionName,
            tagId: tagId,
            tagName: c.tagName,
  
            confidence: c.confidence || 0.5,
            manuallyAssigned: true,
            suggested: c.suggested || undefined
          });
        }

        await saveReviewClassifications(rid, newClasses);

        if (state.currentResults.template) {
          for (const c of newClasses) {
            if (c.suggested) continue;
            let dim = (state.currentResults.template.dimensions || []).find((d) => d.id === c.dimensionId);
            if (dim) {
              if (!dim.tags) dim.tags = [];
              if (!dim.tags.find((t) => t.id === c.tagId || t.name === c.tagName)) {
                dim.tags.push({ id: c.tagId, name: c.tagName });
              }
            }
          }
        }

        review.classifications = newClasses;
        if (level3) review.level3 = level3;
        const hasSuggestions = newClasses.some((c) => c.suggested);
        review.isLowConfidence = hasSuggestions;
        savedCount++;
      }

      // 同步选择：已保存的评论同步 isLowConfidence 状态
      const idSet = new Set(reviewIds);
      for (const r of reviews) {
        if (!idSet.has(r.reviewId)) continue;
        if (r.isLowConfidence) {
          state._selectedClassifiedIds.delete(r.reviewId);
          state._selectedLowConfIds.add(r.reviewId);
        } else {
          state._selectedLowConfIds.delete(r.reviewId);
          state._selectedClassifiedIds.add(r.reviewId);
        }
      }

      updateLocalSummary();
      renderFilteredReviews();
      renderLowConfidence();
      renderDimensionStats();
      modal.remove();
    } catch (error) {
      window.alert(`保存失败：${error.message}`);
      acceptBtn.disabled = false;
      acceptBtn.textContent = '全部接受';
    }
  });
}

function showBatchAddForm(context) {
  // 移除已有表单
  const existing = document.querySelector('#batchAddTagForm');
  if (existing) { existing.remove(); return; }

  const isClassified = context === 'classified';
  const targetBar = isClassified ? els.classifiedBatchBar : els.lowConfBatchBar;
  const selectedSet = isClassified ? state._selectedClassifiedIds : state._selectedLowConfIds;

  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];

  // 构建共享 datalist（未选维度时显示全部标签）
  const sharedDatalistOptions = allDimensions.flatMap((d) =>
    (d.tags || []).map((t) => `<option value="${escapeAttr(t.name)}">${escapeHtml(d.name)}</option>`)
  ).join('');

  // 每个维度独立的 datalist，用于维度联动过滤
  const perDimDatalists = allDimensions.map((d) =>
    `<datalist id="batch-add-datalist-${escapeAttr(d.id)}">${(d.tags || []).map((t) => `<option value="${escapeAttr(t.name)}">${escapeHtml(d.name)}</option>`).join('')}</datalist>`
  ).join('');

  const form = document.createElement('div');
  form.id = 'batchAddTagForm';
  form.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; width: 100%;';
  form.innerHTML = `
    <datalist id="batch-add-tag-datalist">${sharedDatalistOptions}</datalist>
    ${perDimDatalists}
    <select id="batchAddDimSelect" style="height: 30px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px;">
      <option value="">选择维度</option>
      ${allDimensions.map((d) => `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
    </select>
    <input id="batchAddTagInput" list="batch-add-tag-datalist" placeholder="搜索或输入标签" style="height: 30px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; width: 180px;">
    <select id="batchAddPolaritySelect" style="height: 30px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 4px; width: 80px;"><option value="">向性</option><option value="正向">正向</option><option value="负向">负向</option><option value="中性">中性</option><option value="需求">需求</option></select>
    <button id="batchAddConfirmBtn" class="primary-button compact-button" type="button" style="font-size: 12px; padding: 5px 14px;">确认添加</button>
    <button id="batchAddCancelBtn" class="secondary-button compact-button" type="button" style="font-size: 12px; background: transparent; border-color: var(--line);">取消</button>
  `;
  targetBar.appendChild(form);

  // 维度切换联动：切换维度时过滤标签 datalist
  const dimSelect = form.querySelector('#batchAddDimSelect');
  const tagInput = form.querySelector('#batchAddTagInput');
  dimSelect.addEventListener('change', () => {
    const dimId = dimSelect.value;
    tagInput.setAttribute('list', dimId ? `batch-add-datalist-${dimId}` : 'batch-add-tag-datalist');
    tagInput.value = '';
  });

  // 标签搜索联动维度
  const tagToDimMap = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagToDimMap.set(tag.name, dim.id);
    }
  }
  tagInput.addEventListener('input', () => {
    const dimId = tagToDimMap.get(tagInput.value.trim());
    if (dimId) dimSelect.value = dimId;
  });

  form.querySelector('#batchAddCancelBtn').addEventListener('click', () => form.remove());
  form.querySelector('#batchAddConfirmBtn').addEventListener('click', async () => {
    const dimId = form.querySelector('#batchAddDimSelect').value;
    const tagName = form.querySelector('#batchAddTagInput').value.trim();
    if (!dimId || !tagName) { window.alert('请选择维度和输入标签。'); return; }

    const ids = [...selectedSet];
    if (ids.length === 0) return;

    const confirmBtn = form.querySelector('#batchAddConfirmBtn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = '添加中...';
    try {
      const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/reviews/batch-add-tag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewIds: ids, dimensionId: dimId, tagName, polarity: els.batchAddPolaritySelect?.value || '' })
      });

      // 更新本地状态
      const idSet = new Set(ids);
      for (const r of (state.currentResults.reviews || [])) {
        if (idSet.has(r.reviewId)) {
          r.isLowConfidence = false;
          r.level3 = null;
          if (!r.classifications) r.classifications = [];
          const exists = r.classifications.some((c) => !c.suggested && c.dimensionId === dimId && c.tagId === data.tagId);
          if (!exists) {
            r.classifications.push({
              dimensionId: dimId,
              dimensionName: data.dimensionName || '',
              tagId: data.tagId,
              tagName: data.tagName,
              polarity: els.batchAddPolaritySelect?.value || '',
              confidence: 1,
              manuallyAssigned: true
            });
          }
        }
      }
      // 同步本地模板快照
      if (state.currentResults.template) {
        let dim = (state.currentResults.template.dimensions || []).find((d) => d.id === dimId);
        if (dim && data.tagId) {
          if (!dim.tags) dim.tags = [];
          if (!dim.tags.find((t) => t.id === data.tagId || t.name === data.tagName)) {
            dim.tags.push({ id: data.tagId, name: data.tagName });
          }
        }
      }
      updateLocalSummary();
      // 操作后保留多选：低置信度评论加标签后变成已分类，同步转移选中 ID
      const idSet3 = new Set(ids);
      for (const r of (state.currentResults.reviews || [])) {
        if (!idSet3.has(r.reviewId)) continue;
        if (r.isLowConfidence) {
          state._selectedClassifiedIds.delete(r.reviewId);
          state._selectedLowConfIds.add(r.reviewId);
        } else {
          state._selectedLowConfIds.delete(r.reviewId);
          state._selectedClassifiedIds.add(r.reviewId);
        }
      }
      form.remove();
      renderFilteredReviews();
      renderLowConfidence();
      renderDimensionStats();
    } catch (error) {
      window.alert(`批量添加失败：${error.message}`);
      confirmBtn.disabled = false;
      confirmBtn.textContent = '确认添加';
    }
  });
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
       <button class="secondary-button compact-button batch-meaningless-btn" type="button" style="margin-left: 12px; background: var(--muted); color: #fff; border-color: var(--muted);" onclick="window._batchMarkMeaningless()">全部标记为无意义</button>`;

  if (lowConf.length === 0) {
    els.lowConfidenceTable.innerHTML = '<tr><td colspan="7" class="empty">没有待确认的评论。</td></tr>';
    els.lowConfBatchBar.hidden = true;
    return;
  }

  const template = state.currentResults?.template;
  const allDimensions = template?.dimensions || [];

  // 构建共享 datalist（避免 741行 × 259标签 = 19万 DOM 元素导致崩溃）
  const sharedDatalistOptions = allDimensions.flatMap((dim) =>
    (dim.tags || []).map((tag) => `<option value="${escapeAttr(tag.name)}">${escapeHtml(dim.name)}</option>`)
  ).join('');

  // 构建每个维度独立的 datalist，供维度切换时联动过滤
  const perDimDatalists = allDimensions.map((dim) =>
    `<datalist id="reassign-datalist-${escapeAttr(dim.id)}">${(dim.tags || []).map((tag) => `<option value="${escapeAttr(tag.name)}">${escapeHtml(dim.name)}</option>`).join('')}</datalist>`
  ).join('');

  els.lowConfidenceTable.innerHTML = `
    <datalist id="shared-reassign-datalist">${sharedDatalistOptions}</datalist>
    ${perDimDatalists}
    ${lowConf.map((r) => {
    const regularClasses = (r.classifications || []).filter((c) => !c.suggested);
    const suggestedClasses = (r.classifications || []).filter((c) => c.suggested);
    const allClasses = (r.classifications || []);
    const hasNotes = allClasses.some((c) => c.note && c.note.trim());
    const isChecked = state._selectedLowConfIds.has(r.reviewId);

    return `
    <tr data-review-id="${escapeAttr(r.reviewId)}">
      <td style="width: 32px; text-align: center;"><input type="checkbox" class="low-conf-checkbox" data-review-id="${escapeAttr(r.reviewId)}" ${isChecked ? 'checked' : ''}></td>
      <td style="max-width: 320px;">
        <div class="review-text-cell">${escapeHtml(r.reviewText || '')}</div>
        ${r.translatedText ? `<div class="translated-text-cell">🌐 ${escapeHtml(r.translatedText)}</div>` : ''}
      </td>
      <td>${'★'.repeat(Math.min(5, r.starRating || 0))} ${r.starRating || '-'}</td>
      <td class="muted" style="font-size: 12px;">${escapeHtml(r.appVersion || '-')}</td>
      <td>
        <div class="tag-badges">
          ${regularClasses.length > 0
            ? regularClasses.map((c) => {
                const polarity = c.polarity || '';
                const polClass = polarity === '正向' ? 'pol-positive' : polarity === '负向' ? 'pol-negative' : polarity === '需求' ? 'pol-demand' : 'pol-neutral';
                return `<span class="tag-badge" title="${escapeAttr(c.note || '')}"><span class="polarity-tag ${polClass}">${escapeHtml(polarity)}</span>${escapeHtml(c.dimensionName)} · ${escapeHtml(c.tagName)} (${Math.round(c.confidence * 100)}%)<button class="tag-delete-btn" type="button" data-review-id="${escapeAttr(r.reviewId)}" data-dim-id="${escapeAttr(c.dimensionId)}" data-tag-id="${escapeAttr(c.tagId || c.tagName)}" title="删除标签" style="margin-left: 4px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px;">✕</button></span>`;
              }).join('')
            : (suggestedClasses.length === 0 ? '<span class="muted">AI 未能匹配</span>' : '')}
          ${suggestedClasses.map((c) => {
            const polarity = c.polarity || '';
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
        <input class="reassign-tag-input" data-review-id="${escapeAttr(r.reviewId)}" list="shared-reassign-datalist" placeholder="搜索或输入新标签" style="height: 28px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; background: var(--paper); margin-bottom: 4px; width: 150px;">
        <select class="reassign-polarity-select" data-review-id="${escapeAttr(r.reviewId)}" style="height: 28px; font-size: 12px; border: 1px solid var(--line); border-radius: 6px; padding: 0 2px; background: var(--paper); margin-bottom: 4px; width: 70px;"><option value="">向性</option><option value="正向">正向</option><option value="负向">负向</option><option value="中性">中性</option><option value="需求">需求</option></select>
        <button class="secondary-button compact-button reassign-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button">添加标签</button>
        <button class="secondary-button compact-button reclassify-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button" style="background: var(--accent); color: #fff; border-color: var(--accent);">AI重分类</button>
        <button class="secondary-button compact-button meaningless-btn" data-review-id="${escapeAttr(r.reviewId)}" type="button" style="background: var(--muted); color: #fff; border-color: var(--muted);">标记无意义</button>
      </td>
    </tr>
  `}).join('')}`;

  // 维度下拉联动：切换维度时更新该行标签输入框的 datalist，只显示该维度下的标签
  els.lowConfidenceTable.querySelectorAll('.reassign-dim-select').forEach((dimSelect) => {
    dimSelect.addEventListener('change', () => {
      const reviewId = dimSelect.dataset.reviewId;
      const tagInput = els.lowConfidenceTable.querySelector(`.reassign-tag-input[data-review-id="${reviewId}"]`);
          const polaritySelect = els.lowConfidenceTable.querySelector(`.reassign-polarity-select[data-review-id="${reviewId}"]`);
      if (tagInput) {
        const dimId = dimSelect.value;
        tagInput.setAttribute('list', dimId ? `reassign-datalist-${dimId}` : 'shared-reassign-datalist');
        tagInput.value = ''; // 清空已输入内容，避免跨维度误用
      }
    });
  });

  // 添加标签按钮：将手动选择的标签追加到评论分类中，保留已有的 AI 建议。
  els.lowConfidenceTable.querySelectorAll('.reassign-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimSelect = els.lowConfidenceTable.querySelector(`.reassign-dim-select[data-review-id="${reviewId}"]`);
      const tagInput = els.lowConfidenceTable.querySelector(`.reassign-tag-input[data-review-id="${reviewId}"]`);
      const dimId = dimSelect.value;
      const tagValue = tagInput.value.trim();

      if (!dimId || !tagValue) {
        window.alert('请同时选择维度和输入标签。');
        return;
      }

      const cleanTagValue = tagValue.replace(/^\[[^\]]+\]\s*/, '').trim();
      const dim = allDimensions.find((d) => d.id === dimId);
      const tag = dim?.tags.find((t) => t.name.replace(/^\[[^\]]+\]\s*/, '').trim() === cleanTagValue || t.id === tagValue);
      let tagName = tag?.name || cleanTagValue;
      let tagId = tag?.id || '';

      // 如果是新标签，同步到本地 template 和服务器
      if (!tag && dim) {
        tagId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (!dim.tags) dim.tags = [];
        dim.tags.push({ id: tagId, name: tagName });
        try {
          const res = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/tags`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dimensionId: dimId, tagName })
          });
          // 使用服务器返回的正式 tagId，替换本地临时 ID
          if (res?.id && res.id !== tagId) {
            const localTag = dim.tags.find((t) => t.id === tagId);
            if (localTag) localTag.id = res.id;
            tagId = res.id;
            if (res.name) tagName = res.name;
          }
        } catch { /* 静默失败，前端已乐观更新 */ }
      }

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
        polarity: polaritySelect?.value || '',
        confidence: 1,
        manuallyAssigned: true
      }];

      try {
        await saveReviewClassifications(reviewId, newClasses);

        recordEditHistory(review, originalClasses, newClasses, 'tag_added');
        addRecentTag(dimId, dim?.name || '', tagName, polaritySelect?.value || '');
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

  // AI 重分类按钮：对单条评论调用 LLM 获取分类建议
  els.lowConfidenceTable.querySelectorAll('.reclassify-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const review = (state.currentResults?.reviews || []).find((r) => r.reviewId === reviewId);
      if (!review) return;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '分类中...';

      try {
        const apiKey = document.querySelector('#apiKeyInput')?.value?.trim() || '';
        const providerId = document.querySelector('#providerSelect')?.value || 'deepseek';
        const model = document.querySelector('#modelSelect')?.value || 'deepseek-v4-pro';

        const data = await fetchJson(`/api/analysis/${encodeURIComponent(state.currentResults.id)}/reviews/${encodeURIComponent(reviewId)}/reclassify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiKey, providerId, model })
        });

        // 显示重分类弹窗
        showReclassifyModal(review, data);
      } catch (error) {
        window.alert(`AI 重分类失败：${error.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
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
          review.classifications = [{ dimensionId: '_meaningless', tagId: '_meaningless', dimensionName: '无意义', tagName: '无意义', polarity: '中性', confidence: 1, manuallyAssigned: true }];
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
  // 批量标记无意义（通过 onclick 属性调用，避免 addEventListener 在多次渲染时重复绑定）

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
            if (c.suggested && cleanDimName(c.dimensionName) === cleanDimName(dimensionName) && cleanTagNameJS(c.tagName) === cleanTagNameJS(tagName)) {
              delete c.suggested;
              c.dimensionId = data.dimensionId;
              c.dimensionName = cleanDimName(c.dimensionName);  // 去除多余后缀
              c.tagId = data.tagId;
              c.tagName = cleanTagNameJS(c.tagName);
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
        const cleanedDimName = cleanDimName(dimensionName);
        if (data.dimensionId && data.tagId && state.currentResults.template) {
          let dim = (state.currentResults.template.dimensions || []).find((d) => d.id === data.dimensionId || cleanDimName(d.name) === cleanedDimName);
          if (!dim) {
            dim = { id: data.dimensionId, name: cleanedDimName, productMeaning: '', tags: [] };
            state.currentResults.template.dimensions.push(dim);
          }
          if (!(dim.tags || []).find((t) => t.id === data.tagId || t.name === data.tagName || cleanTagNameJS(t.name) === cleanTagNameJS(tagName))) {
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
            if (c.suggested && cleanDimName(c.dimensionName) === cleanDimName(dimensionName) && cleanTagNameJS(c.tagName) === cleanTagNameJS(tagName)) return false;
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

  // 已确认标签的删除按钮
  els.lowConfidenceTable.querySelectorAll('.tag-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const dimId = btn.dataset.dimId;
      const tagId = btn.dataset.tagId;
      await deleteClassification(reviewId, dimId, tagId);
    });
  });

  // 标签输入框选择后自动带入对应维度
  const tagToDimMap = new Map();
  for (const dim of allDimensions) {
    for (const tag of (dim.tags || [])) {
      tagToDimMap.set(tag.name, dim.id);
    }
  }
  els.lowConfidenceTable.querySelectorAll('.reassign-tag-input').forEach((input) => {
    input.addEventListener('input', () => {
      const dimId = tagToDimMap.get(input.value.trim());
      if (dimId) {
        const dimSelect = els.lowConfidenceTable.querySelector(`.reassign-dim-select[data-review-id="${input.dataset.reviewId}"]`);
        if (dimSelect) dimSelect.value = dimId;
      }
    });
  });

  // 多选复选框事件
  els.lowConfidenceTable.querySelectorAll('.low-conf-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      const rid = cb.dataset.reviewId;
      if (cb.checked) state._selectedLowConfIds.add(rid);
      else state._selectedLowConfIds.delete(rid);
      updateBatchBar();
    });
  });
  updateBatchBar();
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
    'Starting AI analysis': '正在启动 AI 分析',
    'Starting DeepSeek analysis': '正在启动 AI 分析',  // 兼容旧版进度字符串
    'Analyzing batch': '正在分析评论批次',
    'Saving results': '正在保存分析结果',
    Completed: '已完成',
    Failed: '失败'
  };
  return map[step] || step || '';
}

// ===== Prompt 版本管理弹窗 =====

function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type || 'success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

async function openPromptManager() {
  els.promptManagerModal.hidden = false;
  els.promptManagerEditor.innerHTML = '<p class="muted" style="text-align: center; margin-top: 80px;">加载中...</p>';
  await refreshPromptVersionList();
}

function closePromptManager() {
  els.promptManagerModal.hidden = true;
}

async function refreshPromptVersionList(activeVersion) {
  try {
    const data = await fetchJson('/api/prompts/versions');
    const versions = data.versions || [];
    if (!activeVersion && versions.length > 0) {
      const cur = versions.find((v) => v.current) || versions[0];
      activeVersion = cur.version;
    }
    els.promptVersionList.innerHTML = versions.map((v) =>
      `<div class="version-item${v.version === activeVersion ? ' active' : ''}" data-version="${escapeAttr(v.version)}">
        <span>v${escapeHtml(v.version)}${v.current ? '<span class="version-badge">默认</span>' : ''}</span>
      </div>`
    ).join('') || '<p class="muted" style="padding: 8px;">暂无版本</p>';

    // 绑定点击事件
    els.promptVersionList.querySelectorAll('.version-item').forEach((el) => {
      el.addEventListener('click', () => editPromptVersion(el.dataset.version));
    });

    // 自动加载当前选中版本到编辑器
    if (activeVersion) {
      await editPromptVersion(activeVersion, true);
    }
  } catch (err) {
    els.promptVersionList.innerHTML = '<p class="muted" style="padding: 8px; color: var(--red);">加载失败</p>';
  }
}

async function editPromptVersion(version, skipRefresh) {
  try {
    // 先刷新 sidebar 高亮状态（用户点击时），自动加载时跳过避免循环
    if (!skipRefresh) await refreshPromptVersionList(version);

    const data = await fetchJson(`/api/prompts/versions/${encodeURIComponent(version)}`);
    const v = data.version;
    if (!v) { showToast('版本不存在。', 'error'); return; }

    els.promptManagerEditor.innerHTML = `
      <div class="field full">
        <span>版本号</span>
        <input id="editVersionId" type="text" value="${escapeAttr(v.version)}" readonly style="background: var(--bg);">
      </div>
      <div class="field full">
        <span>描述</span>
        <input id="editVersionDesc" type="text" value="${escapeAttr(v.description || '')}" placeholder="简要描述此版本的改动">
      </div>
      <div class="field full">
        <span>Prompt 模板 <span class="fine-print">（\${dimensionsDesc} 会在运行时替换为模板维度标签）</span></span>
        <textarea id="editVersionTemplate" rows="16" style="width: 100%; border: 1px solid var(--line-dark); border-radius: 8px; padding: 10px; font-size: 13px; font-family: monospace; resize: vertical;">${escapeHtml(v.promptTemplate || '')}</textarea>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; margin-top: 12px;">
        <button id="saveVersionBtn" class="secondary-button" type="button" style="font-size: 13px; height: 36px; margin-top: 0;">保存</button>
        ${v.current ? '' : '<button id="setCurrentVersionBtn" class="secondary-button" type="button" style="font-size: 13px; height: 36px; margin-top: 0;">设为默认</button>'}
        ${v.current ? '' : '<button id="deleteVersionBtn" class="secondary-button" type="button" style="font-size: 13px; height: 36px; margin-top: 0; margin-left: auto; background: var(--red); color: #fff; border-color: var(--red);">删除</button>'}
        ${v.current ? '<span class="muted" style="font-size: 12px; margin-left: auto;">当前默认版本，不可删除</span>' : ''}
      </div>`;

    document.getElementById('saveVersionBtn').addEventListener('click', () => handleSavePromptVersion(false, version));
    if (!v.current) {
      document.getElementById('setCurrentVersionBtn').addEventListener('click', () => handleSetCurrentVersion(version));
      document.getElementById('deleteVersionBtn').addEventListener('click', () => handleDeletePromptVersion(version));
    }
  } catch (err) {
    showToast('加载版本失败：' + err.message, 'error');
  }
}

async function handleNewPromptVersion() {
  // 获取最近一个版本的 prompt 模板作为默认值
  let defaultTemplate = '';
  try {
    const data = await fetchJson('/api/prompts/versions');
    const versions = data.versions || [];
    if (versions.length > 0) {
      const latest = versions.find((v) => v.current) || versions[0];
      const vData = await fetchJson(`/api/prompts/versions/${encodeURIComponent(latest.version)}`);
      defaultTemplate = vData.version?.promptTemplate || '';
    }
  } catch { /* 获取失败就用空模板 */ }

  els.promptManagerEditor.innerHTML = `
    <div class="field full">
      <span>版本号 <span class="fine-print">（如 2.1、3.0）</span></span>
      <input id="editVersionId" type="text" placeholder="输入版本号">
    </div>
    <div class="field full">
      <span>描述</span>
      <input id="editVersionDesc" type="text" placeholder="简要描述此版本的改动">
    </div>
    <div class="field full">
      <span>Prompt 模板 <span class="fine-print">（\${dimensionsDesc} 会在运行时替换）</span></span>
      <textarea id="editVersionTemplate" rows="16" style="width: 100%; border: 1px solid var(--line-dark); border-radius: 8px; padding: 10px; font-size: 13px; font-family: monospace; resize: vertical;">${escapeHtml(defaultTemplate)}</textarea>
    </div>
    <div style="display: flex; gap: 8px; margin-top: 12px;">
      <button id="saveVersionBtn" class="secondary-button" type="button" style="font-size: 13px; height: 36px; margin-top: 0;">创建版本</button>
    </div>`;

  document.getElementById('saveVersionBtn').addEventListener('click', () => handleSavePromptVersion(true));
}

async function handleSavePromptVersion(isNew, originalVersion) {
  const versionId = document.getElementById('editVersionId').value.trim();
  const description = document.getElementById('editVersionDesc').value.trim();
  const promptTemplate = document.getElementById('editVersionTemplate').value;

  if (!versionId) { window.alert('请输入版本号。'); return; }
  if (!promptTemplate) { window.alert('Prompt 模板不能为空。'); return; }
  if (!promptTemplate.includes('${dimensionsDesc}')) {
    if (!window.confirm('Prompt 模板中未包含 ${dimensionsDesc} 占位符。没有它，不同模板的维度标签将无法替换。确定继续？')) return;
  }

  try {
    if (isNew) {
      await fetchJson('/api/prompts/versions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: versionId, description, promptTemplate })
      });
    } else {
      await fetchJson(`/api/prompts/versions/${encodeURIComponent(originalVersion)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description, promptTemplate })
      });
    }
    await refreshPromptVersionList(isNew ? versionId : originalVersion);
    if (isNew) {
      editPromptVersion(versionId, true);
    }
    await loadPromptVersions(); // 刷新分析面板的版本下拉框
    showToast(isNew ? `版本 ${versionId} 已创建` : `版本 ${originalVersion} 已保存`);
  } catch (err) {
    showToast('保存失败：' + err.message, 'error');
  }
}

async function handleDeletePromptVersion(version) {
  if (!window.confirm(`确定要删除版本 ${version}？此操作不可撤销。`)) return;
  try {
    await fetchJson(`/api/prompts/versions/${encodeURIComponent(version)}`, { method: 'DELETE' });
    await refreshPromptVersionList();
    await loadPromptVersions();
    els.promptManagerEditor.innerHTML = '<p class="muted" style="text-align: center; margin-top: 80px;">← 选择左侧版本进行编辑，或新建版本</p>';
    showToast(`版本 ${version} 已删除`);
  } catch (err) {
    showToast('删除失败：' + err.message, 'error');
  }
}

async function handleSetCurrentVersion(version) {
  try {
    await fetchJson(`/api/prompts/versions/${encodeURIComponent(version)}/set-current`, { method: 'PUT' });
    await refreshPromptVersionList(version);
    await loadPromptVersions();
    showToast(`v${version} 已设为默认版本`);
  } catch (err) {
    showToast('设置默认失败：' + err.message, 'error');
  }
}

