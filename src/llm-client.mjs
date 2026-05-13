import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_FILE = path.join(__dirname, '..', 'data', 'providers.json');

// 加载提供商配置。
export function loadProviders() {
  try {
    const raw = readFileSync(PROVIDERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { providers: [], default: 'deepseek' };
  }
}

// 统一 LLM API 调用。所有提供商均使用 OpenAI 兼容的 Chat Completions 格式。
//
// 参数：
//   providerId    提供商 ID（默认 'deepseek'）
//   apiKey        API Key
//   model         模型名称
//   messages      [{ role, content }, ...]
//   temperature   生成温度
//   maxTokens     最大 Token 数
//   retries       重试次数（默认 3）
//   customApiBase 自定义 API 端点（仅自定义提供商使用）
//
// 返回：data.choices[0].message.content 文本内容。
export async function callLLM({ providerId, apiKey, model, messages, temperature, maxTokens, retries = 3, customApiBase }) {
  const config = loadProviders();
  const providers = config.providers || [];
  const defaultId = config.default || 'deepseek';
  const provider = providers.find((p) => p.id === (providerId || defaultId)) || providers[0];
  if (!provider) {
    throw new Error('未找到可用的 AI 提供商配置。');
  }

  const apiBase = customApiBase || provider.apiBase;
  if (!apiBase) {
    throw new Error(`提供商"${provider.name}"未配置 API 端点。${provider.custom ? '请填写自定义端点地址。' : ''}`);
  }

  const providerLabel = provider.name;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(apiBase, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`${providerLabel} API 请求被拒绝 (HTTP ${response.status})：${errorText.slice(0, 300)}`);
        }
        throw new Error(`${providerLabel} API HTTP ${response.status}：${errorText.slice(0, 200)}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`${providerLabel} 返回了空响应内容。`);
      }
      return content;
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
