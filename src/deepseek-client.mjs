import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCSVFiles } from './csv-reader.mjs';
import { callLLM } from './llm-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_VERSIONS_FILE = path.join(__dirname, '..', 'data', 'prompts', 'system-prompt-versions.json');

const LEVEL3_VALUES = ['bug', '需求/建议', '不会操作', '与程序无关', '吐槽'];

// 启动一次完整的评论解析任务。
// options 参数说明见下方。
export async function runReviewAnalysis(options) {
  const {
    analysisId,
    template,
    csvFilePaths,
    apiKey,
    providerId = 'deepseek',
    model = 'deepseek-v4-pro',
    confidenceThreshold = 0.6,
    parallelTasks = 20,
    maxReviewsPerBatch = 0,
    temperature = 0.1,
    maxTokens = 8192,
    systemPrompt: customSystemPrompt,
    userPromptTemplate: customUserPromptTemplate,
    promptVersion,
    onProgress = () => {}
  } = options;

  // ===== 阶段 1：读取 CSV 文件 =====
  onProgress({ progress: 2, currentStep: 'Reading CSV files' });
  const { reviews, stats: mergeStats } = await mergeCSVFiles(csvFilePaths);
  if (reviews.length === 0) {
    throw new Error('没有找到可解析的评论数据。请确认 CSV 文件不为空。');
  }

  onProgress({
    progress: 5,
    currentStep: 'Merging reviews',
    totalReviews: reviews.length,
    totalFiles: mergeStats.totalFiles,
    duplicates: mergeStats.duplicates
  });

  // ===== 阶段 2：预处理过滤无意义评论 =====
  const MEANINGLESS_DIM = '无意义内容';
  const MEANINGLESS_ID = '_meaningless';

  const meaningfulReviews = [];
  const meaninglessReviews = [];
  for (const review of reviews) {
    if (isObviouslyMeaningless(review.reviewText)) {
      meaninglessReviews.push({
        ...review,
        classifications: [{
          dimensionId: MEANINGLESS_ID,
          dimensionName: MEANINGLESS_DIM,
          tagId: MEANINGLESS_ID,
          tagName: '无意义',
          confidence: 1
        }],
        isLowConfidence: true
      });
    } else {
      meaningfulReviews.push(review);
    }
  }

  onProgress({
    progress: 8,
    currentStep: 'Filtering meaningless reviews',
    totalReviews: reviews.length,
    meaningful: meaningfulReviews.length,
    meaningless: meaninglessReviews.length
  });

  // ===== 阶段 3：拆分为批次（仅有效评论） =====
  const autoBatchSize = Math.max(1, Math.ceil(meaningfulReviews.length / Math.max(1, Math.ceil(meaningfulReviews.length / 100))));
  const batchSize = maxReviewsPerBatch > 0 ? Math.min(maxReviewsPerBatch, meaningfulReviews.length) : autoBatchSize;
  const batches = splitIntoBatches(meaningfulReviews, batchSize);
  const actualConcurrency = Math.min(parallelTasks, batches.length || 1);

  onProgress({
    progress: 10,
    currentStep: 'Starting AI analysis',
    totalBatches: batches.length,
    batchSize,
    prefiltered: meaninglessReviews.length
  });

  // ===== 阶段 4：并行调用 DeepSeek（仅有效评论） =====
  const classifiedReviews = [];
  const errors = [];
  let completedBatches = 0;

  if (batches.length > 0) {
    await runWithConcurrency(batches, actualConcurrency, async (batch, batchIndex) => {
      try {
        const results = await analyzeBatch(batch, template, apiKey, model, { temperature, maxTokens, systemPrompt: customSystemPrompt, userPromptTemplate: customUserPromptTemplate, promptVersion, providerId });
        classifiedReviews.push(...results);
      } catch (error) {
        errors.push({ batchIndex, count: batch.length, error: error.message });
        for (const review of batch) {
          classifiedReviews.push({
            ...review,
            classifications: [],
            isLowConfidence: true,
            error: error.message
          });
        }
      }

      completedBatches += 1;
      const progress = 10 + Math.round((completedBatches / batches.length) * 85);
      onProgress({
        progress,
        currentStep: `Analyzing batch ${completedBatches}/${batches.length}`,
        completedBatches,
        totalBatches: batches.length
      });
    });
  }

  // 合并预处理过滤掉的无意义评论
  classifiedReviews.push(...meaninglessReviews);

  // ===== 阶段 4：计算统计并标记低置信度 =====
  onProgress({ progress: 95, currentStep: 'Saving results' });

  // 标记低置信度：所有分类的 confidence 都 < threshold 的评论
  for (const review of classifiedReviews) {
    if (!review.isLowConfidence) {
      const hasHighEnough = (review.classifications || []).some((c) => c.confidence >= confidenceThreshold);
      review.isLowConfidence = !hasHighEnough;
    }
  }

  const dimensionStats = calculateDimensionStats(classifiedReviews, template);

  const summary = {
    totalReviews: reviews.length,
    prefilteredMeaningless: meaninglessReviews.length,
    classifiedCount: classifiedReviews.filter((r) => !r.isLowConfidence && r.classifications.length > 0).length,
    lowConfidenceCount: classifiedReviews.filter((r) => r.isLowConfidence).length,
    errorCount: errors.length,
    confidenceThreshold,
    completedAt: new Date().toISOString()
  };

  onProgress({ progress: 100, currentStep: 'Completed' });

  return {
    id: analysisId,
    generatedAt: new Date().toISOString(),
    template,
    reviews: classifiedReviews,
    dimensionStats,
    summary,
    errors
  };
}

// 预处理：判断评论是否明显无意义，无需发给 DeepSeek。
// 规则：空文本、纯空白、纯 emoji/符号、单字母/数字、仅含常见无意义短词。
function isObviouslyMeaningless(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // 纯 emoji、特殊符号、标点（不含任何字母或中文字符）
  if (!/[a-zA-Z一-鿿぀-ゟ゠-ヿ가-힯]/.test(trimmed)) return true;

  // 仅 1-2 个字母或数字
  if (/^[a-zA-Z0-9]{1,2}$/.test(trimmed)) return true;

  // 常见"水评"单一短词（纯情绪、无实质内容）
  const noiseWords = /^(good|nice|great|awesome|bad|terrible|ok|okay|yes|no|thanks|thank you|super|wow|nice app|good app|best app|very good|very bad|worst app|love it|hate it|fine|well done|excellent|perfect|amazing|horrible)$/i;
  if (noiseWords.test(trimmed)) return true;

  return false;
}

// 将评论数组拆分为等大小的批次。
// 每个批次包含 batchSize 条评论（最后一组可能更少）。
function splitIntoBatches(reviews, batchSize) {
  const batches = [];
  for (let i = 0; i < reviews.length; i += batchSize) {
    const batch = reviews.slice(i, i + batchSize);
    batches.push(batch.map((review, idx) => ({
      ...review,
      batchIndex: batches.length,
      originalIndex: i + idx
    })));
  }
  return batches;
}

// 并发控制：同时运行 limit 个异步任务。
// 一个完成后立即启动下一个，保持并发数恒定为 limit。
async function runWithConcurrency(items, limit, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await fn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// 调用 DeepSeek API 分析单批评论。
// 构造 system + user prompt，让 DeepSeek 按模板进行语义分类。
export async function analyzeBatch(batch, template, apiKey, model, promptOptions = {}) {
  const { temperature = 0.1, maxTokens = 8192, systemPrompt: customSystemPrompt, userPromptTemplate, promptVersion, providerId } = promptOptions;
  let systemPrompt = customSystemPrompt || buildSystemPrompt(template, promptVersion);
  // 体征list模式：自定义 prompt 会绕过 buildSystemPrompt 中的注入逻辑，这里兜底
  if (template.mode === '体征list') {
    systemPrompt = injectLevel3ToPrompt(systemPrompt);
  }
  const userPrompt = userPromptTemplate
    ? userPromptTemplate.replace('__BATCH_SIZE__', String(batch.length)).replace('__REVIEWS_JSON__', JSON.stringify(batch.map((review, idx) => ({ index: idx, starRating: review.starRating || 0, text: review.reviewText || '' })), null, 2))
    : buildUserPrompt(batch);

  const content = await callLLM({
    providerId,
    apiKey,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    maxTokens
  });

  return parseClassificationResponse(content, batch, template);
}

// 构造 System Prompt：定义角色、模板结构、输出格式。
// 目标是让 DeepSeek 严格按 JSON 格式输出分类结果。
// 根据模板维度生成维度描述文本
function generateDimensionsDesc(template) {
  return template.dimensions.map((dim) => {
    // 过滤掉无意义的标签：id 为空或 name 为空的标签不传给 DeepSeek
    const validTags = (dim.tags || []).filter((tag) => tag.id && tag.name);
    if (validTags.length === 0) return '';
    const tagsDesc = validTags.map((tag) => {
      const polarity = tag.polarity ? `[${tag.polarity}] ` : "";
      const meaning = tag.productMeaning ? ` — ${tag.productMeaning}` : "";
      return `  ${polarity}"${tag.name}"${meaning}`;
    }).join("\n");
    return `- ${dim.name}（${dim.productMeaning || ""}）：\n${tagsDesc}`;
  }).filter(Boolean).join("\n");
}

// 体征list模式：向 system prompt 注入 3 级分类规则和更新后的输出格式。
// 如果 prompt 已有 level3 规则则跳过，避免重复注入。
function injectLevel3ToPrompt(prompt) {
  if (prompt.includes('3级分类')) return prompt;
  const level3Rules = `
10. **3级分类（仅体征list模式）**：对每条评论额外输出一个可选的 level3 字段，从以下 5 个固定类别中选择最匹配的一个。评论不明确属于任何类别则设为 null：
   - **需求/建议**：用户提出对 APP 有帮助的具体改变方向，包括新增、支持、优化、减少、取消、恢复、配置某能力。也包括明确的隐性需求——用户指出某个具体能力缺失、不支持、无法设置、没有某语言/主题/格式/尺寸/导入来源/导出能力。
   - **吐槽**：用户表达不满、抱怨、负面评价、价格/广告/订阅/体验不爽，但没有提出明确可执行的改变方向。不要把普通负面反馈自动推导成需求/建议。
   - **bug**：用户描述已有功能异常、失败、报错、崩溃、卡死、结果错误、文件打不开、保存失败、导入失败、转换失败。判断重点：功能本应可用，但没有按预期工作。
   - **不会操作**：用户不知道怎么用、找不到入口、不理解流程、询问如何操作或误解使用方式。如果评论明确表达某能力不存在或不支持，优先判为需求/建议。
   - **与程序无关**：评论无法归因到 APP 功能、体验、BUG、需求、广告、订阅、价格、语言、UI 或操作问题。

输出格式中每条评论增加 "level3" 字段：值必须为 "bug"/"需求/建议"/"不会操作"/"与程序无关"/"吐槽" 或 null。
示例：[{"reviewIndex": 0, "classifications": [...], "suggestions": [...], "level3": "bug"}, {"reviewIndex": 1, "classifications": [], "suggestions": [], "level3": null}]`;
  // 如果存在 ## 输出格式 锚点，注入到它之前；否则追加到末尾
  if (prompt.includes('## 输出格式')) {
    return prompt.replace('## 输出格式', level3Rules + '\n\n## 输出格式');
  }
  return prompt + '\n' + level3Rules;
}

// 从版本文件中加载指定版本的 prompt 模板。
// 返回 promptTemplate 字符串（含 ${dimensionsDesc} 占位符），若版本不存在返回 null。
function loadPromptTemplate(version) {
  try {
    const versions = JSON.parse(readFileSync(PROMPT_VERSIONS_FILE, "utf8"));
    const v = versions.find((v) => v.version === version);
    if (v) return v.promptTemplate;
  } catch {}
  return null;
}

// 构造 System Prompt：定义角色、模板结构、输出格式。
// version 可选 — 传入则从 data/prompts/system-prompt-versions.json 加载指定版本；
// 不传则使用硬编码的最新版本（与版本文件 current 版本保持一致）。
function buildSystemPrompt(template, version) {
  const dimensionsDesc = generateDimensionsDesc(template);
  const promptTemplate = loadPromptTemplate(version);
  let prompt;
  if (promptTemplate) {
    prompt = promptTemplate.replace("${dimensionsDesc}", dimensionsDesc);
  } else {
    prompt = `你是一个专业的 APP 用户评论分析助手。请根据以下模板维度与标签，对每条评论进行语义理解和分类。

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
6. **note 补充信息**：按标签极性分级要求。
	   **需求标签（必填 note）**：评论命中需求标签时，note 必须填写用户具体建议的功能或改进点（如"please add dark mode" → "增加深色模式"），不能留空。
	   **正向/负向标签（有细节就填）**：只有评论包含标签名之外的具体细节时才填。
		   - 正向：用户具体喜欢什么？（如"converts 50 pages in 3 seconds" + "转换速度快" → "50页3秒转完"）
		   - 负向：用户具体抱怨什么？（如"full screen ad every time I click convert" + "广告多" → "每次点转换都弹全屏广告"）
	   **中性标签（选填）**：用户的具体场景或动机，有就填（如"using this to scan my ID for exam submission" + "办公/学习场景" → "扫描证件提交考试"）。
	   **禁止填 note**：评论内容已被标签名完全覆盖，无额外信息。如"too many ads"+广告多、"very good app"+满意/好评、"crashes every time"+闪退/崩溃、"waste of money"+付费不满，这些情况 note 留空。复述标签名也留空。判断标准：note 和标签名表达的是同一件事就留空。
	7. **suggestions 用户建议提取（每条评论独立判断）**：
	   对每条评论，如果用户表达了以下任一内容，提取到 suggestions 数组：
	   - 明确的功能需求（"please add dark mode", "need batch convert"）
	   - 隐含的改进诉求（"too slow" → "优化转换速度"）
	   - 与其他 App 对比后提出的期望（"like Adobe does" → "对标 Adobe 的功能"）
	   - 对现有功能的改进意见（"crop feature is hard to use" → "改进裁剪交互"）
	   suggestions 数组中每个元素格式：
	   { "description": "用户具体建议的一句话描述（中文，简洁）", "category": "功能/UI" 或 "性能" 或 "内容" 或 "服务" 或 "付费" 或 "广告" 或 "其他" }
	   如果评论没有表达任何建议/需求，suggestions 为空数组 []。
	   注意：suggestions 与 classifications 中的需求标签互补。需求标签关注用户需求类别，suggestions 关注用户提出的具体改进点。

8. **维度区分指南**：当一条评论可能同时命中"功能完整性"和"功能质量"两个维度时，按以下标准区分：
   - 功能完整性：关注"功能是否存在、链路是否通畅"（有没有这个能力、能不能走完流程）
   - 功能质量：关注"功能执行完成后的结果好坏"（输出清不清晰、排版对不对、比例是否正常）
   例如："cannot convert images to PDF" → 功能完整性（能力缺失，任务无法执行）
   "converted but PDF is blurry" → 功能质量（任务完成了但结果不满意）
   "app crashes when I try to save" → 技术稳定性（崩溃），不是功能完整性也不是功能质量
   "I cannot find the file after saving" → UI/交互（找不到保存位置），不是功能质量
9. **"其他"标签使用规则**：名称为"其他XXX"的标签是兜底选项，仅当评论明确不属于该维度下任何具体标签时才使用。命中"其他"标签时必须：
   - note 必填，简要说明评论的具体内容
   - 在 note 末尾附加 [新标签候选: XXX]，建议一个可新增的具体标签名
   例如：评论"the OCR feature misreads Chinese characters"命中"其他功能质量反馈" → note: "OCR识别中文字符出错 [新标签候选: OCR识别错误]"

## 模板维度与标签

${dimensionsDesc}

## 输出格式
请严格按以下 JSON 数组格式输出：
[{"reviewIndex": 0, "classifications": [{"dimension": "维度名称", "tag": "标签名称", "confidence": 0.85, "note": "具体内容（可选）"}], "suggestions": [{"description": "用户建议的一句话描述", "category": "功能/UI"}]}, {"reviewIndex": 1, "classifications": [], "suggestions": []}]`;
  }
  if (template.mode === '体征list') {
    prompt = injectLevel3ToPrompt(prompt);
  }
  return prompt;
}

// 构造 User Prompt：传入待分析的评论批次。
function buildUserPrompt(batch) {
  const reviews = batch.map((review, idx) => ({
    index: idx,
    starRating: review.starRating || 0,
    text: review.reviewText || ''
  }));

  return `以下是需要分类的 ${batch.length} 条评论（每条包含 index、starRating 和 text）：\n\n${JSON.stringify(reviews, null, 2)}\n\n请输出分类结果 JSON 数组：`;
}

// 校验 level3 字段值是否合法。返回合法值或 null。
function validateLevel3(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && LEVEL3_VALUES.includes(value.trim())) return value.trim();
  return null;
}

// 解析 DeepSeek 返回的分类 JSON。
// DeepSeek 可能输出纯 JSON 或 markdown 代码块包裹的 JSON，需要兼容处理。
function parseClassificationResponse(content, batch, template) {
  let jsonText = content.trim();

  // 去除可能的 markdown 代码块标记
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  let classifications;
  try {
    classifications = JSON.parse(jsonText);
  } catch (error) {
    // 尝试提取 JSON 数组部分
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        classifications = JSON.parse(arrayMatch[0]);
      } catch {
        throw new Error(`AI 返回内容无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
      }
    } else {
      throw new Error(`AI 返回内容无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
    }
  }

  if (!Array.isArray(classifications)) {
    throw new Error('AI 返回的 JSON 不是数组格式。');
  }

  // 将 DeepSeek 返回的 reviewIndex 映射回实际评论
  const result = [];
  const dimNameToId = new Map();
  const tagNameToId = new Map();
  for (const dim of template.dimensions) {
    dimNameToId.set(dim.name, dim.id);
    for (const tag of (dim.tags || [])) {
      tagNameToId.set(`${dim.id}:${tag.name}`, tag.id);
    }
  }

  // 无意义内容映射
  const MEANINGLESS_DIM = '无意义内容';
  const MEANINGLESS_ID = '_meaningless';

  for (const item of classifications) {
    const idx = item.reviewIndex;
    if (idx === undefined || idx >= batch.length) continue;

    const review = batch[idx];
    const mapped = (item.classifications || []).map((c) => {
      // 处理无意义内容维度
      if (c.dimension === MEANINGLESS_DIM) {
        return {
          dimensionId: MEANINGLESS_ID,
          dimensionName: MEANINGLESS_DIM,
          tagId: MEANINGLESS_ID,
          tagName: '无意义',
          confidence: typeof c.confidence === 'number' ? c.confidence : 0.5
        };
      }
      const dimId = dimNameToId.get(c.dimension) || '';
      const tagId = tagNameToId.get(`${dimId}:${c.tag}`) || '';
      // DeepSeek 提出了模板中不存在的维度或标签 → 标记为建议，交由人工确认
      const isSuggested = !!(c.dimension && (!dimId || !tagId));
      return {
        dimensionId: dimId,
        dimensionName: c.dimension || '',
        tagId: tagId,
        tagName: c.tag || '',
        confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
        suggested: isSuggested || undefined
      };
    }).filter((c) => c.confidence >= 0.5 && c.dimensionName);

    const hasSuggestions = mapped.some((c) => c.suggested);

    result.push({
      ...review,
      classifications: mapped,
      isLowConfidence: hasSuggestions,
      level3: validateLevel3(item.level3)
    });
  }

  // DeepSeek 未返回分类的评论也放入结果，标记为低置信度
  const returnedIndices = new Set(classifications.map((c) => c.reviewIndex));
  for (let i = 0; i < batch.length; i++) {
    if (!returnedIndices.has(i)) {
      result.push({
        ...batch[i],
        classifications: [],
        isLowConfidence: false, // 待后续按阈值判断
        level3: null
      });
    }
  }

  return result;
}

// 基于分类结果计算维度/标签的统计分布。
function calculateDimensionStats(reviews, template) {
  const stats = template.dimensions.map((dim) => {
    const tagCounts = new Map();
    for (const tag of (dim.tags || [])) {
      tagCounts.set(tag.id, 0);
    }

    let dimCount = 0;
    for (const review of reviews) {
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
  let meaninglessCount = 0;
  for (const review of reviews) {
    if (review.isLowConfidence) continue;
    for (const c of (review.classifications || [])) {
      if (c.dimensionId === '_meaningless') {
        meaninglessCount += 1;
      }
    }
  }
  if (meaninglessCount > 0) {
    stats.push({
      dimensionId: '_meaningless',
      dimensionName: '无意义',
      count: meaninglessCount,
      tags: [{ tagId: '_meaningless', tagName: '无意义', count: meaninglessCount }]
    });
  }

  return stats.filter((dim) => dim.count > 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
