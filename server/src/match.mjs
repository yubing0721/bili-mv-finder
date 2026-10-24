/**
 * 核心匹配算法
 *
 * 为什么需要自己排序：B站 的 totalrank 对「歌名 + 歌手」这类检索非常不准，
 * 实测搜 "米津玄師 Lemon MV" 会混进 Reaction、教学、花絮、KTV 伴奏。
 * 而找 MV 这件事其实有很强的结构化信号可用：
 *   - 标题必须命中歌名与歌手
 *   - 时长必须和网易云的音频时长接近（官方 MV 通常略长，因为有前奏/尾奏）
 *   - 外语歌要看标题/简介/标签里有没有双语字幕标记
 *   - 大量「非 MV」内容有稳定的关键词特征（合集/翻唱/教学/二创）
 *
 * 所以策略是：多路关键词并行检索 → 融合去重 → 用上述信号重排序 → 输出带解释的候选列表。
 */
import { compact, clean, titleHitRatio, fuzzyContains, formatDuration, hasHan, hasKana, hasHangul } from './text.mjs';
import { detectLang, buildQueries, needsBilingual, BILINGUAL_MARKERS, MV_MARKERS, NEGATIVE_MARKERS, LANG } from './lang.mjs';
import { mapLimit } from './http.mjs';
import { matchedOfficialName, buildOfficialSet } from './officialUps.mjs';

/** 白名单的 compact 形式，构建一次复用 */
const CURATED_OFFICIAL = buildOfficialSet();

/** 打分权重（可按需调参） */
export const WEIGHTS = {
  title: 42,
  artist: 20,
  duration: 24,
  mv: 12,
  /** 双语字幕权重 —— 本项目的核心诉求，所以给得比「MV 信号」还高 */
  bilingual: 30,
  bilingualQueryBonus: 5,
  /** 外语歌里完全没字幕的候选要被扣分，否则无字幕高播放版会一直压过双语版 */
  noSubtitlePenalty: 14,
  /**
   * 用户关掉「外语歌优先双语」时的双语权重。
   * 必须显著低于 bilingual(30)，否则开关形同虚设 ——
   * 只取消「无字幕降权」而保留 30 分权重的话，关掉开关后榜首依旧是带字幕的版本，
   * UI 上那句「纯粹按最像官方 MV 排序」就成了假话。
   */
  bilingualOff: 0,
  /** 默认（双语优先）时的播放量权重 */
  play: 7,
  /** 关闭双语优先后：播放 / 弹幕 / 本家投稿成为主要信号 */
  playPriority: 26,
  danmakuPriority: 12,
  nativeUpload: 24,
  mvCategory: 4,
  /** 官方账号是强可信来源：明显高于平局决胜，但仍低于歌名/歌手/时长 */
  officialUp: 26,
  /** 正规字幕组：可信但不是官方，给中等权重 */
  officialTrusted: 12,
  /** 只是账号名带 official/官方 标识，未验证是否与歌曲相关：弱信号 */
  officialGeneric: 6,
  /** 官方账号发布的「正片」（有 MV 标识、标题命中、无降权特征）再追加，用于压过饭制/搬运版 */
  officialMainMv: 22,
};

/**
 * 抓出标题里《》『』「」这类「主标题引号」内的内容。
 * 中文 MV 标题习惯把真正的歌名放进这些引号，因此它是判断
 * 「标题里出现的歌名到底是不是这首歌」的强信号。
 * 刻意不含【】—— 那里通常是「4K修复 / 中字」这类装饰。
 */
const PRIMARY_QUOTE_RE = /《([^》]*)》|『([^』]*)』|「([^」]*)」/g;
export function primaryQuotedText(title) {
  const out = [];
  const s = String(title || '');
  PRIMARY_QUOTE_RE.lastIndex = 0;
  let m;
  while ((m = PRIMARY_QUOTE_RE.exec(s))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.join(' ');
}

/** 时序信号：网易云音频时长 vs B站视频时长 */
function scoreDuration(songSec, videoSec) {
  if (!songSec || !videoSec) return { score: WEIGHTS.duration * 0.4, reason: '时长未知' };
  const d = videoSec - songSec; // 正数 = 视频比音频长
  const a = Math.abs(d);
  if (a <= 4) return { score: WEIGHTS.duration, reason: '时长完全吻合' };
  if (d >= 0 && d <= 30) return { score: WEIGHTS.duration * 0.92, reason: `时长吻合(+${d}s 前奏/尾奏)` };
  if (d < 0 && d >= -10) return { score: WEIGHTS.duration * 0.7, reason: `略短(${d}s)` };
  if (d > 30 && d <= 60) return { score: WEIGHTS.duration * 0.55, reason: `偏长(+${d}s)` };
  if (d < -10 && d >= -35) return { score: WEIGHTS.duration * 0.4, reason: `偏短(${d}s)` };
  if (a <= 95) return { score: WEIGHTS.duration * 0.18, reason: `时长偏差 ${a}s` };
  return { score: 0, reason: `时长严重不符(${a}s)` };
}

/**
 * 明确声明「没有字幕」的写法。标题里写了这些就一定不该拿字幕学分。
 * 实测 [Taylor Swift] 重录版 Love Story MV「无字幕」曾因通用规则看到「字幕」
 * 两个字而拿到 0.4 强度，白送 12 分。
 */
const NO_SUBTITLE_RE = /无字幕|無字幕|没有字幕|沒有字幕|不带字幕|不帶字幕|无中字|無中字|no\s*subs?\b|without\s*subs?\b/i;

/**
 * 判断字幕声称翻译的是哪个外语。
 * 「中日双语」→ ja，「中英字幕」→ en，「中韩双字」→ ko。
 * 识别不出（只写「双语字幕」）则返回 null。
 */
export function subtitleLangOf(text) {
  const t = clean(text).toLowerCase();
  if (/中日|日中|日文|日本語|日语|japanese/.test(t)) return 'ja';
  if (/中韩|韩中|韩文|한국|韩语|korean/.test(t)) return 'ko';
  if (/中英|英中|英文|英语|english/.test(t)) return 'en';
  if (/中法|法中|法文|法语|french/.test(t)) return 'fr';
  if (/中德|德中|德文|德语|german/.test(t)) return 'de';
  if (/中俄|俄中|俄文|俄语|russian/.test(t)) return 'ru';
  if (/中西|西中|西班牙|spanish/.test(t)) return 'es';
  return null;
}

/**
 * 双语字幕识别：返回 0..1 强度
 *
 * @param {string} text
 * @param {string} [songLang] 歌曲语种。传入时会做**语种对齐**：
 *   给日语歌匹配到「中英字幕」的视频，多半是英文改编版而不是日文原版，
 *   因此只给一半学分（实测 YOASOBI《夜に駆ける》的第一名曾是
 *   它的英文版「Into The Night」）。不传则退化为纯「有没有字幕」判断。
 */
export function bilingualStrength(text, songLang) {
  const t = clean(text).toLowerCase();
  if (!t) return 0;
  if (NO_SUBTITLE_RE.test(t)) return 0;

  // 结构特征
  const hasSubWord = /字幕|subtitle|\bsubs?\b/.test(t);
  /** 语言对，如 中日 / 日中 / 中英 / 中韩 / 中法 … */
  const langPair = /中[日英韩法德俄西意葡泰越印阿]|[日英韩法德俄西意葡泰越印阿]中/.test(t);
  /** 双语 / 双字 / 对照 */
  const bilingualWord = /双语|双字|对照/.test(t);
  /** 明确的中文字幕（单语） */
  const chineseSub =
    /中字|中文字幕|中文翻译|中译|官方中字|简繁字幕|cc字幕|字幕版|带字幕|有字幕|字幕组|中文字/.test(t);

  let strength = 0;
  if (bilingualWord && (langPair || hasSubWord || /中文/.test(t))) {
    // 最强：明确说了双语，且有语言对或字幕字样
    strength = 1;
  } else if (langPair && hasSubWord) {
    // 语言对 + 字幕，如「中英字幕」「中日罗马音字幕」
    strength = 1;
  } else if (bilingualWord) {
    // 只写「双语」，没说字幕
    strength = 0.8;
  } else if (chineseSub) {
    // 明确有中文字幕，但不保证是双语
    strength = 0.75;
  } else if (hasSubWord) {
    // 只提了「字幕」，语种不明
    strength = 0.45;
  }

  if (!strength) return 0;

  // 语种对齐：字幕声称的语种和歌曲语种不一致 → 打折
  const claimed = subtitleLangOf(t);
  if (claimed && songLang && claimed !== songLang) return Number((strength * 0.5).toFixed(3));
  return strength;
}

/** MV / 官方影像信号：返回 0..1 */
export function mvStrength(title, typename = '') {
  const t = clean(title).toLowerCase();
  let s = 0;
  // "MV" 作为独立词出现（避免命中 "mvp" 之类）
  if (/(^|[^a-z])mv([^a-z]|$)/i.test(t)) s = Math.max(s, 1);
  if (/music\s*video|official\s*video|pv\b|官方版|官方mv|公式/.test(t)) s = Math.max(s, 0.95);
  if (/官方|official/.test(t)) s = Math.max(s, 0.8);
  if (/1080p|2160p|4k|8k|高清|超清|修复|最高画质|蓝光/.test(t)) s = Math.max(s, 0.72);
  if (typename === 'MV') s = Math.max(s, 0.95);
  if (typename === '音乐' || typename === '音乐综合') s = Math.max(s, 0.5);
  return s;
}

/** 负向特征：返回 {penalty, tags[]} */
export function negativeSignals(title, songSec, videoSec) {
  const t = clean(title);
  let penalty = 0;
  const tags = [];
  for (const { re, penalty: p, tag } of NEGATIVE_MARKERS) {
    if (re.test(t)) {
      penalty += p;
      tags.push(tag);
    }
  }
  // 超长视频 vs 短歌 → 几乎一定是合集
  if (songSec && videoSec && videoSec > 900 && videoSec > songSec * 4) {
    penalty += 45;
    tags.push('超长');
  }
  return { penalty, tags };
}

/**
 * 给单个候选打分
 * @param {object} song 网易云 Song
 * @param {object} cand B站 规范化候选
 * @param {{lang:string, queryKind:string, sources?:Set<string>|string[], officialUps?:Set<string>}} ctx
 */
export function scoreCandidate(song, cand, ctx) {
  const reasons = [];
  const lang = ctx.lang || detectLang(song).lang;
  const foreign = needsBilingual(lang);

  // 文本分三层，因为它们的可信度差别很大：
  //   title —— 权威，歌名/歌手必须在这里出现
  //   aux   —— 简介 + 标签，噪声大，只能给部分学分
  //   up    —— UP 名，只用于「UP 就是歌手/字幕组」这类判断
  const aux = [cand.description, cand.tag].filter(Boolean).join(' ');
  const hay = [cand.title, aux].filter(Boolean).join(' ');
  const hayWithUp = `${hay} ${cand.author || ''}`;

  // ---- 1. 歌名命中 ----
  // 关键：必须以**标题**为准。简介和标签只给 55% 学分 ——
  // 实测 Adele《Hello》的最佳匹配曾是一档 SNL 感恩节合集，
  // 只因为它的简介里出现了 "hello"。
  const names = [song.title, ...(song.aliases || [])].filter(Boolean);
  let bestNameHit = 0;
  let titleOnlyHit = 0;
  let hitName = '';
  for (const n of names) {
    const inTitle = titleHitRatio(n, cand.title);
    const inAux = aux ? titleHitRatio(n, aux) * 0.55 : 0;
    const r = Math.max(inTitle, inAux);
    if (r > bestNameHit) {
      bestNameHit = r;
      hitName = n;
    }
    if (inTitle > titleOnlyHit) titleOnlyHit = inTitle;
  }
  const titleScore = bestNameHit * WEIGHTS.title;
  if (titleOnlyHit >= 1) reasons.push(`标题含歌名「${hitName}」`);
  else if (bestNameHit >= 1) reasons.push(`简介/标签含歌名「${hitName}」(标题无)`);
  else if (bestNameHit > 0.55) reasons.push(`歌名近似命中(${Math.round(bestNameHit * 100)}%)`);
  else reasons.push('标题未命中歌名');

  // ---- 2. 歌手命中 ----
  const artists = [...(song.artists || []), ...(song.artistAliases || [])].filter(Boolean);
  let artistHit = 0;
  let hitArtist = '';
  /** UP 名与歌手名严格一致（用于「本家投稿」加分，不含粉丝团/搬运号） */
  let upIsArtist = false;
  const compactAuthor = compact(cand.author || '');
  const compactTitle = compact(cand.title);
  const compactHay = compact(hay);
  for (const a of artists) {
    const ca = compact(a);
    if (!ca || ca.length < 2) continue;
    // ① 标题里出现歌手 → 满学分
    if (compactTitle.includes(ca)) {
      artistHit = 1;
      hitArtist = a;
      break;
    }
    // 模糊包含（处理繁简差异：米津玄師 / 米津玄师）
    // 阈值取 0.72：「米津玄師 / 米津玄师」这类繁简单字差异是 3/4 = 0.75，
    // 必须放行，否则歌手分归零、正确的双语版本会被挤下去。
    const fzTitle = fuzzyContains(a, cand.title, 0.72);
    if (fzTitle >= 0.72) {
      const v = fzTitle >= 0.999 ? 1 : 0.92;
      if (v > artistHit) {
        artistHit = v;
        hitArtist = a;
      }
    }
    // ② 只在简介/标签里出现 → 只给部分学分。
    //    实测《稻香》的第一名是个杯子敲击表演，只因简介里写了「周杰伦」。
    if (compactHay.includes(ca) || (aux && fuzzyContains(a, aux, 0.78) >= 0.78)) {
      if (artistHit < 0.6) {
        artistHit = 0.6;
        hitArtist = a;
      }
    }
    // ③ UP 名就是歌手本人/官方号
    if (compactAuthor.includes(ca) || fuzzyContains(a, cand.author || '', 0.8) >= 0.8) {
      if (artistHit < 0.85) {
        artistHit = 0.85;
        hitArtist = a;
      }
    }
  }
  // 本家投稿：单独判断，避免上面的 break 提前退出（标题命中歌手时很常见）。
  // 必须「长度接近 + 高度相似」才算，不能只看子串 ——
  // 否则「周杰伦粉丝团」也会被当成歌手本人。
  for (const a of artists) {
    const ca = compact(a);
    if (!ca) continue;
    const near = compactAuthor.length <= ca.length + 1;
    if (compactAuthor === ca || (near && fuzzyContains(a, cand.author || '', 0.7) >= 0.7)) {
      upIsArtist = true;
      break;
    }
  }
  const artistScore = artistHit * WEIGHTS.artist;
  if (artistHit >= 0.95) reasons.push(`歌手命中「${hitArtist}」`);
  else if (artistHit >= 0.8) reasons.push(`UP 为「${hitArtist}」相关账号`);
  else if (artistHit >= 0.5) reasons.push(`歌手仅出现在简介/标签「${hitArtist}」`);
  else if (artistHit > 0) reasons.push(`歌手近似命中「${hitArtist}」`);
  else reasons.push('未命中歌手');

  // ---- 2b. 歌名只出现在引文里 → 降权 ----
  // 实测搜《晴天》时，「《那天下雨了》"我应该对你唱着晴天"」排到了正牌 MV 前面 ——
  // 因为歌名恰好出现在引号里的歌词引用中。正主标题是《那天下雨了》。
  let quotePenalty = 0;
  const quoted = primaryQuotedText(cand.title);
  if (quoted && titleOnlyHit >= 0.9) {
    const inQuote = names.some((n) => titleHitRatio(n, quoted) >= 0.9);
    if (!inQuote) {
      quotePenalty = 18;
      reasons.push('歌名只在引文/歌词里出现，主标题是另一首歌');
    }
  }

  // ---- 3. 时长 ----
  const dur = scoreDuration(song.durationSec, cand.durationSec);
  reasons.push(dur.reason);

  // ---- 4. MV 信号 ----
  const mv = mvStrength(cand.title, cand.typename);
  const mvScore = mv * WEIGHTS.mv;
  if (mv >= 0.9) reasons.push('明确是 MV/官方影像');
  else if (mv >= 0.7) reasons.push('高画质影像');

  // ---- 5. 双语字幕（仅外语歌）----
  let biScore = 0;
  let biHit = 0;
  let noSubPenalty = 0;
  const biPreferred = ctx.preferBilingual !== false;
  if (foreign) {
    // 用含 UP 名的文本：字幕组账号名本身就是「有字幕」的强信号
    // 同时传入语种，让「中日双语」和「中英双语」对同一首歌区分对待
    biHit = bilingualStrength(hayWithUp, lang);
    if (biPreferred) {
      // —— 双语优先模式（默认）：字幕本身就是主要目标之一 ——
      biScore = biHit * WEIGHTS.bilingual;
      if (biHit >= 1) reasons.push('★ 带中外双语字幕');
      else if (biHit > 0.5) reasons.push('带中文字幕');
      // 由「双语关键词」这条检索路召回的，额外加权
      const fromBilingualQuery = String(ctx.queryKind || '').startsWith('bilingual');
      if (fromBilingualQuery && biHit > 0) biScore += WEIGHTS.bilingualQueryBonus;
      // 多处来源都命中（基础路 + 双语路都找回同一个视频）→ 更可信
      const sources = ctx.sources instanceof Set ? [...ctx.sources] : ctx.sources || [];
      if (biHit > 0 && sources.some((s) => String(s).startsWith('bilingual'))) biScore += 3;
      // 外语歌里没字幕的：主动扣分（这是「外语歌优先双语」诉求的直接体现）
      if (biHit === 0) {
        noSubPenalty = WEIGHTS.noSubtitlePenalty;
        reasons.push(`无字幕（外语歌降权 -${noSubPenalty}）`);
      }
    }
    // 关闭双语优先时：字幕不参与排序，也不再把双语检索路算进来
  }

  // ---- 6. 播放量 / 弹幕（关闭双语优先后变成主要热度信号）----
  const play = Math.max(0, Number(cand.play) || 0);
  const playCap = biPreferred ? WEIGHTS.play : WEIGHTS.playPriority;
  const playScore = Math.min(playCap, (Math.log10(play + 1) / Math.log10(3_000_000)) * playCap);

  const danmaku = Math.max(0, Number(cand.danmaku) || 0);
  const danmakuScore = biPreferred
    ? 0
    : Math.min(WEIGHTS.danmakuPriority, (Math.log10(danmaku + 1) / Math.log10(200_000)) * WEIGHTS.danmakuPriority);

  // 本家投稿：只有关闭双语优先后才加分（默认模式下官方号已经有独立权重）
  const nativeScore = !biPreferred && upIsArtist ? WEIGHTS.nativeUpload : 0;
  if (nativeScore) reasons.push('本家投稿（UP 为歌手本人）');

  // ---- 7. 分区加成 ----
  const catScore = cand.typename === 'MV' ? WEIGHTS.mvCategory : 0;

  // ---- 8. 官方 UP 加成（分级）----
  // 名字里带 official 不等于官方：粉丝号「阿赫official」曾因此被顶到第一。
  // 只有白名单、正规字幕组，或「带 MV 标识且标题命中」的官方账号才拿高分。
  const curatedOfficial = ctx.officialUps ?? CURATED_OFFICIAL;
  const officialHitName = matchedOfficialName(cand.author, curatedOfficial);
  const isCurated = Boolean(officialHitName) && curatedOfficial.has(officialHitName);
  const isSubtitleGroup = /字幕组|subs?team|中字组|翻译组/i.test(cand.author || '');
  const neg = negativeSignals(cand.title, song.durationSec, cand.durationSec);
  let upScore = 0;
  let officialKind = '';
  if (officialHitName) {
    if (isCurated) {
      upScore = WEIGHTS.officialUp;
      officialKind = 'curated';
    } else if (isSubtitleGroup) {
      upScore = WEIGHTS.officialTrusted;
      officialKind = 'subtitle';
    } else if (mv >= 0.9 && titleOnlyHit >= 0.85 && neg.tags.length === 0) {
      upScore = WEIGHTS.officialUp;
      officialKind = 'officialMv';
    } else {
      upScore = WEIGHTS.officialGeneric;
      officialKind = 'handle';
    }
  }
  if (upScore) {
    reasons.push(
      officialKind === 'curated' || officialKind === 'officialMv'
        ? `官方账号（命中「${officialHitName}」）`
        : officialKind === 'subtitle'
          ? '正规字幕组账号'
          : '账号名含官方标识（弱信号）'
    );
  }

  // ---- 9. 负向 ----
  if (neg.tags.length) reasons.push(`降权: ${[...new Set(neg.tags)].join('/')}`);

  // ---- 9b. 官方正片追加 ----
  // 只给「官方账号 + 标题有 MV 标识 + 歌名命中 + 没有任何降权特征」的候选，
  // 避免官方发的钢琴版、巡演片段、预告也被一并抬高。
  const officialMain = upScore === WEIGHTS.officialUp && mv >= 0.9 && titleOnlyHit >= 0.85 && neg.tags.length === 0
    ? WEIGHTS.officialMainMv
    : 0;
  if (officialMain) reasons.push('官方账号发布的官方影像');

  // ---- 10. 标题完全没命中歌名 → 几乎肯定不是 ----
  // 用 titleOnlyHit 而不是 bestNameHit：标题里压根没有歌名的内容，
  // 无论是翻唱、花絮、合集还是无关视频，都不该排在前面。
  let hardPenalty = 0;
  if (titleOnlyHit === 0) hardPenalty += 55;
  else if (titleOnlyHit < 0.34) hardPenalty += 30;

  const score =
    titleScore +
    artistScore +
    dur.score +
    mvScore +
    biScore +
    playScore +
    danmakuScore +
    nativeScore +
    catScore +
    upScore +
    officialMain -
    neg.penalty -
    hardPenalty -
    noSubPenalty -
    quotePenalty;

  // 防御：任何一项权重写错（例如漏了某个 WEIGHTS 字段）都会让整条分数变成 NaN。
  // 而 JSON 会把 NaN 序列化成 null，导致前端排序彻底失效且毫无报错 ——
  // 实测踩过一次（WEIGHTS.bilingualOff 未定义），所以这里显式兜底。
  const safe = (n) => (Number.isFinite(n) ? n : 0);
  if (!Number.isFinite(score)) {
    reasons.push('⚠ 内部评分异常，已按 0 处理');
    console.error('[match] 评分出现 NaN，请检查 WEIGHTS 是否缺少字段。cand=', cand.bvid);
  }

  return {
    score: Number(safe(score).toFixed(2)),
    breakdown: {
      title: Number(safe(titleScore).toFixed(1)),
      artist: Number(safe(artistScore).toFixed(1)),
      duration: Number(safe(dur.score).toFixed(1)),
      mv: Number(safe(mvScore).toFixed(1)),
      bilingual: Number(safe(biScore).toFixed(1)),
      play: Number(safe(playScore).toFixed(1)),
      danmaku: Number(safe(danmakuScore).toFixed(1)),
      nativeUpload: nativeScore,
      category: catScore,
      officialUp: upScore,
      officialMain,
      penalty: Number((neg.penalty + hardPenalty + noSubPenalty + quotePenalty).toFixed(1)),
      noSubtitle: noSubPenalty,
      quote: quotePenalty,
    },
    nameHit: Number(bestNameHit.toFixed(2)),
    titleOnlyHit: Number(titleOnlyHit.toFixed(2)),
    artistHit,
    bilingualHit: Number(safe(biHit).toFixed(2)),
    mvHit: Number(safe(mv).toFixed(2)),
    negativeTags: [...new Set(neg.tags)],
    reasons,
  };
}

// 模块加载时校验权重表，避免再次出现「漏字段 → 分数全 NaN」这种静默故障。
// NaN 被 JSON 序列化成 null 后，前端排序会彻底失效且看不到任何报错。
for (const [k, v] of Object.entries(WEIGHTS)) {
  if (!Number.isFinite(v)) throw new Error(`WEIGHTS.${k} 必须是数字，实际是 ${v}`);
}

/** 该歌曲理论上能拿到的最高分，用于归一化出置信度 */
export function maxScoreFor(lang, preferBilingual = true) {
  const bi = needsBilingual(lang) && preferBilingual ? WEIGHTS.bilingual + WEIGHTS.bilingualQueryBonus + 3 : 0;
  return (
    WEIGHTS.title +
    WEIGHTS.artist +
    WEIGHTS.duration +
    WEIGHTS.mv +
    bi +
    (preferBilingual ? WEIGHTS.play : WEIGHTS.playPriority + WEIGHTS.danmakuPriority + WEIGHTS.nativeUpload) +
    WEIGHTS.mvCategory +
    WEIGHTS.officialUp +
    WEIGHTS.officialMainMv
  );
}

function confidenceOf(score, lang, nameHit, preferBilingual = true) {
  const ratio = score / maxScoreFor(lang, preferBilingual);
  if (nameHit >= 0.95 && ratio >= 0.6) return 'high';
  if (nameHit >= 0.6 && ratio >= 0.42) return 'medium';
  if (ratio >= 0.52) return 'medium';
  return 'low';
}

/**
 * 为一首歌找 MV
 * @param {import('./bilibili.mjs').BilibiliClient} bili
 * @param {object} song
 * @param {{topN?:number, perQuery?:number, enrich?:boolean, lang?:string, maxQueries?:number,
 *          onProgress?:(msg:object)=>void, officialUps?:Set<string>, signal?:{aborted:boolean}}} [opts]
 */
export async function matchSong(bili, song, opts = {}) {
  const { topN = 6, perQuery = 30, enrich = false, maxQueries = 5, preferBilingual = true } = opts;
  const detected = opts.lang ? { lang: opts.lang, confidence: 1, reason: 'user' } : detectLang(song);
  const lang = detected.lang;
  const foreign = needsBilingual(lang);

  let queries = buildQueries(song, lang, { bilingualFirst: foreign && preferBilingual });
  // 关闭双语优先时不再消耗请求预算在双语检索路上，改由基础/MV/官方路召回
  if (!preferBilingual) queries = queries.filter((q) => !q.kind.startsWith('bilingual'));
  // 双语优先：外语歌优先跑双语路，保证有限请求预算花在关键检索上
  if (foreign && preferBilingual && maxQueries) {
    const bi = queries.filter((q) => q.kind.startsWith('bilingual'));
    const rest = queries.filter((q) => !q.kind.startsWith('bilingual'));
    queries = [...bi, ...rest];
  }
  if (maxQueries) queries = queries.slice(0, maxQueries);

  // ---- 多路并行检索（受全局限流器约束）----
  const perQueryResults = await mapLimit(queries, Math.min(3, queries.length), async (q) => {
    if (opts.signal?.aborted) return { q, list: [] };
    const list = await bili.searchVideo(q.query, { pageSize: perQuery });
    return { q, list };
  });

  // ---- 融合去重：记录每个候选被哪些检索路召回 ----
  /** @type {Map<string, {cand:object, sources:Set<string>, bestKind:string}>} */
  const pool = new Map();
  let rawCount = 0;
  for (let i = 0; i < perQueryResults.length; i++) {
    const r = perQueryResults[i];
    if (!r || r.__error) continue;
    const q = r.q ?? queries[i];
    for (const cand of r.list) {
      rawCount++;
      const k = cand.bvid;
      if (!pool.has(k)) {
        pool.set(k, { cand, sources: new Set(), bestKind: q.kind, bestWeight: q.weight });
      }
      const entry = pool.get(k);
      entry.sources.add(q.kind);
      if (q.weight > entry.bestWeight) {
        entry.bestWeight = q.weight;
        entry.bestKind = q.kind;
      }
    }
  }

  // ---- 打分 ----
  let scored = [...pool.values()].map(({ cand, sources, bestKind }) => {
    const s = scoreCandidate(song, cand, {
      lang,
      queryKind: bestKind,
      sources,
      officialUps: opts.officialUps,
      preferBilingual,
    });
    return { ...cand, ...s, sources: [...sources] };
  });

  scored.sort((a, b) => b.score - a.score);

  // ---- 可选：对头部候选取详情，拿到精确秒级时长与完整简介，重算一次 ----
  if (enrich && scored.length) {
    const head = scored.slice(0, Math.max(topN, 3));
    const details = await bili.viewMany(
      head.map((x) => x.bvid),
      3
    );
    for (const item of head) {
      const d = details.get(item.bvid);
      if (!d) continue;
      if (d.durationSec) {
        item.durationSec = d.durationSec;
        item.durationText = formatDuration(d.durationSec);
      }
      if (d.desc) item.description = d.desc;
      if (d.owner) item.author = d.owner;
      if (d.view) item.play = Math.max(item.play, d.view);
      if (d.pic) item.cover = d.pic;
      if (d.tname) item.typename = d.tname || item.typename;
      if (d.pages?.length > 1) item.multiPart = d.pages.length;
      const s = scoreCandidate(song, item, {
        lang,
        queryKind: item.sources?.find((x) => x.startsWith('bilingual')) ?? 'base',
        sources: item.sources,
        officialUps: opts.officialUps,
        preferBilingual,
      });
      Object.assign(item, s);
    }
    scored.sort((a, b) => b.score - a.score);
  }

  const candidates = scored.slice(0, topN).map((c) => ({
    ...c,
    confidence: confidenceOf(c.score, lang, c.nameHit, preferBilingual),
    durationText: c.durationText || formatDuration(c.durationSec),
  }));

  const best = candidates[0] ?? null;
  return {
    song,
    lang,
    langLabel: lang,
    langConfidence: detected.confidence,
    bilingualNeeded: foreign,
    preferBilingual,
    /** 整体判定：这首歌找到 MV 的把握 */
    confidence: best ? best.confidence : 'none',
    best,
    candidates,
    meta: {
      queries: queries.map((q) => ({ query: q.query, kind: q.kind })),
      rawCandidates: rawCount,
      uniqueCandidates: pool.size,
      maxScore: maxScoreFor(lang, preferBilingual),
    },
  };
}

/** 单曲手动搜索（App 里「换一个」时用），不做多路融合，直接给重排后的候选 */
export async function searchCandidates(bili, { title, artists = [], durationSec = null, lang, topN = 12, extraKeyword = '', preferBilingual = true }) {
  const song = {
    id: 'manual',
    title,
    artists,
    artistText: artists.join(' / '),
    aliases: [],
    durationSec,
    artistAliases: [],
  };
  const detected = lang ? { lang } : detectLang(song);
  const base = `${title} ${artists[0] ?? ''} ${extraKeyword}`.replace(/\s+/g, ' ').trim();
  const list = await bili.searchVideo(base, { pageSize: 30 });
  const scored = list
    .map((cand) => ({
      ...cand,
      ...scoreCandidate(song, cand, {
        lang: detected.lang,
        queryKind: 'base',
        sources: ['base'],
        preferBilingual,
      }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((c) => ({
      ...c,
      confidence: confidenceOf(c.score, detected.lang, c.nameHit, preferBilingual),
      durationText: c.durationText || formatDuration(c.durationSec),
    }));
  return { song, lang: detected.lang, best: scored[0] ?? null, candidates: scored };
}
