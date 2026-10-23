/**
 * 网络基础设施：Cookie 会话、全局限流、风控重试。
 *
 * B站 的 412 风控既和「有无 cookie」有关，也和请求速率有关。
 * 因此这里做三件事：
 *   1. 维护一个持久 cookie jar（buvid3 是搜索接口的硬门槛）
 *   2. 全局最小请求间隔（默认 250ms），避免突发被限速
 *   3. 遇到 412 / -352 / -403 时指数退避重试，并强制刷新会话
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 极简 cookie jar —— 只需要保存键值对，够用且零依赖 */
export class CookieJar {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
  }
  absorbSetCookie(getSetCookie = []) {
    for (const raw of getSetCookie) {
      const first = String(raw).split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) {
        const k = first.slice(0, i).trim();
        const v = first.slice(i + 1).trim();
        if (k) this.map.set(k, v);
      }
    }
  }
  absorbString(str) {
    if (!str) return;
    for (const part of String(str).split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  has(k) {
    return this.map.has(k);
  }
  get(k) {
    return this.map.get(k);
  }
  set(k, v) {
    this.map.set(k, v);
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  toJSON() {
    return Object.fromEntries(this.map);
  }
  loadJSON(obj) {
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) this.map.set(k, String(v));
    }
  }
}

/** 全局限流器：保证任意两次请求之间至少间隔 minIntervalMs */
export class RateLimiter {
  constructor(minIntervalMs = 250) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.chain = Promise.resolve();
  }
  /** 排队等待，返回一个 promise，resolve 后即可发请求 */
  acquire() {
    const run = async () => {
      const now = Date.now();
      const wait = Math.max(0, this.last + this.minIntervalMs - now);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    };
    // 串行化，避免并发请求同时通过检查
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** 判断是否为需要重试的风控类失败 */
export function isRiskControl(status, bodyText) {
  if (status === 412 || status === 429 || status === 403) return true;
  if (typeof bodyText === 'string' && /"code":\s*(-352|-403|-412|-509)/.test(bodyText)) return true;
  return false;
}

/**
 * 带限流 + 重试的 JSON 请求
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, cookieJar?:CookieJar, limiter?:RateLimiter,
 *          retries?:number, timeoutMs?:number, onRiskControl?:() => Promise<void>|void}} opts
 */
export async function fetchJSON(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    cookieJar,
    limiter,
    retries = 3,
    timeoutMs = 15000,
    onRiskControl,
    /** 为 true 时不解析 JSON，直接返回响应文本（用于拿 cookie 的 HTML 页面） */
    expectText = false,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (limiter) await limiter.acquire();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const h = { 'User-Agent': DEFAULT_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers };
      if (cookieJar && cookieJar.header()) h.Cookie = cookieJar.header();
      const res = await fetch(url, { method, headers: h, signal: ac.signal });
      const text = await res.text();
      if (cookieJar) {
        const sc = res.headers.getSetCookie?.() ?? [];
        cookieJar.absorbSetCookie(sc);
      }
      if (isRiskControl(res.status, text)) {
        lastErr = new HttpError(`风控拦截 HTTP ${res.status}`, { status: res.status, body: text.slice(0, 200) });
        if (onRiskControl) await onRiskControl();
        // 退避：1s, 2.5s, 5s
        await sleep(1000 * Math.pow(2.5, attempt));
        continue;
      }
      if (!res.ok) {
        throw new HttpError(`HTTP ${res.status} ${url.slice(0, 120)}`, { status: res.status, body: text.slice(0, 300) });
      }
      if (expectText) return text;
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(`响应非 JSON: ${text.slice(0, 160)}`, { status: res.status, body: text.slice(0, 160) });
      }
    } catch (e) {
      lastErr = e;
      // 网络层错误也重试，但 4xx（非风控）不重试
      if (e instanceof HttpError && e.status && e.status < 500 && !isRiskControl(e.status)) throw e;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new HttpError('请求失败');
}

/** 并发池：限制同时进行的任务数，返回结果数组（保持输入顺序） */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: e?.message ?? String(e) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
