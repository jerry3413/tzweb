import { mkdir, readFile, writeFile, unlink, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// TemplateStore 管理评论分析模板的本地存储。
// 内置模板存放在项目根目录的 templates/（版本控制），运行时拷贝到 data/templates/。
// 用户自定义模板只在 data/templates/ 里，支持完整 CRUD。
//
// 存储结构：
//   data/templates/index.json       → 模板索引列表（轻量，不包含完整 dimensions）
//   data/templates/{templateId}.json → 完整模板定义（按需加载）
export class TemplateStore {
  constructor({ dataDir, sourceDir }) {
    this.dataDir = dataDir;
    this.sourceDir = sourceDir;
    this.indexFile = path.join(dataDir, 'index.json');
    this.index = [];
    this.writeQueue = Promise.resolve();
  }

  // 服务启动时：确保运行时目录存在，加载索引。
  // 如果 data/templates/ 为空，从 templates/ 源目录拷贝内置模板。
  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const text = await readFile(this.indexFile, 'utf8');
      this.index = JSON.parse(text);
      if (!Array.isArray(this.index)) {
        this.index = [];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.index = [];
    }

    // 首次启动：从源码目录拷贝内置模板到运行时目录
    if (this.index.length === 0 && this.sourceDir) {
      await this.seedBuiltInTemplates();
    }
  }

  // 列出所有模板的索引信息（不包含完整维度数据，减少 API 响应体积）。
  list() {
    return [...this.index].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // 按 ID 获取完整模板定义。
  // 索引里只有元数据，完整内容从独立 JSON 文件加载。
  async get(id) {
    const entry = this.index.find((item) => item.id === id);
    if (!entry) return null;

    const filePath = path.join(this.dataDir, `${id}.json`);
    try {
      const text = await readFile(filePath, 'utf8');
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 创建自定义模板。
  // 内置模板的 isBuiltIn 由模板 JSON 文件自身决定，这里创建的都是用户模板。
  async create(template) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const full = {
      ...template,
      id,
      isBuiltIn: false,
      createdAt: now,
      updatedAt: now
    };

    // 校验模板基本结构：必须有名称和至少一个维度
    if (!full.name || !Array.isArray(full.dimensions) || full.dimensions.length === 0) {
      throw new Error('模板必须有名称（name）和至少一个维度（dimensions）。');
    }

    const filePath = path.join(this.dataDir, `${id}.json`);
    await this.enqueueWrite(async () => {
      await writeFile(filePath, JSON.stringify(full, null, 2), 'utf8');
    });

    // 在索引中追加条目
    this.index.push({
      id: full.id,
      name: full.name,
      category: full.category || '',
      description: full.description || '',
      isBuiltIn: false,
      dimensionCount: full.dimensions.length,
      tagCount: full.dimensions.reduce((sum, dim) => sum + (Array.isArray(dim.tags) ? dim.tags.length : 0), 0),
      createdAt: full.createdAt,
      updatedAt: full.updatedAt
    });
    await this.flushIndex();

    return full;
  }

  // 更新模板字段。
  // 只允许修改自定义模板；内置模板不可直接修改（需要走 reset 恢复原始版本）。
  async update(id, patch) {
    const template = await this.get(id);
    if (!template) return null;
    if (template.isBuiltIn) {
      throw new Error('内置模板不允许直接修改。如需调整，请基于内置模板创建自定义副本。');
    }

    // 不允许通过 update 修改 isBuiltIn 和 id
    const allowed = ['name', 'category', 'description', 'dimensions'];
    for (const key of Object.keys(patch)) {
      if (allowed.includes(key)) {
        template[key] = patch[key];
      }
    }
    template.updatedAt = new Date().toISOString();

    const filePath = path.join(this.dataDir, `${id}.json`);
    await this.enqueueWrite(async () => {
      await writeFile(filePath, JSON.stringify(template, null, 2), 'utf8');
    });

    // 同步更新索引条目
    const entry = this.index.find((item) => item.id === id);
    if (entry) {
      entry.name = template.name;
      entry.category = template.category || '';
      entry.description = template.description || '';
      entry.dimensionCount = template.dimensions.length;
      entry.tagCount = template.dimensions.reduce((sum, dim) => sum + (Array.isArray(dim.tags) ? dim.tags.length : 0), 0);
      entry.updatedAt = template.updatedAt;
    }
    await this.flushIndex();

    return template;
  }

  // 删除自定义模板。内置模板不允许删除。
  async delete(id) {
    const template = await this.get(id);
    if (!template) return false;
    if (template.isBuiltIn) {
      throw new Error('内置模板不允许删除。');
    }

    const filePath = path.join(this.dataDir, `${id}.json`);
    await this.enqueueWrite(async () => {
      await unlink(filePath);
    });

    this.index = this.index.filter((item) => item.id !== id);
    await this.flushIndex();

    return true;
  }

  // 将内置模板恢复到其源代码版本。
  // 如果 sourceDir 不存在对应的 JSON 文件，则无法恢复。
  async resetBuiltIn(id) {
    const template = await this.get(id);
    if (!template || !template.isBuiltIn) {
      throw new Error('只能重置内置模板。');
    }
    if (!this.sourceDir) {
      throw new Error('未配置模板源码目录，无法重置。');
    }

    const sourcePath = path.join(this.sourceDir, `${id.replace('builtin-', '')}.json`);
    let sourceText;
    try {
      sourceText = await readFile(sourcePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`找不到内置模板源文件：${sourcePath}`);
      }
      throw error;
    }

    const sourceTemplate = JSON.parse(sourceText);
    sourceTemplate.updatedAt = new Date().toISOString();

    const filePath = path.join(this.dataDir, `${id}.json`);
    await this.enqueueWrite(async () => {
      await writeFile(filePath, JSON.stringify(sourceTemplate, null, 2), 'utf8');
    });

    // 更新索引条目
    const entry = this.index.find((item) => item.id === id);
    if (entry) {
      entry.name = sourceTemplate.name;
      entry.category = sourceTemplate.category || '';
      entry.description = sourceTemplate.description || '';
      entry.dimensionCount = sourceTemplate.dimensions.length;
      entry.tagCount = sourceTemplate.dimensions.reduce((sum, dim) => sum + (Array.isArray(dim.tags) ? dim.tags.length : 0), 0);
      entry.updatedAt = sourceTemplate.updatedAt;
    }
    await this.flushIndex();

    return sourceTemplate;
  }

  // 将内置模板从 templates/ 源码目录拷贝到运行时 data/templates/。
  async seedBuiltInTemplates() {
    let files;
    try {
      files = await readdir(this.sourceDir);
    } catch {
      // 没有源码模板目录，跳过
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const sourcePath = path.join(this.sourceDir, file);
      const text = await readFile(sourcePath, 'utf8');
      const template = JSON.parse(text);

      // 确保模板有 id 字段
      if (!template.id) {
        template.id = randomUUID();
      }

      const destPath = path.join(this.dataDir, `${template.id}.json`);
      await this.enqueueWrite(async () => {
        await writeFile(destPath, JSON.stringify(template, null, 2), 'utf8');
      });

      this.index.push({
        id: template.id,
        name: template.name,
        category: template.category || '',
        description: template.description || '',
        isBuiltIn: template.isBuiltIn || false,
        dimensionCount: (template.dimensions || []).length,
        tagCount: (template.dimensions || []).reduce((sum, dim) => sum + (Array.isArray(dim.tags) ? dim.tags.length : 0), 0),
        createdAt: template.createdAt || new Date().toISOString(),
        updatedAt: template.updatedAt || new Date().toISOString()
      });
    }

    await this.flushIndex();
  }

  // 串行写入索引文件，避免并发损坏。
  async flushIndex() {
    this.writeQueue = this.writeQueue.then(() =>
      writeFile(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8')
    );
    return this.writeQueue;
  }

  // 通用写入入队：用于模板文件的非索引写入（创建、更新、删除）。
  async enqueueWrite(fn) {
    this.writeQueue = this.writeQueue.then(fn);
    return this.writeQueue;
  }
}
