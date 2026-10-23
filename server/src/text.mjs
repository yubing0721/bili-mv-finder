/**
 * 文本归一化与相似度工具
 *
 * B站标题里混杂着 <em> 高亮标签、HTML 实体、全角符号、书名号等，
 * 必须先归一化才能做可靠的「歌名/歌手是否命中」判断。
 */

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** 解码常见 HTML 实体（含 &#x27; &#39; 这类数字实体） */
export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** 去掉 B站搜索返回的 <em class="keyword"> 等高亮标签 */
export function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]*>/g, '');
}

/** 把标题拆成「主体」与「点缀」两部分，用于更精准的匹配 */
const DECOR = /[【\[（(〔《「『<].*?[】\]）)〕》」』>]/g;

/**
 * 完整清洗：解实体 → 去标签 → NFKC 全角转半角 → 折叠空白
 * @returns {string} 人类可读的干净标题
 */
export function clean(s) {
  if (!s) return '';
  let t = stripHtml(decodeEntities(s));
  t = t.normalize('NFKC');
  // 常见装饰性前缀，如 "【4K修复】"、"【中英字幕】"
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * 紧凑形式：只保留字母、数字、CJK、假名、谚文，其余全部丢弃。
 * 用于「包含」判断，避免空格/标点/全半角造成的假阴性。
 */
export function compact(s) {
  return clean(s)
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9]/gu, '');
}

/** 抽出所有被括号包裹的片段，用于识别 "【中英字幕】" 这类标记 */
export function bracketSegments(s) {
  const t = clean(s);
  const out = [];
  const re = /[【\[（(〔《「『]([^】\]）)〕》」』]*)[】\]）)〕》」』]/g;
  let m;
  while ((m = re.exec(t))) out.push(m[1]);
  return out;
}

/**
 * 去掉装饰性片段后的核心标题，例如：
 *   "【4K修复】周杰伦 - 稻香 MV 2160P修复版" → "周杰伦 - 稻香 MV 2160P修复版"
 * 注意：只去掉「看起来是标记」的片段，避免误删 "歌名(Radio Edit)" 这类信息，
 * 因此这里保留原文，仅额外提供一个「无标记版本」供匹配使用。
 */
export function withoutDecor(s) {
  return clean(s).replace(DECOR, ' ').replace(/\s+/g, ' ').trim();
}

/** 判断是否包含 CJK 汉字 */
export const hasHan = (s) => /\p{Script=Han}/u.test(s || '');
/** 判断是否包含日文假名（区分「日语」与「中文」的关键） */
export const hasKana = (s) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s || '');
/** 判断是否包含韩文谚文 */
export const hasHangul = (s) => /\p{Script=Hangul}/u.test(s || '');
/** 判断是否主要为拉丁字母 */
export const hasLatin = (s) => /[a-zA-Z]/.test(s || '');

/**
 * 最长公共子序列长度，用于歌名模糊命中（应对译名、罗马音、错别字）。
 * 歌名一般很短，LCS 的 O(nm) 完全可接受。
 */
export function lcsLength(a, b) {
  if (!a || !b) return 0;
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return prev[m];
}

/**
 * 窗口式模糊包含。
 *
 * 解决三类真实问题：
 *   1. 繁简差异：网易云「米津玄師」 vs B站「米津玄师」
 *   2. 异体/略写：网易云「殘響散歌」 vs B站「残響散歌」
 *   3. 轻微错别字或空格差异
 *
 * 做法是在 haystack 上滑动一个与 needle 等长的窗口算 LCS 覆盖率。
 * 比「对整段文本算 LCS/needle长度」精确得多 —— 后者会因为 haystack 很长
 * 而让短词偶然凑出高分（假阳性）。
 *
 * @returns {number} 1 = 精确包含；0..1 = 模糊相似度；0 = 不匹配
 */
export function fuzzyContains(needle, hay, minRatio = 0.75) {
  const n = compact(needle);
  const h = compact(hay);
  if (!n || !h) return 0;
  if (h.includes(n)) return 1;
  const w = n.length;
  // 太短的词不做模糊，否则假阳性爆炸
  if (w <= 2) return 0;

  let best = 0;
  for (const w2 of [w - 1, w, w + 1, w + 2]) {
    if (w2 < 2 || w2 > h.length) continue;
    const denom = Math.max(w, w2);
    for (let i = 0; i + w2 <= h.length; i++) {
      const r = lcsLength(n, h.slice(i, i + w2)) / denom;
      if (r > best) best = r;
      if (best === 1) break;
    }
    if (best === 1) break;
  }
  return best >= minRatio ? best : 0;
}

/**
 * 歌名命中强度 0..1
 * 1.0   = 标题中完整包含歌名
 * <1.0  = 模糊命中（繁简/异体/轻微差异），封顶 0.92 以保证精确命中优先
 */
export function titleHitRatio(songTitle, haystack) {
  const a = compact(songTitle);
  const b = compact(haystack);
  if (!a || !b) return 0;
  if (b.includes(a)) return 1;
  // 歌名很短时（如「恋人」「晴天」）不允许模糊，否则误命中极多
  if (a.length <= 2) return 0;
  // 英文单词型歌名：要求整词命中，避免 "Love" 命中 "Lovely"
  if (!hasHan(a) && !hasKana(a) && !hasHangul(a)) {
    const words = clean(songTitle).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length && words.every((w) => b.includes(w))) return 0.95;
  }
  const r = fuzzyContains(songTitle, haystack, 0.78);
  return r ? Math.min(0.92, r * 0.95) : 0;
}

/** 「时长字符串 '4:35' / '1:02:33'」→ 秒 */
export function parseDuration(str) {
  if (str == null) return null;
  if (typeof str === 'number') return str;
  const s = String(str).trim();
  if (!s) return null;
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 秒 → '4:35' */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 播放量友好显示：12345678 → '1234.6万' */
export function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}
