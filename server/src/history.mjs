/**
 * 歌单浏览历史：index.json 存摘要（常驻内存），<id>.json 存歌单 + 已匹配结果快照。
 * 放在独立子目录里，因为 Cache#clear 会删掉缓存目录下所有 .json，「清空缓存」不该抹掉历史。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 100;
const WRITE_DELAY_MS = 800;
const isId = (id) => /^\d{1,20}$/.test(String(id));

export class History {
  constructor(dir) {
    this.dir = dir;
    /** @type {Map<string, object>} id → 摘要 */
    this.index = new Map();
    /** @type {Map<string, {playlist:object, preferBilingual:boolean, results:Record<number, object>}>} */
    this.snapshots = new Map();
    this.timers = new Map();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const raw = JSON.parse(fs.readFileSync(this.#indexFile(), 'utf8'));
      for (const e of raw) if (isId(e.id)) this.index.set(String(e.id), e);
    } catch {
      /* 首次运行或文件损坏：从空历史开始 */
    }
  }

  #indexFile() {
    return path.join(this.dir, 'index.json');
  }

  #snapFile(id) {
    return path.join(this.dir, `${id}.json`);
  }

  #snapshot(id) {
    let s = this.snapshots.get(id);
    if (!s) {
      try {
        s = JSON.parse(fs.readFileSync(this.#snapFile(id), 'utf8'));
      } catch {
        s = null;
      }
      if (s) this.snapshots.set(id, s);
    }
    return s;
  }

  #scheduleWrite(id) {
    if (this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => this.flush(id), WRITE_DELAY_MS)
    );
  }

  /** 立刻落盘（某个歌单的快照 + 索引） */
  flush(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    try {
      const s = this.snapshots.get(id);
      if (s && this.index.has(id)) fs.writeFileSync(this.#snapFile(id), JSON.stringify(s), 'utf8');
      fs.writeFileSync(this.#indexFile(), JSON.stringify([...this.index.values()]), 'utf8');
    } catch {
      /* 历史写失败不影响匹配主流程 */
    }
  }

  #refreshStats(id) {
    const e = this.index.get(id);
    const s = this.snapshots.get(id);
    if (!e || !s) return;
    const rs = Object.values(s.results);
    e.matched = rs.length;
    e.high = rs.filter((r) => r.confidence === 'high').length;
    e.bilingualNeeded = rs.filter((r) => r.bilingualNeeded).length;
    e.bilingualHit = rs.filter((r) => r.bilingualNeeded && (r.best?.bilingualHit ?? 0) >= 0.6).length;
    e.preferBilingual = s.preferBilingual;
  }

  #evict() {
    if (this.index.size <= MAX_ENTRIES) return;
    const old = [...this.index.values()].sort((a, b) => a.lastViewedAt - b.lastViewedAt);
    for (const e of old.slice(0, this.index.size - MAX_ENTRIES)) this.remove(e.id);
  }

  /**
   * 打开歌单时调用。countView=false 用于「继续匹配」这类同一次浏览中的后续批次。
   * 匹配偏好变了（双语优先 ↔ MV 优先）就丢弃旧结果，否则两种排序会混在一份快照里。
   */
  recordPlaylist(pl, { preferBilingual, countView = true }) {
    const id = String(pl.id);
    if (!isId(id)) return;
    const now = Date.now();
    const prev = this.index.get(id);
    this.index.set(id, {
      id,
      name: pl.name,
      cover: pl.cover,
      creator: pl.creator,
      trackCount: pl.trackCount,
      firstViewedAt: prev?.firstViewedAt ?? now,
      lastViewedAt: now,
      viewCount: (prev?.viewCount ?? 0) + (countView || !prev ? 1 : 0),
      matched: prev?.matched ?? 0,
      high: prev?.high ?? 0,
      bilingualNeeded: prev?.bilingualNeeded ?? 0,
      bilingualHit: prev?.bilingualHit ?? 0,
      preferBilingual,
    });
    const old = this.#snapshot(id);
    const keep = old && old.preferBilingual === preferBilingual;
    this.snapshots.set(id, { playlist: pl, preferBilingual, results: keep ? old.results : {} });
    this.#refreshStats(id);
    this.#evict();
    this.#scheduleWrite(id);
  }

  recordResult(id, result) {
    id = String(id);
    const s = this.snapshots.get(id);
    if (!s || !this.index.has(id)) return;
    s.results[result.index] = result;
    this.#refreshStats(id);
    this.#scheduleWrite(id);
  }

  /** 按最近浏览倒序；q 匹配歌单名 / 创建者 / ID */
  list({ q = '', limit = MAX_ENTRIES } = {}) {
    const needle = q.trim().toLowerCase();
    return [...this.index.values()]
      .filter((e) => !needle || [e.name, e.creator, e.id].some((v) => String(v ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
      .slice(0, limit);
  }

  /** 从历史打开：返回快照，并算作一次浏览 */
  open(id) {
    id = String(id);
    const e = this.index.get(id);
    const s = e && this.#snapshot(id);
    if (!s) return null;
    e.lastViewedAt = Date.now();
    e.viewCount = (e.viewCount ?? 0) + 1;
    this.#scheduleWrite(id);
    return {
      entry: e,
      playlist: s.playlist,
      preferBilingual: s.preferBilingual,
      results: Object.values(s.results).sort((a, b) => a.index - b.index),
    };
  }

  remove(id) {
    id = String(id);
    if (!isId(id)) return false;
    const existed = this.index.delete(id);
    this.snapshots.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    try {
      fs.rmSync(this.#snapFile(id), { force: true });
      fs.writeFileSync(this.#indexFile(), JSON.stringify([...this.index.values()]), 'utf8');
    } catch {
      /* ignore */
    }
    return existed;
  }

  clear() {
    for (const id of [...this.index.keys()]) this.remove(id);
  }
}
