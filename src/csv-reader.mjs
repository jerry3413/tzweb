import { readFile } from 'node:fs/promises';

// 解析 Rivioo 导出的 CSV 评论文件。
// Rivioo CSV 格式固定 13 列：
//   Store, Country, Language, Review ID, Review Date, Star Rating,
//   Review Title, Review Text, Reviewer Name, App Version,
//   Developer Reply, Developer Reply Date, Review URL
//
// 解析结果供 DeepSeek 客户端用于批量语义分类。

// 读取单个 CSV 文件，返回评论对象数组。
// 每条评论的字段名使用 camelCase，方便后续 JavaScript 处理。
export async function readCSVReviewFile(filePath) {
  const text = await readFile(filePath, 'utf8');
  const lines = parseCSVLines(text);

  if (lines.length < 2) {
    // 只有表头或空文件，没有可解析的评论
    return [];
  }

  const header = lines[0];
  const columnIndex = {
    store: header.indexOf('Store'),
    country: header.indexOf('Country'),
    language: header.indexOf('Language'),
    reviewId: header.indexOf('Review ID'),
    reviewDate: header.indexOf('Review Date'),
    starRating: header.indexOf('Star Rating'),
    reviewTitle: header.indexOf('Review Title'),
    reviewText: header.indexOf('Review Text'),
    reviewerName: header.indexOf('Reviewer Name'),
    appVersion: header.indexOf('App Version'),
    developerReply: header.indexOf('Developer Reply'),
    developerReplyDate: header.indexOf('Developer Reply Date'),
    reviewUrl: header.indexOf('Review URL')
  };

  // 检查必要列是否存在
  if (columnIndex.reviewId === -1 || columnIndex.reviewText === -1) {
    throw new Error('CSV 文件格式不符合预期：缺少 Review ID 或 Review Text 列。');
  }

  const reviews = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i];
    if (fields.length < 2) continue; // 跳过空行

    const starText = fields[columnIndex.starRating];
    const starRating = starText ? parseInt(starText, 10) || 0 : 0;

    reviews.push({
      store: fields[columnIndex.store] || '',
      country: fields[columnIndex.country] || '',
      language: fields[columnIndex.language] || '',
      reviewId: fields[columnIndex.reviewId] || '',
      reviewDate: fields[columnIndex.reviewDate] || '',
      starRating,
      reviewTitle: fields[columnIndex.reviewTitle] || '',
      reviewText: fields[columnIndex.reviewText] || '',
      reviewerName: fields[columnIndex.reviewerName] || '',
      appVersion: fields[columnIndex.appVersion] || '',
      developerReply: fields[columnIndex.developerReply] || '',
      developerReplyDate: fields[columnIndex.developerReplyDate] || '',
      reviewUrl: fields[columnIndex.reviewUrl] || ''
    });
  }

  return reviews;
}

// 合并多个 CSV 文件，按 Review ID 去重（保留首次出现的版本）。
// 返回合并后的评论数组和统计信息。
export async function mergeCSVFiles(filePaths) {
  const seen = new Set();
  const reviews = [];
  let totalRows = 0;
  let duplicates = 0;

  for (const filePath of filePaths) {
    const fileReviews = await readCSVReviewFile(filePath);
    totalRows += fileReviews.length;

    for (const review of fileReviews) {
      if (seen.has(review.reviewId)) {
        duplicates += 1;
        continue;
      }
      seen.add(review.reviewId);
      reviews.push(review);
    }
  }

  return {
    reviews,
    stats: {
      totalFiles: filePaths.length,
      totalRows,
      uniqueReviews: reviews.length,
      duplicates
    }
  };
}

// CSV 行解析：处理引号转义、逗号分隔。
// 不引入第三方 CSV 库，保持零依赖。
function parseCSVLines(text) {
  const lines = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // 转义的引号 → 单个引号
        field += '"';
        i += 1;
      } else if (ch === '"') {
        // 引号结束
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n') {
        current.push(field);
        field = '';
        if (current.length > 1 || current[0] !== '') {
          lines.push(current);
        }
        current = [];
      } else if (ch === '\r') {
        // 跳过 CR
      } else {
        field += ch;
      }
    }
  }

  // 处理最后一行（文件可能不以 \n 结尾）
  current.push(field);
  if (current.length > 1 || current[0] !== '') {
    lines.push(current);
  }

  return lines;
}
