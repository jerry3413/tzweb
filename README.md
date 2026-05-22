# APP 评论体征后台

下载 APP 评论，并把原始 CSV/XLSX 文件保存到本地，进行评论解析、聚类、情绪分析和体征归因


## 网页后台

```bash
npm run dev
```

启动后看终端输出的地址，例如：

```text
http://localhost:3001
```

不要直接打开 `public/index.html`。`file://` 静态预览不能连接本地下载 API。

本地任务记录保存到：

```text
data/reviews/jobs.json
```

下载文件保存到：

```text
data/reviews/files/
```

## 命令行下载

```bash
npm run reviews:download -- --url "https://play.google.com/store/apps/details?id=com.whatsapp&hl=en&gl=us" --count 1000 --country us --language en --format csv --email "you@example.com"
```

App Store 单次导出会被 Rivioo 限制到 500 条：

```bash
npm run reviews:download -- --url "https://apps.apple.com/us/app/whatsapp-messenger/id310633997" --count 1000 --country us --format csv
```

命令行下载文件默认保存到 `outputs/reviews/`。

## 参数说明

- `--url`：App Store 或 Google Play 的 APP 链接。除非传了 `--platform` 和 `--app-id`，否则必填。
- `--platform`：`ios` 或 `android`，和 `--app-id` 一起使用。
- `--app-id`：iOS 数字 track ID，或 Android 包名。
- `--count`：计划下载的评论数量，默认 `1000`。
- `--country`：商店国家码，默认优先使用 URL 里的国家码，再回退到 `us`。
- `--language`：评论语言，默认 `en`。
- `--sort`：`newest`、`oldest`、`rating`、`helpful`。
- `--format`：`csv`、`xlsx` 或 `both`。
- `--email`：传给 Rivioo 下载门槛的邮箱参数，默认使用 `RIVIOO_EMAIL`，再回退到 `local@download.invalid`。
- `--output-dir`：命令行下载目录，默认 `outputs/reviews`。
