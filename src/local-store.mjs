import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// LocalJobStore 是这一版的轻量本地数据库。
// 每个下载任务都会写进 data/reviews/jobs.json，后续分析后台可以复用这些历史记录，
// 暂时不必引入 Postgres 之类的正式数据库。
export class LocalJobStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.jobs = [];
    // 多个后台任务可能几乎同时更新进度。
    // 用队列串行写文件，避免 jobs.json 被并发写坏。
    this.writeQueue = Promise.resolve();
  }

  // 服务启动时加载已有任务历史。
  // 如果文件不存在，就创建空记录，让其他模块可以直接使用存储。
  async init() {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const text = await readFile(this.jobsFile, 'utf8');
      this.jobs = JSON.parse(text);
      if (!Array.isArray(this.jobs)) {
        this.jobs = [];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.jobs = [];
      await this.flush();
    }
  }

  // 最新任务排在最上面，符合后台页面查看当前工作的习惯。
  list() {
    return [...this.jobs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  get(id) {
    return this.jobs.find((job) => job.id === id) || null;
  }

  async create(job) {
    this.jobs.unshift(job);
    await this.flush();
    return job;
  }

  async update(id, patch) {
    const job = this.get(id);
    if (!job) return null;
    // updatedAt 用于页面的“更新时间”列，也方便发现长时间不动的任务。
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.flush();
    return job;
  }

  // 持久化完整任务列表。
  // MVP 阶段先保持简单；如果任务量变大，只需要把这个类替换成真正数据库实现。
  async flush() {
    this.writeQueue = this.writeQueue.then(() => (
      writeFile(this.jobsFile, `${JSON.stringify(this.jobs, null, 2)}\n`, 'utf8')
    ));
    return this.writeQueue;
  }
}
