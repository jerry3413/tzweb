import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM } from './llm-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RESULTS_FILE = path.join(__dirname, '..', 'data', 'analysis', 'results', '3106030c-506e-41ea-8971-12ef0bab834b.json');
const API_KEY = 'sk-734513ca22fc4ed9838db5a8b3674e8c';
const PROVIDER_ID = 'deepseek';
const MODEL = 'deepseek-v4-pro';
const BATCH_SIZE = 10;
const CONCURRENCY = 80;

const LEVEL3_VALUES = ['bug', '需求/建议', '不会操作', '与程序无关', '吐槽'];

const SYSTEM_PROMPT = `你是一个专业的 APP 用户评论分析助手。请对每条评论进行3级分类。

## 3级分类规则

从以下5个固定类别中选择最匹配的一个。评论不明确属于任何类别则设为 null：

- **需求/建议**：用户提出对 APP 有帮助的具体改变方向，包括新增、支持、优化、减少、取消、恢复、配置某能力。也包括明确的隐性需求——用户指出某个具体能力缺失、不支持、无法设置、没有某语言/主题/格式/尺寸/导入来源/导出能力。
- **吐槽**：用户表达不满、抱怨、负面评价、价格/广告/订阅/体验不爽，但没有提出明确可执行的改变方向。不要把普通负面反馈自动推导成需求/建议。
- **bug**：用户描述已有功能异常、失败、报错、崩溃、卡死、结果错误、文件打不开、保存失败、导入失败、转换失败。判断重点：功能本应可用，但没有按预期工作。
- **不会操作**：用户不知道怎么用、找不到入口、不理解流程、询问如何操作或误解使用方式。如果评论明确表达某能力不存在或不支持，优先判为需求/建议。
- **与程序无关**：评论无法归因到 APP 功能、体验、BUG、需求、广告、订阅、价格、语言、UI 或操作问题。

## 辅助信息

每条评论附带了已有的维度·标签分类结果（人工标注），可作为判断 level3 的参考依据。

## 重要规则

1. 只输出 JSON 数组，不要输出其他文字、解释或 markdown 代码块标记。
2. 每条评论必须输出，即使 level3 为 null 也要出现。
3. 参考现有分类标签来判断，但不要照搬。例如已有"广告·广告多"标签 → level3 应为"吐槽"而非"需求/建议"；已有"闪退/崩溃"标签 → level3 应为"bug"。

## 输出格式

[{"reviewIndex": 0, "level3": "bug"}, {"reviewIndex": 1, "level3": null}, {"reviewIndex": 2, "level3": "吐槽"}]`;

function buildUserPrompt(batch) {
  const items = batch.map((item) => ({
    index: item.index,
    starRating: item.starRating || 0,
    text: item.text || '',
    existingTags: item.existingTags || []
  }));
  return `以下是需要3级分类的 ${batch.length} 条评论。每条包含 index、starRating（星级 1-5）、text（原文）和 existingTags（已有分类标签）：\n\n${JSON.stringify(items, null, 2)}\n\n请输出每条评论的 level3 分类结果：`;
}

function validateLevel3(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && LEVEL3_VALUES.includes(value.trim())) return value.trim();
  return null;
}

function parseLevel3Response(content, batchLength) {
  let jsonText = content.trim();
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonText = codeBlockMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { parsed = JSON.parse(arrayMatch[0]); }
      catch { return null; }
    } else {
      return null;
    }
  }

  if (!Array.isArray(parsed)) return null;

  const result = new Array(batchLength).fill(null);
  for (const item of parsed) {
    const idx = item.reviewIndex;
    if (idx !== undefined && idx < batchLength) {
      result[idx] = validateLevel3(item.level3);
    }
  }
  return result;
}

async function runWithConcurrency(items, limit, fn) {
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
}

async function main() {
  console.log('读取结果文件...');
  const results = JSON.parse(readFileSync(RESULTS_FILE, 'utf8'));
  const reviews = results.reviews || [];

  // 找出缺失 level3 的评论
  const missing = [];
  for (let i = 0; i < reviews.length; i++) {
    const r = reviews[i];
    if (!r.level3) {
      const existingTags = (r.classifications || []).map((c) => `${c.dimensionName}·${c.tagName}`);
      missing.push({
        reviewIndex: i,
        reviewId: r.reviewId,
        text: r.reviewText || '',
        starRating: r.starRating || 0,
        existingTags
      });
    }
  }

  console.log(`共 ${reviews.length} 条评论，${missing.length} 条缺失 level3`);
  if (missing.length === 0) {
    console.log('无需处理。');
    return;
  }

  // 分批
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batchItems = missing.slice(i, i + BATCH_SIZE).map((m, idx) => ({
      index: idx,
      reviewIndex: m.reviewIndex,
      reviewId: m.reviewId,
      text: m.text,
      starRating: m.starRating,
      existingTags: m.existingTags
    }));
    batches.push(batchItems);
  }

  console.log(`分为 ${batches.length} 批（每批 ${BATCH_SIZE} 条），并发 ${CONCURRENCY}\n`);

  let completed = 0;
  let totalUpdated = 0;
  const startTime = Date.now();

  await runWithConcurrency(batches, CONCURRENCY, async (batch, batchIdx) => {
    try {
      const userPrompt = buildUserPrompt(batch);
      const content = await callLLM({
        providerId: PROVIDER_ID,
        apiKey: API_KEY,
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        maxTokens: 2048
      });

      const level3Results = parseLevel3Response(content, batch.length);
      if (!level3Results) {
        console.log(`[${batchIdx + 1}/${batches.length}] 解析失败，跳过。响应前 200 字符: ${content.slice(0, 200)}`);
        completed++;
        return;
      }

      let batchUpdated = 0;
      for (let i = 0; i < batch.length; i++) {
        const l3 = level3Results[i];
        const reviewIdx = batch[i].reviewIndex;
        reviews[reviewIdx].level3 = l3 || null;
        if (l3) batchUpdated++;
      }

      // 每批完成后写回文件
      writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

      totalUpdated += batchUpdated;
      completed++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (completed / (Date.now() - startTime) * 1000).toFixed(1);
      console.log(`[${completed}/${batches.length}] 批次 ${batchIdx + 1}: ${batchUpdated}/${batch.length} 条有分类 | 累计更新 ${totalUpdated} | ${elapsed}s | ${rate} 批/秒`);
    } catch (error) {
      completed++;
      console.log(`[${completed}/${batches.length}] 批次 ${batchIdx + 1}: 失败 - ${error.message}`);
    }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n完成！耗时 ${elapsed}s`);
  console.log(`更新了 ${totalUpdated}/${missing.length} 条 level3`);

  // 最终统计
  const finalMissing = reviews.filter((r) => !r.level3).length;
  console.log(`剩余缺失: ${finalMissing}/${reviews.length}`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
