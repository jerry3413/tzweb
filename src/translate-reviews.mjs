import { callLLM } from './llm-client.mjs';

const DEFAULT_TRANSLATION_PROMPT = `你是一个专业的 APP 用户评论翻译助手。请将以下用户评论翻译成目标语言。

要求：
1. 保持原文的语气、情感和风格
2. 俚语和口语化表达应翻译为目标语言中对应的自然表达
3. 只输出翻译后的文本，不要添加任何解释或注释
4. 如果原文已经是目标语言，则原样输出`;

/**
 * 翻译一批评论。每批调用一次 LLM，返回每条评论的翻译结果。
 *
 * @param {Object} options
 * @param {Array<{index: number, text: string}>} options.reviews - 待翻译的评论列表
 * @param {string} options.apiKey - API Key
 * @param {string} [options.providerId='deepseek'] - AI 提供商 ID
 * @param {string} [options.model='deepseek-v4-pro'] - 模型名称
 * @param {string} [options.targetLang='简体中文'] - 目标语言
 * @param {number} [options.temperature=0.1] - 生成温度
 * @param {number} [options.maxTokens=4096] - 最大 Token 数
 * @param {string} [options.systemPrompt] - 自定义翻译 prompt
 * @returns {Promise<Array<{index: number, translatedText: string}>>}
 */
export async function translateBatch(options) {
  const {
    reviews,
    apiKey,
    providerId = 'deepseek',
    model = 'deepseek-v4-pro',
    targetLang = '简体中文',
    temperature = 0.1,
    maxTokens = 4096,
    systemPrompt: customSystemPrompt,
    customApiBase
  } = options;

  if (!reviews || reviews.length === 0) {
    return [];
  }

  const systemPrompt = customSystemPrompt || DEFAULT_TRANSLATION_PROMPT;

  const userPrompt = `目标语言：${targetLang}

以下是需要翻译的 ${reviews.length} 条评论，请将每条翻译成${targetLang}，按 JSON 数组格式输出：

${JSON.stringify(reviews.map((r) => ({ index: r.index, text: r.text })), null, 2)}

请严格按以下 JSON 数组格式输出（每条一个元素）：
[{"index": 0, "translatedText": "翻译后的文本"}, ...]`;

  const content = await callLLM({
    providerId,
    apiKey,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature,
    maxTokens,
    customApiBase
  });

  return parseTranslationResponse(content, reviews.length);
}

/**
 * 翻译全部评论（自动分批次）。
 *
 * @param {Object} options
 * @param {Array<{reviewId: string, reviewText: string}>} options.allReviews - 全部待翻译评论
 * @param {number} [options.batchSize=15] - 每批数量
 * @param {Function} [options.onProgress] - 进度回调 ({ completed, total })
 * @returns {Promise<Map<string, string>>} reviewId → translatedText
 */
export async function translateAllReviews(options) {
  const {
    allReviews,
    apiKey,
    providerId,
    model,
    targetLang,
    temperature,
    maxTokens,
    systemPrompt,
    batchSize = 15,
    parallelTasks = 3,
    customApiBase,
    onProgress
  } = options;

  const resultMap = new Map();
  const batches = [];
  for (let i = 0; i < allReviews.length; i += batchSize) {
    batches.push(allReviews.slice(i, i + batchSize));
  }

  const total = allReviews.length;
  let completed = 0;

  async function processBatch(batch) {
    const batchItems = batch.map((r, i) => ({ index: i, text: r.reviewText || '' }));
    try {
      const results = await translateBatch({
        reviews: batchItems,
        apiKey,
        providerId,
        model,
        targetLang,
        temperature,
        maxTokens,
        systemPrompt,
        customApiBase
      });
      for (const item of results) {
        const review = batch[item.index];
        if (review && item.translatedText) {
          resultMap.set(review.reviewId, item.translatedText);
        }
      }
    } catch (error) {
      console.error(`翻译批次失败：${error.message}`);
    }
    completed += batch.length;
    if (onProgress) {
      onProgress({ completed, total });
    }
  }

  // 并行处理批次，使用简单的信号量模式
  for (let i = 0; i < batches.length; i += parallelTasks) {
    const chunk = batches.slice(i, i + parallelTasks);
    await Promise.all(chunk.map(processBatch));
  }

  return resultMap;
}

function parseTranslationResponse(content, expectedCount) {
  let jsonText = content.trim();

  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  let results;
  try {
    results = JSON.parse(jsonText);
  } catch {
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        results = JSON.parse(arrayMatch[0]);
      } catch {
        throw new Error(`翻译结果无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
      }
    } else {
      throw new Error(`翻译结果无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
    }
  }

  if (!Array.isArray(results)) {
    throw new Error('翻译结果不是 JSON 数组格式。');
  }

  return results
    .filter((r) => typeof r.index === 'number' && r.index < expectedCount && r.translatedText)
    .map((r) => ({ index: r.index, translatedText: String(r.translatedText).trim() }));
}
