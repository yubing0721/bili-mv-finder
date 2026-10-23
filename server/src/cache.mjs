/**
 * 轻量缓存：内存 + 可选磁盘持久化。
 *
 * 匹配一首歌要发 3~4 次搜索请求，一个 100 首的歌单就是 300+ 次请求。
 * 缓存能把这变成「只跑一次」，也顺便降低触发 B站 限流的概率。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL = 1000 * 60 * 60 * 12; // 12 小时

export class Cache {
  /**
   * @param {{dir?:string|null, ttlMs?:number, maxEntries?:number}} [opts]
   */
  constructor(opts = {}) {
    this.dir = opts.dir ?? null;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL;
    this.maxEntries = opts.maxEntries ?? 5000;
    /** @type {Map<string, {v:any, exp:number}>} */
    this.mem = new Map();
    this.hits = 0;
    this.misses = 0;
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        this.dir = null;
      }
    }
  }

  #file(key) {
    // 用 key 的 sha1 作文件名，避免非法字符与过长路径
    const h = Buffer.from(key).toString('base64url').slice(0, 120);
    return path.join(this.dir, `${h}.json`);
  }

  get(key) {
    const now = Date.now();
    const m = this.mem.get(key);
    if (m) {
      if (m.exp > now) {
        this.hits++;
        return m.v;
      }
      this.mem.delete(key);
    }
    if (this.dir) {
      try {
        const f = this.#file(key);
        if (fs.existsSync(f)) {
          const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (raw.exp > now) {
            this.mem.set(key, raw);
            this.hits++;
            return raw.v;
          }
          fs.unlinkSync(f);
        }
      } catch {
        /* 缓存损坏就当作未命中 */
      }
    }
    this.misses++;
    return undefined;
  }

  set(key, v, ttlMs = this.ttlMs) {
    const entry = { v, exp: Date.now() + ttlMs };
    this.mem.set(key, entry);
    if (this.mem.size > this.maxEntries) {
      // 简单淘汰：删掉最早的 10%
      const keys = [...this.mem.keys()].slice(0, Math.ceil(this.maxEntries * 0.1));
      for (const k of keys) this.mem.delete(k);
    }
    if (this.dir) {
      try {
        fs.writeFileSync(this.#file(key), JSON.stringify(entry), 'utf8');
      } catch {
        /* 磁盘写失败不影响主流程 */
      }
    }
    return v;
  }

  /** 读缓存，未命中则执行 fn 并写入 */
  async wrap(key, fn, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const v = await fn();
    this.set(key, v, ttlMs);
    return v;
  }

  clear() {
    this.mem.clear();
    if (this.dir) {
      try {
        for (const f of fs.readdirSync(this.dir)) {
          if (f.endsWith('.json')) fs.unlinkSync(path.join(this.dir, f));
        }
      } catch {
        /* ignore */
      }
    }
  }

  stats() {
    return { size: this.mem.size, hits: this.hits, misses: this.misses, dir: this.dir };
  }
}
