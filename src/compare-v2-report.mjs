import { callLLM } from './llm-client.mjs';

// 竞品对比 V2 报告生成器。
//
// 串行三个阶段：
//   1. 服务端预聚合 — 按极性聚合 likes/suggestions/complaints/usageMotivations
//   2. 高赞评论情感标记 — DeepSeek 逐条标记 <like>/<dislike> 片段
//   3. V2 洞察报告 — DeepSeek 基于聚合数据生成叙述
//
// 参数：
//   analysisIds      要对比的分析任务 ID 列表
//   analysisStore     AnalysisStore 实例
//   downloadStore     LocalJobStore 实例（下载任务）
//   csvDataMap        Map<analysisId, csvContent> 用户上传的高赞评论 CSV
//   apiKey            DeepSeek API Key（从分析任务中读取）

export async function buildCompareV2Report({ analysisIds, analysisStore, downloadStore, csvDataMap, apiKey, providerId = 'deepseek', model = 'deepseek-v4-pro' }) {
  // ===== 前置校验 =====
  if (!Array.isArray(analysisIds) || analysisIds.length < 2) {
    throw new Error('请至少选择 2 个已完成的解析任务进行对比。');
  }

  // 加载所有 V1 结果，验证同模板
  const analyses = [];
  for (const id of analysisIds) {
    const analysis = analysisStore.get(id);
    if (!analysis) throw new Error(`分析任务 ${id} 不存在。`);
    if (analysis.status !== 'completed') throw new Error(`分析任务 ${id} 尚未完成。`);

    const result = await analysisStore.loadResults(id);
    if (!result) throw new Error(`分析任务 ${id} 的结果文件不存在。`);

    if (analyses.length > 0 && result.template?.id !== analyses[0].result.template?.id) {
      throw new Error('所选分析任务使用了不同的模板，无法对比。请选择同一模板下的 App。');
    }

    analyses.push({ analysis, result });
  }

  const template = analyses[0].result.template || {};

  // ===== 阶段 1：服务端预聚合 =====
  const appsPreAgg = analyses.map(({ analysis, result }) => {
    const reviews = result.reviews || [];
    const dims = (result.template?.dimensions || []);

    // 构建 tagId → { name, dimName, dimId } 的索引
    const tagMeta = new Map();
    for (const dim of dims) {
      for (const tag of (dim.tags || [])) {
        tagMeta.set(tag.id, {
          tagName: tag.name,
          dimName: dim.name,
          dimId: dim.id,
          productMeaning: dim.productMeaning || ''
        });
      }
    }

    // likes: 正向标签聚合
    const likesMap = new Map();
    // complaints: 负向标签聚合
    const complaintsMap = new Map();
    // usageMotivations: 中性标签聚合
    const usageMap = new Map();
    // suggestions: 聚合 suggestions[]
    const suggestionsMap = new Map();

    for (const review of reviews) {
      if (review.isLowConfidence) continue;

      // 聚合 classifications
      for (const c of (review.classifications || [])) {
        const meta = tagMeta.get(c.tagId);
        if (!meta) continue;

        const pol = c.polarity || '中性';
        if (pol === '正向') {
          aggregateToMap(likesMap, meta.tagName, meta.dimName, c.note);
        } else if (pol === '负向') {
          aggregateToMap(complaintsMap, meta.tagName, meta.dimName, c.note);
        } else {
          aggregateToMap(usageMap, meta.tagName, meta.dimName, null);
        }
      }

      // 聚合 suggestions
      for (const s of (review.suggestions || [])) {
        if (!s.description) continue;
        const key = s.description.trim();
        const cat = s.category || '其他';
        if (!suggestionsMap.has(key)) {
          suggestionsMap.set(key, { description: key, category: cat, count: 0 });
        }
        suggestionsMap.get(key).count += 1;
      }
    }

    return {
      analysisId: analysis.id,
      app: analysis.app || {},
      storeUrl: resolveStoreUrl(analysis),
      totalReviews: result.summary?.totalReviews || 0,
      classifiedCount: result.summary?.classifiedCount || 0,
      usageMotivations: sortByCount(Array.from(usageMap.values())),
      likes: sortByCount(Array.from(likesMap.values())),
      suggestions: sortByCount(Array.from(suggestionsMap.values())),
      complaints: sortByCount(Array.from(complaintsMap.values()))
    };
  });

  // ===== 阶段 2：高赞评论情感标记（用户上传 CSV） =====
  for (const appData of appsPreAgg) {
    const csvContent = csvDataMap?.get?.(appData.analysisId) || csvDataMap?.[appData.analysisId];
    if (!csvContent) {
      appData.topReviews = [];
      appData.topDataReviewCount = 0;
      continue;
    }

    const topReviews = parseCsvContent(csvContent);

    if (topReviews.length === 0) {
      appData.topReviews = [];
      appData.topDataReviewCount = 0;
      continue;
    }

    appData.topDataReviewCount = topReviews.length;

    try {
      const annotated = await analyzeTopReviewsSentiment(topReviews, apiKey, providerId, model);
      appData.topReviews = annotated;
    } catch (error) {
      appData.topReviews = topReviews.map((r) => ({
        originalText: r.text,
        annotatedHtml: escapeHtml(r.text),
        starRating: r.starRating,
        votes: r.votes,
        sentiment: '未知'
      }));
      appData.topReviewError = error.message;
    }
  }

  // ===== 阶段 3：V2 洞察报告（DeepSeek 生成叙述） =====
  let insightResult = null;
  try {
    insightResult = await generateInsights(appsPreAgg, template, apiKey, providerId, model);
  } catch (error) {
    insightResult = {
      error: error.message,
      summary: { userPurposes: '', insights: '' },
      apps: appsPreAgg.map((a) => ({
        analysisId: a.analysisId,
        suggestionsNarrative: '',
        likesNarrative: '',
        complaintsNarrative: '',
        userFocus: { coreConcerns: [], advantages: [] }
      })),
      crossCutting: { commonStrengths: [], commonProblems: [], differentiators: [] }
    };
  }

  const summaryResult = insightResult.summary || {};

  // ===== 合并返回 =====
  return {
    templateName: template.name || '',
    summary: {
      userPurposes: summaryResult.userPurposes || '',
      insights: summaryResult.insights || ''
    },
    apps: appsPreAgg.map((appData, idx) => {
      const insightApps = insightResult.apps || [];
      const insight = insightApps.find((ia) => ia.analysisId === appData.analysisId)
        || insightApps[idx]
        || {};
      return {
        analysisId: appData.analysisId,
        appName: appData.app?.name || '',
        appIcon: appData.app?.icon || '',
        storeUrl: appData.storeUrl || '',
        totalReviews: appData.totalReviews,
        classifiedCount: appData.classifiedCount,
        topDataReviewCount: appData.topDataReviewCount || 0,
        usageMotivations: appData.usageMotivations.slice(0, 5),
        likes: appData.likes.slice(0, 15),
        suggestions: appData.suggestions.slice(0, 20),
        complaints: appData.complaints.slice(0, 15),
        topReviews: (appData.topReviews || []).slice(0, 10),
        suggestionsNarrative: insight.suggestionsNarrative || '',
        likesNarrative: insight.likesNarrative || '',
        complaintsNarrative: insight.complaintsNarrative || '',
        userFocus: insight.userFocus || { coreConcerns: [], advantages: [] }
      };
    }),
    crossCutting: insightResult.crossCutting || { commonStrengths: [], commonProblems: [], differentiators: [] }
  };
}

// ===== 辅助函数 =====

// 将 note 聚合到 Map<tagName, { tagName, dimName, count, examples[] }>
function aggregateToMap(map, tagName, dimName, note) {
  if (!map.has(tagName)) {
    map.set(tagName, { tagName, dimName, count: 0, examples: [] });
  }
  const entry = map.get(tagName);
  entry.count += 1;
  if (note && note.trim() && !entry.examples.includes(note.trim())) {
    entry.examples.push(note.trim());
    if (entry.examples.length > 5) entry.examples.shift();
  }
}

function sortByCount(arr) {
  return arr.sort((a, b) => b.count - a.count);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveStoreUrl(analysis) {
  const jobId = (analysis.downloadJobIds || [])[0];
  if (!jobId) return '';
  return `https://play.google.com/store/apps/details?id=${analysis.app?.id || ''}`;
}

// ===== CSV 解析（从用户上传的字符串） =====

function parseCsvContent(text) {
  try {
    // 去除 BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length < 2) return [];

    // 第 0 行是标题：评论原文,评分等级,点赞用户,评论时间
    const reviews = [];
    for (let i = 1; i < lines.length; i++) {
      const parsed = parseCsvLine(lines[i]);
      if (parsed.length < 4) continue;
      const textContent = parsed[0]?.trim();
      if (!textContent) continue;

      const starStr = parsed[1]?.trim() || '';
      const starRating = parseStarRating(starStr);
      const votes = parseInt(String(parsed[2] || '').trim().replace(/[^\d]/g, ''), 10) || 0;

      reviews.push({
        index: reviews.length,
        text: textContent,
        starRating,
        votes
      });
    }
    return reviews;
  } catch {
    return [];
  }
}

// 简单 CSV 行解析（处理逗号分隔，字段可能不含引号）
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseStarRating(str) {
  if (!str) return 0;
  // 支持 "5🌟"、"5"、"5星" 等格式
  const match = str.match(/(\d+)/);
  if (match) {
    const n = parseInt(match[1], 10);
    return Math.min(5, Math.max(1, n));
  }
  return 0;
}

// ===== 阶段 2：高赞评论情感标记 =====

async function analyzeTopReviewsSentiment(reviews, apiKey, providerId, model) {
  if (reviews.length === 0) return [];

  const systemPrompt = `你是用户评论情感分析助手。请对以下高赞评论进行片段级情感标注。

规则：
1. 用 <like>...</like> 包裹用户明确喜欢/满意/赞扬的内容
2. 用 <dislike>...</dislike> 包裹用户明确厌恶/抱怨/不满的内容
3. 每条评论最多标记 2-3 个关键短语，不要过度标记
4. 只标记情感倾向非常明确的内容，模糊或中性描述不标记
5. 如果某条评论没有明显情感倾向，可以不标记任何内容
6. 每条评论额外输出 sentiment 字段：正面/负面/混合
7. 只输出 JSON 数组，不要其他文字`;

  const reviewsInput = reviews.map((r) => ({
    index: r.index,
    text: r.text,
    starRating: r.starRating,
    votes: r.votes
  }));

  const userPrompt = `输入评论（来自 top_data，带点赞数和评分）：\n${JSON.stringify(reviewsInput, null, 2)}\n\n输出格式：\n[{"index": 0, "annotated": "...", "sentiment": "正面"}, ...]`;

  const content = await callDeepSeek(systemPrompt, userPrompt, apiKey);
  const parsed = parseJsonResponse(content, '高赞评论情感标记');

  if (!Array.isArray(parsed)) {
    throw new Error('高赞评论情感标记返回格式不是数组');
  }

  return parsed.map((item) => {
    const review = reviews.find((r) => r.index === item.index);
    let annotatedHtml = item.annotated || (review ? review.text : '');
    // 将 <like>/<dislike> 转换为 HTML mark 标签
    annotatedHtml = escapeHtmlKeepTags(annotatedHtml);
    annotatedHtml = annotatedHtml
      .replace(/&lt;like&gt;/g, '<mark class="like">')
      .replace(/&lt;\/like&gt;/g, '</mark>')
      .replace(/&lt;dislike&gt;/g, '<mark class="dislike">')
      .replace(/&lt;\/dislike&gt;/g, '</mark>');

    return {
      originalText: review?.text || '',
      annotatedHtml,
      starRating: review?.starRating || 0,
      votes: review?.votes || 0,
      sentiment: item.sentiment || '未知'
    };
  });
}

// 先 HTML 转义，但将 <like>/<dislike> 转换为 <mark class="like"> / <mark class="dislike">
function escapeHtmlKeepTags(text) {
  const tagMap = {
    '<like>': '<mark class="like">',
    '</like>': '</mark>',
    '<dislike>': '<mark class="dislike">',
    '</dislike>': '</mark>'
  };

  // 替换特殊标记为占位符
  const placeholders = [];
  let i = 0;
  text = text.replace(/<\/?(?:like|dislike)>/g, (match) => {
    const ph = `__TAG_PH_${i}__`;
    placeholders.push(tagMap[match] || match);
    i++;
    return ph;
  });

  // 转义其余内容
  text = escapeHtml(text);

  // 恢复标记为真实 HTML
  for (let j = 0; j < placeholders.length; j++) {
    text = text.replace(`__TAG_PH_${j}__`, placeholders[j]);
  }

  return text;
}

// ===== 阶段 3：V2 洞察报告 =====

async function generateInsights(apps, template, apiKey, providerId, model) {
  const systemPrompt = '你是资深产品分析师，擅长从用户评论分类数据中提炼产品洞察。请只输出 JSON，不要其他文字。';

  const dimsDesc = (template.dimensions || []).map((dim) => {
    const tagsList = (dim.tags || []).map((t) => t.name).join('、');
    return `  - ${dim.name}（${dim.productMeaning || ''}）：${tagsList}`;
  }).join('\n');

  let appSections = '';
  for (const app of apps) {
    appSections += `
## ${app.app?.name || '未知 App'}
总评论 ${app.totalReviews} 条，已分类 ${app.classifiedCount} 条，高赞评论 ${app.topDataReviewCount || 0} 条

用户主要使用动机：${(app.usageMotivations || []).map((m) => `${m.tagName}(${m.count})`).join('、')}

用户喜欢 Top 5：
${(app.likes || []).slice(0, 5).map((l) => `- ${l.tagName}(${l.count})${l.examples.length > 0 ? ` — "${l.examples[0].slice(0, 40)}"` : ''}`).join('\n')}

用户建议（去重 ${(app.suggestions || []).length} 条）：
${(app.suggestions || []).slice(0, 8).map((s) => `- ${s.description}(${s.count}次) [${s.category}]`).join('\n')}

用户抱怨 Top 5：
${(app.complaints || []).slice(0, 5).map((c) => `- ${c.tagName}(${c.count})${c.examples.length > 0 ? ` — "${c.examples[0].slice(0, 40)}"` : ''}`).join('\n')}
`;
  }

  const userPrompt = `## 分析模板
模板名称：${template.name || ''}
维度与标签说明：
${dimsDesc}
${appSections}

## 请输出 JSON：
{
  "summary": {
    "userPurposes": "看完所有App后的统一总结：用户群体画像、核心使用目的、常见使用场景（2-4句话中文）",
    "insights": "综合洞察：用户共同关注什么、共同抱怨什么及原因、共同喜欢什么功能、哪些可作为优势点（竞品目前不支持的差异化功能）（3-5句话中文）"
  },
  "apps": [
    {
      "analysisId": "...",
      "suggestionsNarrative": "该App用户建议的叙述性总结（2-4句话中文）。如果某条建议被多人提及，在文案中用[数字人提到]标注，例如'有用户希望增加批量转换功能[8人提到]'",
      "likesNarrative": "该App用户喜欢的功能特点叙述（2-3句话中文）",
      "complaintsNarrative": "该App用户主要抱怨点叙述（2-3句话中文）",
      "userFocus": {
        "coreConcerns": ["该App用户的核心关注点（2-4条，每条15-30字）"],
        "advantages": ["该App的可作为优势点，竞品没有或少见的（2-4条，每条15-30字）"]
      }
    }
  ],
  "crossCutting": {
    "commonStrengths": ["跨App共同优势（1-3条）"],
    "commonProblems": ["跨App共同问题（1-3条）"],
    "differentiators": [{"appName": "XXX", "strength": "该App独特优势描述"}]
  }
}

指令：
- summary 是看完所有App后的统一总结，不要每个App分开写
- userFocus.coreConcerns 基于喜欢+抱怨推断用户最在意什么
- userFocus.advantages 要对比所有App后找差异化
- 所有叙述用中文，简洁具体
- 只输出 JSON`;

  const content = await callLLM({ providerId, apiKey, model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: 0.3, maxTokens: 4096, retries: 2 });
  return parseJsonResponse(content, 'V2 洞察报告');
}

function parseJsonResponse(content, label) {
  let jsonText = content.trim();

  // 去除 markdown 代码块标记
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim();
  }

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch {
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/) || jsonText.match(/\{[\s\S]*\}/);
    if (arrayMatch) {
      try {
        result = JSON.parse(arrayMatch[0]);
      } catch {
        throw new Error(`${label} 返回内容无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
      }
    } else {
      throw new Error(`${label} 返回内容无法解析为 JSON。原始响应前 300 字符：${content.slice(0, 300)}`);
    }
  }

  return result;
}

