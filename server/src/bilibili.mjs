/**
 * B站 客户端
 *
 * - WBI 签名（2023 年后搜索/详情类接口的硬性要求）
 * - 会话自愈：buvid3 缺失或签名过期时自动重建
 * - 结果规范化：把 B站 的字段整理成 App 好用的形状
 */
import crypto from 'node:crypto';
import { CookieJar, RateLimiter, fetchJSON, sleep, mapLimit } from './http.mjs';
import { clean, parseDuration } from './text.mjs';

/** WBI mixin 置换表（B站前端 JS 里硬编码的常量） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

/** 对参数做 WBI 签名，补上 wts 与 w_rid */
export function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const withTs = { ...params, wts };
  const query = Object.keys(withTs)
    .sort()
    .map((k) => {
      const v = String(withTs[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function toBiliUrl(pic) {
  if (!pic) return '';
  let p = String(pic);
  if (p.startsWith('//')) p = `https:${p}`;
  if (p.startsWith('http://')) p = `https://${p.slice(7)}`;
  // B站 图片支持 @ 后缀做裁剪/压缩，取一张适合列表展示的
  return p.includes('@') ? p : `${p}@480w_270h_1c.webp`;
}

/** 把搜索结果规范化为内部候选结构 */
export function normalizeSearchItem(v) {
  if (!v || v.type !== 'video' || !v.bvid) return null;
  const title = clean(v.title);
  return {
    bvid: v.bvid,
    aid: v.aid,
    title,
    author: v.author ? clean(v.author) : '',
    mid: v.mid,
    cover: toBiliUrl(v.pic),
    play: Number(v.play) || 0,
    danmaku: Number(v.danmaku) || 0,
    like: Number(v.like) || 0,
    favorites: Number(v.favorites) || 0,
    review: Number(v.review) || 0,
    /** 搜索接口给的是 '4:35' 字符串；详情接口能给到精确秒数 */
    durationSec: parseDuration(v.duration),
    durationText: typeof v.duration === 'string' ? v.duration : '',
    pubdate: Number(v.pubdate) || 0,
    tag: v.tag ? clean(v.tag) : '',
    description: v.description ? clean(v.description) : '',
    typename: v.typename || '',
    url: `https://www.bilibili.com/video/${v.bvid}`,
    appUrl: `bilibili://video/${v.bvid}`,
  };
}

export class BilibiliClient {
  /**
   * @param {{minIntervalMs?:number, debug?:boolean}} [opts]
   */
  constructor(opts = {}) {
    this.jar = new CookieJar();
    this.limiter = new RateLimiter(opts.minIntervalMs ?? Number(process.env.BILI_MIN_INTERVAL_MS ?? 250));
    this.wbi = null; // { imgKey, subKey, at }
    this.sessionReady = false;
    this.debug = opts.debug ?? process.env.DEBUG_BILI === '1';
    this.stats = { requests: 0, searches: 0, riskHits: 0, emptySearches: 0, voucherHits: 0 };
    /** bvid → 详情，避免重复请求 */
    this.viewCache = new Map();
  }

  log(...a) {
    if (this.debug) console.error('[bili]', ...a);
  }

  /**
   * 建立/刷新会话：先访问主页拿 buvid3，再取 WBI 密钥。
   * 多个并发调用共享同一个 in-flight promise，避免重复握手。
   */
  async ensureSession(force = false) {
    if (this.sessionReady && !force && this.wbi && Date.now() - this.wbi.at < 3600_000) return;
    if (this._sessionPromise && !force) return this._sessionPromise;
    this._sessionPromise = (async () => {
      await fetchJSON('https://www.bilibili.com/', {
        cookieJar: this.jar,
        limiter: this.limiter,
        retries: 2,
        expectText: true,
      }).catch(() => null);
      if (!this.jar.has('buvid3')) {
        try {
          const spi = await fetchJSON('https://api.bilibili.com/x/frontend/finger/spi', {
            cookieJar: this.jar,
            limiter: this.limiter,
            headers: { Referer: 'https://www.bilibili.com/' },
          });
          if (spi?.data?.b_3) {
            this.jar.set('buvid3', spi.data.b_3);
            this.jar.set('buvid4', spi.data.b_4);
          }
        } catch (e) {
          this.log('spi 失败', e.message);
        }
      }
      const nav = await fetchJSON('https://api.bilibili.com/x/web-interface/nav', {
        cookieJar: this.jar,
        limiter: this.limiter,
        headers: { Referer: 'https://www.bilibili.com/' },
        onRiskControl: async () => {
          this.stats.riskHits++;
          this.jar.map.clear();
          await sleep(800);
        },
      });
      const img = nav?.data?.wbi_img?.img_url ?? '';
      const sub = nav?.data?.wbi_img?.sub_url ?? '';
      const pick = (u) => String(u).split('/').pop().split('.')[0];
      const imgKey = pick(img);
      const subKey = pick(sub);
      if (!imgKey || !subKey) throw new Error('无法获取 WBI 密钥（可能被风控，请稍后重试）');
      this.wbi = { imgKey, subKey, at: Date.now() };
      this.sessionReady = true;
      this.log('会话就绪, buvid3 =', this.jar.get('buvid3')?.slice(0, 12), 'wbi ok');
    })();
    try {
      await this._sessionPromise;
    } finally {
      this._sessionPromise = null;
    }
  }

  /** 内部：带 WBI 签名的 GET */
  async signedGet(path, params, { referer = 'https://www.bilibili.com/' } = {}) {
    await this.ensureSession();
    const build = () => `https://api.bilibili.com${path}?${encWbi(params, this.wbi.imgKey, this.wbi.subKey)}`;
    this.stats.requests++;
    try {
      return await fetchJSON(build(), {
        cookieJar: this.jar,
        limiter: this.limiter,
        headers: { Referer: referer },
        onRiskControl: async () => {
          this.stats.riskHits++;
          this.log('命中风控，重建会话');
          await this.ensureSession(true);
        },
      });
    } catch (e) {
      // 签名可能过期，强制刷新一次再试
      await this.ensureSession(true);
      return fetchJSON(build(), {
        cookieJar: this.jar,
        limiter: this.limiter,
        headers: { Referer: referer },
      });
    }
  }

  /**
   * 综合搜索（视频）
   * @param {string} keyword
   * @param {{page?:number, pageSize?:number, order?:string}} [opts]
   * @returns {Promise<object[]>} 规范化候选
   */
  async searchVideo(keyword, opts = {}) {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { list, blocked } = await this.#rawSearch(keyword, opts);
      if (list.length > 0) return list;

      if (blocked) {
        // —— 风控软拦截（v_voucher）：换一个新会话再试 ——
        // 这类拦截是概率性的，重建会话（即换一个 buvid）通常能立刻恢复。
        this.stats.voucherHits++;
        console.warn(
          `[bili] 搜索 "${keyword}" 被风控软拦截(v_voucher)，第 ${attempt}/${maxAttempts} 次重试`
        );
        if (attempt === maxAttempts) break;
        await sleep(900 * attempt);
        await this.ensureSession(true);
        continue;
      }

      // —— 未被拦截但结果为空 ——
      // 可能确实没有结果，也可能是签名/会话边缘状态。只重试一次，成本可控。
      if (attempt === 1) {
        this.stats.emptySearches++;
        this.log(`搜索 "${keyword}" 无结果，重建会话后再试一次`);
        await sleep(500);
        await this.ensureSession(true);
        continue;
      }
      this.log(`搜索 "${keyword}" 确实没有结果`);
      return [];
    }
    console.warn(`[bili] 搜索 "${keyword}" 多次重试后仍失败，该检索路将没有候选`);
    return [];
  }

  /**
   * 内部：单次搜索，不做重试。
   * @returns {Promise<{list:object[], blocked:boolean}>} blocked=true 表示被风控软拦截
   */
  async #rawSearch(keyword, opts = {}) {
    const { page = 1, pageSize = 20, order = 'totalrank' } = opts;
    const j = await this.signedGet(
      '/x/web-interface/wbi/search/type',
      { search_type: 'video', keyword, page, page_size: pageSize, order },
      { referer: 'https://search.bilibili.com/' }
    );
    this.stats.searches++;

    // ⚠️ B站 风控会返回 code=0 + message=OK，但 data 里只有 v_voucher、没有 result。
    // 这不是「没搜到」，而是「先过验证」。必须区分开，否则整条检索路会被静默吞掉。
    if (j?.data && j.data.v_voucher && !j.data.result) {
      return { list: [], blocked: true };
    }

    if (j.code !== 0) {
      console.warn(`[bili] 搜索 "${keyword}" 返回 code=${j.code} ${j.message ?? ''}`);
      if (j.code === -412 || j.code === -352) {
        await this.ensureSession(true);
        return { list: [], blocked: true };
      }
      return { list: [], blocked: false };
    }

    const list = j?.data?.result ?? [];
    const out = [];
    for (const v of list) {
      const n = normalizeSearchItem(v);
      if (n) out.push(n);
    }
    return { list: out, blocked: false };
  }

  /**
   * 预热并**校验**整条链路：握手 → WBI 签名 → 真实检索。
   * 冷启动时把问题暴露在启动阶段，而不是留给用户的第一次请求。
   */
  async warmup() {
    await this.ensureSession();
    try {
      const probe = await this.searchVideo('周杰伦', { pageSize: 3 });
      const ok = probe.length > 0;
      console.log(ok ? '   ✓ B站 检索链路预热成功' : '   ⚠ B站 检索预热返回空，首个请求可能较慢');
      return ok;
    } catch (e) {
      console.warn('   ⚠ B站 预热失败：', e?.message ?? e);
      return false;
    }
  }

  /** 视频详情：拿到精确秒级时长、简介、分P、字幕信息 */
  async viewVideo(bvid) {
    if (this.viewCache.has(bvid)) return this.viewCache.get(bvid);
    const j = await fetchJSON(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      {
        cookieJar: this.jar,
        limiter: this.limiter,
        headers: { Referer: `https://www.bilibili.com/video/${bvid}` },
      }
    );
    const d = j?.code === 0 ? j.data : null;
    const out = d
      ? {
          bvid: d.bvid,
          title: clean(d.title),
          desc: clean(d.desc || ''),
          durationSec: Number(d.duration) || null,
          owner: d.owner?.name ? clean(d.owner.name) : '',
          view: Number(d.stat?.view) || 0,
          like: Number(d.stat?.like) || 0,
          pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: clean(p.part), duration: p.duration })),
          pic: toBiliUrl(d.pic),
          pubdate: Number(d.pubdate) || 0,
          tname: d.tname || '',
          subtitleCount: d.subtitle?.list?.length ?? 0,
        }
      : null;
    this.viewCache.set(bvid, out);
    return out;
  }

  /** 批量取详情（并发受限） */
  async viewMany(bvids, concurrency = 4) {
    const uniq = [...new Set(bvids)];
    const res = await mapLimit(uniq, concurrency, (b) => this.viewVideo(b));
    const map = new Map();
    uniq.forEach((b, i) => {
      const r = res[i];
      if (r && !r.__error) map.set(b, r);
    });
    return map;
  }

  /** 导出/导入会话，便于在重启后复用，减少握手 */
  exportSession() {
    return { cookies: this.jar.toJSON(), wbi: this.wbi };
  }
  importSession(s) {
    if (!s) return;
    this.jar.loadJSON(s.cookies);
    if (s.wbi?.imgKey) {
      this.wbi = s.wbi;
      this.sessionReady = true;
    }
  }
}
