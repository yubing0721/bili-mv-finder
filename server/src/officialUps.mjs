/**
 * 官方 / 唱片公司 / 正规字幕组账号识别。
 *
 * 只作为平局决胜信号使用，权重很低（+6），不会喧宾夺主。
 *
 * 实测踩过的坑：
 *   1. 用精确集合匹配会漏 —— 曲库里写「索尼音乐」，实际 UP 叫「索尼音乐中国」，
 *      所以必须做**子串**匹配。
 *   2. 不能把泛化的「音乐 / music」当作官方特征 ——
 *      「音乐私藏馆」「时光音乐阁」「华语音乐MV」这类高播放搬运号名字里都带「音乐」，
 *      给它们算官方会明显拉低排序质量。
 */

/** 唱片公司 / 版权方 / 平台官方号 / 字幕组 —— 命中即视为可信来源 */
export const OFFICIAL_UP_NAMES = [
  // —— 唱片公司 / 版权方 ——
  '杰威尔音乐', 'JVRMusic', '相信音乐', '滚石唱片', '华纳音乐', 'WarnerMusic',
  '索尼音乐', 'SonyMusic', '环球音乐', 'UniversalMusic', '太合音乐', '摩登天空',
  '时代峰峻', '天娱传媒', '少城时代', 'avex', '爱贝克思', 'BeingGakuen',
  '华研国际', '福茂唱片', '英皇娱乐', 'EEGMusic', '大国文化', '海蝶音乐',
  'SMTOWN', 'JYPEntertainment', 'YGEntertainment', 'HYBELabels',
  // —— 平台官方号 ——
  '网易云音乐', 'QQ音乐', '哔哩哔哩音乐', '大家的音乐机', '哔哩哔哩创作中心',
  // —— 带明确官方标识的艺人/组合号 ——
  'Official髭男dism', 'YOASOBI_Official', 'TaylorSwiftOfficial', 'AimerOfficial',
  'BTSOfficial', 'BLACKPINKOfficial',
  // —— 字幕组 / 正规搬运（双语字幕的常见来源）——
  'WNS_WeNeedBTS', '远鉴字幕组', '凤凰天使TSKS', '神迹字幕组', 'FIX字幕侠',
  '幻月字幕组', '诸神字幕组', '天使动漫字幕组',
];

/**
 * 名称里带这些词，也倾向于「官方 / 正规字幕组」来源。
 *
 * 两个刻意的设计：
 *   1. 不含泛化的「音乐 / music」—— 搬运号名字都带「音乐」。
 *   2. `official` 只认**结尾**形式（"Taylor Swift Official"）。
 *      实测「Official制作工作室」这种粉丝号用的是 "Official" 开头 + 中文后缀，
 *      若宽松匹配 official 就会把它当官方，反而把真正的官方 MV 挤下去。
 *      以 Official 开头的真实官方名（如 Official髭男dism）走白名单。
 */
export const OFFICIAL_UP_PATTERN =
  /官方|唱片|records?\b|entertainment|字幕组|subs?team|中字组|翻译组|official\s*$/im;

/**
 * 归一化：转小写后去掉所有非字母数字/汉字/假名/谚文字符。
 *
 * ⚠️ 顺序很重要：必须**先 toLowerCase 再去字符**。
 * 曾经写成「先去字符再去小写」，而白名单里只写了 a-z0-9，
 * 于是大写字母被当成非法字符删掉："Music" → "usic"、"WNS_WeNeedBTS" → "eeed"，
 * 结果 JVRMusic 压缩成 "usic" 后与「那歌Music」发生子串命中，把搬运号误判成官方。
 */
export function compactName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9]/gu, '');
}

/** 是否包含中日韩字符（用于决定子串匹配的长度门槛） */
function hasCJK(s) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(String(s || ''));
}

/**
 * 白名单匹配策略：
 *   - 中文/日文/韩文名 ≥3 字：允许子串（「索尼音乐」要能命中「索尼音乐中国」）
 *   - 纯拉丁名 ≥6 字符：允许子串（JVRMusic / WarnerMusic 等足够长，不易误伤）
 *   - 其余（短拉丁名如 avex）：必须全等
 * 这样既解决了「索尼音乐中国」，又避免短名到处误命中。
 */
export function officialNameMatches(compactAuthor, compactCandidateName) {
  if (!compactAuthor || !compactCandidateName) return false;
  if (compactAuthor === compactCandidateName) return true;
  if (hasCJK(compactCandidateName)) return compactCandidateName.length >= 3 && compactAuthor.includes(compactCandidateName);
  return compactCandidateName.length >= 6 && compactAuthor.includes(compactCandidateName);
}

/**
 * 预编译白名单：在 match.mjs 里构建一次即可
 * @param {string[]} names
 * @returns {Set<string>} compact 后的集合
 */
export function buildOfficialSet(names = OFFICIAL_UP_NAMES) {
  return new Set(names.map(compactName).filter((n) => n.length >= 3));
}

/** 调试用：列出所有命中的白名单条目 */
export function allOfficialMatches(author, curated) {
  const c = compactName(author);
  if (!c || !curated) return [];
  return [...curated].filter((n) => officialNameMatches(c, n));
}

/**
 * 判断 UP 是否为官方/可信来源，返回命中的名字（便于在 UI 里解释）
 * @param {string} author
 * @param {Set<string>} [curated] compact 后的白名单集合
 * @returns {string|null}
 */
export function matchedOfficialName(author, curated) {
  if (!author) return null;
  const c = compactName(author);
  if (!c) return null;
  if (curated) {
    for (const name of curated) {
      if (officialNameMatches(c, name)) return name;
    }
  }
  const m = String(author).match(OFFICIAL_UP_PATTERN);
  return m ? m[0] : null;
}

/** 布尔版本 */
export function isOfficialUp(author, curated) {
  return matchedOfficialName(author, curated) !== null;
}
