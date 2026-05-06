import { mergeCSVFiles } from './csv-reader.mjs';

// DeepSeek 客户端：将下载好的评论按模板维度进行 AI 语义分类。
//
// 核心流程：
//   1. 读取并合并 CSV → 去重评论列表
//   2. 按 ~100 条/批 拆分评论
//   3. 控制并发（默认 20 路）逐批调用 DeepSeek API
//   4. 汇总分类结果并计算维度/标签统计
//
// 每条评论可能命中多个维度和多个标签，每个标签分配 0-1 的置信度。
// 所有分类的置信度均低于阈值的评论会被标记为"低置信度"（isLowConfidence），供后续人工确认。

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

// 启动一次完整的评论解析任务。
// options 参数说明见下方。
export async function runReviewAnalysis(options) {
  const {
    analysisId,
    template,
    csvFilePaths,
    apiKey,
    model = 'deepseek-chat',
    confidenceThreshold = 0.6,
    parallelTasks = 20,
    temperature = 0.1,
    maxTokens = 8192,
    systemPrompt: customSystemPrompt,
    userPromptTemplate: customUserPromptTemplate,
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

  // ===== 阶段 2：拆分为批次 =====
  const batchSize = Math.max(1, Math.ceil(reviews.length / Math.max(1, Math.ceil(reviews.length / 100))));
  const batches = splitIntoBatches(reviews, batchSize);
  // 实际并发数不超过批次数和设定值
  const actualConcurrency = Math.min(parallelTasks, batches.length);

  onProgress({
    progress: 10,
    currentStep: 'Starting DeepSeek analysis',
    totalBatches: batches.length,
    batchSize
  });

  // ===== 阶段 3：并行调用 DeepSeek =====
  const classifiedReviews = [];
  const errors = [];
  let completedBatches = 0;

  await runWithConcurrency(batches, actualConcurrency, async (batch, batchIndex) => {
    try {
      const results = await analyzeBatch(batch, template, apiKey, model, { temperature, maxTokens, systemPrompt: customSystemPrompt, userPromptTemplate: customUserPromptTemplate });
      classifiedReviews.push(...results);
    } catch (error) {
      // 单批失败记录但不中断整体任务
      errors.push({ batchIndex, count: batch.length, error: error.message });
      // 失败批次的评论归类到低置信度列表里
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
async function analyzeBatch(batch, template, apiKey, model, promptOptions = {}, retries = 3) {
  const { temperature = 0.1, maxTokens = 8192, systemPrompt: customSystemPrompt, userPromptTemplate } = promptOptions;
  const systemPrompt = customSystemPrompt || buildSystemPrompt(template);
  const userPrompt = userPromptTemplate
    ? userPromptTemplate.replace('__BATCH_SIZE__', String(batch.length)).replace('__REVIEWS_JSON__', JSON.stringify(batch.map((review, idx) => ({ index: idx, starRating: review.starRating || 0, text: review.reviewText || '' })), null, 2))
    : buildUserPrompt(batch);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(DEEPSEEK_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature,
          max_tokens: maxTokens
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // 4xx 错误（非 429）不重试，直接抛出
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`DeepSeek API 请求被拒绝 (HTTP ${response.status})：${errorText.slice(0, 300)}`);
        }
        throw new Error(`DeepSeek API HTTP ${response.status}：${errorText.slice(0, 200)}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('DeepSeek 返回了空响应内容。');
      }

      return parseClassificationResponse(content, batch, template);
    } catch (error) {
      if (attempt === retries) throw error;
      // 指数退避：1s → 2s → 4s
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}

// 构造 System Prompt：定义角色、模板结构、输出格式。
// 目标是让 DeepSeek 严格按 JSON 格式输出分类结果。
function buildSystemPrompt(template) {
  const dimensionsDesc = template.dimensions.map((dim) => {
    const tagsDesc = (dim.tags || []).map((tag) => `"${tag.name}"`).join('、');
    return `- ${dim.name}（${dim.productMeaning || ''}）：${tagsDesc}`;
  }).join('\n');

  return `你是一个专业的 APP 用户评论分析助手。请根据以下模板维度与标签，对每条评论进行语义理解和分类。

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
        throw new Error(`DeepSeek 返回内容无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
      }
    } else {
      throw new Error(`DeepSeek 返回内容无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
    }
  }

  if (!Array.isArray(classifications)) {
    throw new Error('DeepSeek 返回的 JSON 不是数组格式。');
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
      isLowConfidence: hasSuggestions
    });
  }

  // DeepSeek 未返回分类的评论也放入结果，标记为低置信度
  const returnedIndices = new Set(classifications.map((c) => c.reviewIndex));
  for (let i = 0; i < batch.length; i++) {
    if (!returnedIndices.has(i)) {
      result.push({
        ...batch[i],
        classifications: [],
        isLowConfidence: false // 待后续按阈值判断
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
