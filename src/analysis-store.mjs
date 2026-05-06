import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

// AnalysisStore 管理评论分析任务元数据。
// 完整分类结果数据量较大，另存为独立的 results/{analysisId}.json，
// 这里只保存任务状态、配置和统计摘要（即 jobs.json 的内容）。
//
// 沿用 LocalJobStore 的队列写模式，避免并发更新损坏 JSON 文件。
export class AnalysisStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.resultsDir = path.join(dataDir, 'results');
    this.jobs = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.resultsDir, { recursive: true });

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
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.flush();
    return job;
  }

  // 将分析任务的完整结果写入 results/{id}.json。
  // 存储位置与 jobs.json 独立，避免元数据文件膨胀。
  async saveResults(analysisId, results) {
    const filePath = path.join(this.resultsDir, `${analysisId}.json`);
    await this.enqueueWrite(async () => {
      await writeFile(filePath, JSON.stringify(results, null, 2), 'utf8');
    });
  }

  async delete(id) {
    const job = this.get(id);
    if (!job) return false;

    // 删除分析结果文件
    const resultsPath = path.join(this.resultsDir, `${id}.json`);
    try {
      await rm(resultsPath, { force: true });
    } catch { /* 文件不存在则忽略 */ }

    this.jobs = this.jobs.filter((j) => j.id !== id);
    await this.flush();
    return true;
  }

  // 读取已保存的完整分析结果。
  async loadResults(analysisId) {
    const filePath = path.join(this.resultsDir, `${analysisId}.json`);
    try {
      const text = await readFile(filePath, 'utf8');
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 持久化元数据文件。
  async flush() {
    this.writeQueue = this.writeQueue.then(() =>
      writeFile(this.jobsFile, JSON.stringify(this.jobs, null, 2), 'utf8')
    );
    return this.writeQueue;
  }

  // 通用入队写入：用于 results 等非 jobs.json 文件的并发安全写入。
  async enqueueWrite(fn) {
    this.writeQueue = this.writeQueue.then(fn);
    return this.writeQueue;
  }
}
