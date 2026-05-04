#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  DEFAULT_EMAIL,
  parseArgs,
  resolveRiviooApiBase,
  runReviewDownload,
  sanitizeFilename
} from '../src/rivioo-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = 'outputs/reviews';

// 命令行入口保留下来，方便开发和运营快速验证下载链路。
// 网页后台也复用同一个 Rivioo 客户端，所以两边的行为应保持一致。
main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  const outputDir = path.resolve(repoRoot, args.outputDir || DEFAULT_OUTPUT_DIR);
  const usingDefaultEmail = !args.email && !process.env.RIVIOO_EMAIL;

  // Rivioo 下载文件时要求带一个邮箱参数。
  // 本地测试可以用占位邮箱；正式使用时可传真实邮箱或 RIVIOO_EMAIL。
  if (usingDefaultEmail) {
    console.warn(`No --email or RIVIOO_EMAIL supplied; using ${DEFAULT_EMAIL} for Rivioo's download gate.`);
  }

  // 每次命令行运行前都重新识别 Rivioo 当前后端地址。
  // 这样脚本和网页后台都遵守“使用最新 Rivioo 接口”的规则。
  const apiBase = await resolveRiviooApiBase({ refresh: true });
  console.log(`Using Rivioo API: ${apiBase}`);

  const result = await runReviewDownload({
    ...args,
    apiBase,
    outputDir,
    timeoutMs: Number.parseInt(args.timeoutMs || '180000', 10),
    onProgress(status) {
      // 直接把 Rivioo 的进度显示到终端；这一版还不做本地解析。
      const step = status.currentStep ? ` - ${status.currentStep}` : '';
      console.log(`Progress: ${status.progress ?? 0}%${step}`);
    }
  });

  // manifest 是给后续分析功能使用的“下载凭证”。
  // 它记录本次导出对应的 App、地区、格式和本地文件路径。
  await mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, `${sanitizeFilename(result.app.name)}_${result.country}_${result.riviooJobId}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (result.warning) {
    console.warn(result.warning);
  }

  console.log(`Export completed: ${result.exportedCount ?? 'unknown'} reviews.`);
  console.log('\nSaved files:');
  for (const item of result.downloads) {
    if (!item.skipped) {
      console.log(`- ${item.format}: ${item.path}`);
    }
  }
  console.log(`- manifest: ${manifestPath}`);
}

function printUsage() {
  console.log(`
Usage:
  npm run reviews:download -- --url "<store-url>" [options]
  npm run reviews:download -- --platform android --app-id com.example.app [options]

Options:
  --count <n>           Reviews to request. Default: 1000
  --country <cc>        Store country, for example us or cn
  --language <cc>       Review language. Default: en
  --sort <sort>         newest, oldest, rating, helpful. Default: newest
  --format <format>     csv, xlsx, or both. Default: csv
  --email <email>       Email for Rivioo download gate
  --output-dir <path>   Default: outputs/reviews
`);
}
