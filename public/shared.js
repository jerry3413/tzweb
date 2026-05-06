// 浏览器前台公共工具函数。
// app.js 和 analysis.js 都通过全局作用域引用这些函数，避免重复定义。

// 防止外部内容（App 名称、评论文字、Rivioo 警告等）被浏览器当成 HTML 执行。
// 渲染前先转义，确保页面安全。
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// HTML 属性值中的特殊字符更需要严格处理，避免破坏页面结构。
function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

// 后端所有接口都返回 JSON，统一在这里处理 fetch 和错误拦截。
// 无论 HTTP 状态如何，先解析 JSON，再根据 ok 判断是否抛出错误。
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed with HTTP ${response.status}`);
  }

  return data;
}

// 文件大小从纯数字变成人类可读的表示形式，用于下载列的汇总展示。
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
