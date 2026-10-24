/**
 * 语种识别 + 双语字幕检索策略
 *
 * 目标：给定一首歌（歌名 + 歌手），决定
 *   1. 它是中文歌还是外语歌（ja / ko / en / other）
 *   2. 该用哪些检索词去 B站 找「双语字幕」版本
 *
 * 注意：网易云歌名经常是「中文译名 + 原文名」混合，所以判断要多信号加权。
 */
import { hasHan, hasKana, hasHangul, hasLatin, clean } from './text.mjs';

export const LANG = {
  ZH: 'zh',
  JA: 'ja',
  KO: 'ko',
  EN: 'en',
  OTHER: 'other',
};

export const LANG_LABEL = {
  zh: '中文',
  ja: '日语',
  ko: '韩语',
  en: '英语',
  other: '其他外语',
};

/**
 * 各种语言在 B站 上常见的「双语字幕」检索后缀。
 * 顺序 = 优先级，越靠前越可能命中官方/高质量双语版本。
 */
const BILINGUAL_SUFFIX = {
  ja: ['中日双语', '中日双语字幕', '中日字幕', '中字'],
  ko: ['中韩双语', '中韩字幕', '中字'],
  en: ['中英双语', '中英字幕', '中英双字', '中字'],
  other: ['中字', '双语字幕'],
  zh: [],
};

/** 用于「本地识别候选视频是否真的带双语字幕」的特征词，按强度分组 */
export const BILINGUAL_MARKERS = {
  strong: [
    '中日双语', '中韩双语', '中英双语', '英日双语',
    '双语字幕', '中英双字', '中日双字', '中韩双字',
    '双语对照', '中外双语',
  ],
  medium: [
    '中字', '中文字幕', '官方中字', '中文翻译', '中译',
    '字幕版', '带字幕', '有字幕', 'cc字幕', '简繁字幕',
  ],
};

/** 强「这是 MV / 官方影像」信号 */
export const MV_MARKERS = [
  'mv', 'music video', 'pv', 'official', '官方', '公式',
  '1080p', '2160p', '4k', '8k', '高清', '超清', '修复', '最高画质', '画质',
  '短版mv', 'full mv',
];

/**
 * 明确应该被降权的「不是我要的 MV」信号。
 * 每条带一个权重惩罚值。
 */
export const NEGATIVE_MARKERS = [
  // —— 合集类：最常见的高播放量噪声 ——
  { re: /合集|集锦|串烧|精选集|歌曲合集|歌单|连播|playlist|合辑|专享|组曲/, penalty: 34, tag: '合集' },
  { re: /\d+\s*(首|曲)\s*(联唱|连唱|合集|精选)?/, penalty: 18, tag: '多曲' },
  { re: /小时|hours?\b|分钟合集|无限循环|循环播放|loop|催眠|助眠|白噪音|学习bgm|study/i, penalty: 30, tag: '循环' },
  // —— 二次创作 / 非原唱 ——
  { re: /翻唱|cover|翻自|唱见|模仿|清唱|acoustic\s*ver|remix|mashup|混音|dj版|八倍速|加速版|慢速版|变速|鬼畜|调教/i, penalty: 26, tag: '非原唱' },
  { re: /reaction|反应|看mv|点评|解析|讲解|赏析|解说/i, penalty: 30, tag: '解读' },
  { re: /教学|教程|教唱|怎么唱|声乐|扒带|乐谱|简谱|五线谱|琴谱|伴奏|instrumental|off\s*vocal|カラオケ|karaoke|\bktv\b|ニコカラ/i, penalty: 30, tag: '教学伴奏' },
  // 器乐演奏版。真机实测漏掉了「翻奏」与「长笛」，结果一首长笛演奏视频
  // 被当成官方 MV 并判为「很确定」—— 所以把常见乐器补齐。
  {
    re: /钢琴版|吉他版|钢琴曲|钢琴弹奏|吉他弹唱|翻弹|翻奏|指弹|尤克里里|古筝|口琴|架子鼓|鼓谱|曲谱|动态谱|音游谱|打击垫|长笛|短笛|小提琴|中提琴|大提琴|低音提琴|二胡|琵琶|竹笛|笛子|洞箫|萨克斯|手风琴|电子琴|合成器|竖琴|扬琴|唢呐|葫芦丝|陶笛|竖笛|单簧管|双簧管|小号|长号|圆号|大号|贝斯|贝司|马林巴|piano\s*(ver|version|cover)/i,
    penalty: 26,
    tag: '器乐',
  },
  // 空耳/谐音学唱：用中文谐音记外语歌词的教学视频，不是 MV。
  // ⚠️ 刻意**不含**「罗马音」—— 很多优质的中日双语 MV 标题里就带罗马音标注。
  { re: /空耳|谐音|音译学唱/i, penalty: 24, tag: '音译学唱' },
  // 卡拉OK 投屏 / 纯伴奏：实测在日语歌单里很常见（如「【纯K投屏】…」），
  // 画面是滚动歌词而非 MV。
  { re: /投屏|纯K|卡拉OK|卡拉ok|カラオケ画面/i, penalty: 26, tag: 'K歌投屏' },
  // —— 演奏/表演改编：是二次演绎，不是原版 MV ——
  { re: /杯子|敲击|打击乐|阿卡贝拉|acapella|童声|合唱团|街头|快闪|音乐盒|八音盒|口技|beatbox/i, penalty: 22, tag: '改编表演' },
  { re: /花絮|幕后|采访|访谈|预告|teaser|制作过程|making/i, penalty: 24, tag: '花絮' },
  { re: /直播|录播|切片|cut\b|合集第|第\d+期/i, penalty: 20, tag: '切片' },
  { re: /纯音乐|无人声|听歌向|无损音质|hi-?res|母带|试听|音质对比/i, penalty: 22, tag: '音频' },
  { re: /混剪|剪辑|踩点|二创|\bamv\b|\bmad\b|燃向|催泪向|治愈向|盘点|排行|top\s*\d+/i, penalty: 28, tag: '二创' },
  // —— 剧情/语言改写版：用户要的是原版 MV，不是中文/粤语填词版 ——
  { re: /填词|中文词|粤语版|粤语填词|国语版|中文版|日文版|英文版|改编|翻填|重填|中文ver|chinese\s*ver/i, penalty: 30, tag: '改写版' },
  // —— 现场版：是合法内容但用户找的是「MV」，中等降权 ——
  { re: /现场|live\b|ライブ|演唱会|concert|音乐节|festival|巡演|tour\b|不插电|unplugged|打歌|舞台/i, penalty: 14, tag: '现场版' },
];

/**
 * PRC 简体专用字形：日本新字体在这些字上用的是**另一种**写法，
 * 所以出现简体字形基本可以认定是大陆中文。
 * （国/学/会/体 等「简体与日文同形」的字必须排除，否则会误判。）
 */
const SIMPLIFIED_ONLY_STR =
  '师时门华东书车马鸟风飞长见电语话头实关还进过对应对义议让张队阳阴无专亚产亲仅从众优传伟伤价' +
  '军农凤刘则刚创动务胜释钢录亿仪剑剧龙岁树桥检验铁银钱钟云经济团圆续处归营乐药观变权欢读术听' +
  '图园岛币帮颜齿战继绩织终结给统丝绿红纪级约纯纸线练组细绍绝气发说这们伦陈';

/**
 * 日本新字体里**既不同于简体、也不同于繁体**的字形。
 * 这类字是最干净的日语证据：繁体圈不这么写，简体圈也不这么写。
 * 例：気(气/氣) 図(图/圖) 対(对/對) 実(实/實) 発(发/發) 楽(乐/樂) 団(团/團) 処(处/處)
 */
const JP_SHIJITAI_STR =
  '気図対実発経戦残顔楽薬観変権読写声聴術島歯髪駅鉄銀銭録医釈鋼剣区劇竜歳樹橋検験証訳択沢浜塩' +
  '円芸広辺弁歩宝届帯帰営増徳徴応懐払抜拠挟挿捜掲剤剰勧嘱団囲圧曽弥弐摂挙斉斎収処圏絵拡桜渋焼' +
  '継総脳転遅郷酔錬闘陥畳穏壌嬢寛寝';

const SIMPLIFIED_ONLY = new Set([...SIMPLIFIED_ONLY_STR]);
const JP_SHIJITAI = new Set([...JP_SHIJITAI_STR]);

/** 繁体字形（港台与日文同形，仅作弱证据）。与简体字形一一对应。 */
const TRAD_PAIRS =
  '师師时時门門华華东東书書车車马馬鸟鳥风風飞飛长長见見电電语語话話头頭实實关關还還进進过過' +
  '对對应應义義议議让讓张張队隊阳陽阴陰无無专專亚亞产產亲親仅僅从從众眾优優传傳伟偉伤傷价價' +
  '军軍农農凤鳳刘劉则則刚剛创創动動务務胜勝释釋钢鋼录錄亿億仪儀剑劍剧劇龙龍岁歲树樹桥橋检檢' +
  '验驗铁鐵银銀钱錢钟鐘云雲经經济濟团團续續处處归歸营營乐樂药藥观觀变變权權欢歡读讀术術听聽' +
  '图圖园園岛島币幣帮幫颜顏齿齒战戰继繼绩績织織终終结結给給统統丝絲绿綠红紅纪紀级級约約纯純' +
  '纸紙线線练練组組细細绍紹绝絕说說这這们們伦倫陈陳';
const TRADITIONAL_ONLY = new Set();
for (let i = 1; i < TRAD_PAIRS.length; i += 2) TRADITIONAL_ONLY.add(TRAD_PAIRS[i]);

/**
 * 字形倾向统计。
 * @param {string} text
 * @returns {{cn:number, jp:number, trad:number, jpChars:string[], cnChars:string[]}}
 */
export function glyphLean(text) {
  const t = String(text || '');
  const cnChars = [];
  const jpChars = [];
  let trad = 0;
  for (const ch of t) {
    if (SIMPLIFIED_ONLY.has(ch)) cnChars.push(ch);
    else if (JP_SHIJITAI.has(ch)) jpChars.push(ch);
    else if (TRADITIONAL_ONLY.has(ch)) trad++;
  }
  return { cn: cnChars.length, jp: jpChars.length, trad, jpChars, cnChars };
}

/**
 * 语言特征字符统计
 * @param {string} text
 *//**
 * 语言特征字符统计
 * @param {string} text
 */
export function countLangChars(text) {
  const t = text || '';
  const kana = (t.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const hangul = (t.match(/\p{Script=Hangul}/gu) || []).length;
  const han = (t.match(/\p{Script=Han}/gu) || []).length;
  const latin = (t.match(/[a-zA-Z]/g) || []).length;
  return { kana, hangul, han, latin };
}

/**
 * 用歌词判定语种 —— 这是最可靠的判据。
 *
 * 纯看歌名/歌手很难区分「米津玄師 - Lemon」（日语）和
 * 「林俊杰 - Always Online」（中文），但歌词一验就准：
 * 日语歌词必然大量出现假名，韩语必然大量出现谚文。
 *
 * @param {string} lyric 原始歌词文本（可含 LRC 时间戳）
 * @returns {{lang:string, confidence:number, reason:string, counts:object}|null}
 */
export function detectLangFromLyric(lyric) {
  if (!lyric || typeof lyric !== 'string') return null;
  // 去掉 [00:00.00] 这类时间戳和作词作曲等元信息行
  const body = lyric
    .replace(/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/g, ' ')
    .replace(/^.*?(作词|作曲|编曲|混音|母带|制作人|Lyricist|Composer|Arranger|Producer|出品|监制)[:：].*$/gim, ' ');
  const c = countLangChars(body);
  const total = c.kana + c.hangul + c.han + c.latin;
  if (total < 20) return null; // 歌词太短（纯音乐 / 只有一句）则不足以判断

  let lang = LANG.OTHER;
  let conf = 0.6;
  if (c.kana >= 6) {
    lang = LANG.JA;
    conf = Math.min(0.97, 0.7 + c.kana / (total || 1));
  } else if (c.hangul >= 6) {
    lang = LANG.KO;
    conf = Math.min(0.97, 0.7 + c.hangul / (total || 1));
  } else if (c.latin >= 30 && c.latin > c.han * 2.5) {
    lang = LANG.EN;
    conf = 0.85;
  } else if (c.han >= 20) {
    lang = LANG.ZH;
    conf = 0.85;
  } else if (c.latin > c.han) {
    lang = LANG.EN;
    conf = 0.7;
  }
  return {
    lang,
    confidence: Number(conf.toFixed(2)),
    reason: `歌词统计 kana=${c.kana} hangul=${c.hangul} han=${c.han} latin=${c.latin}`,
    counts: c,
  };
}

/**
 * 语种识别：歌词优先，其次歌名/歌手/别名多信号加权
 * @param {{title:string, aliases?:string[], artists?:string[], artistAliases?:string[], lyric?:string}} song
 * @returns {{lang:string, confidence:number, reason:string}}
 */
export function detectLang(song) {
  // —— 1. 歌词优先（最可靠）——
  const fromLyric = detectLangFromLyric(song.lyric);
  if (fromLyric && fromLyric.lang !== LANG.OTHER) return fromLyric;

  const title = clean(song.title || '');
  const aliases = (song.aliases || []).map(clean);
  const artists = (song.artists || []).map(clean);
  const artistAliases = (song.artistAliases || []).map(clean);
  const all = [title, ...aliases, ...artists, ...artistAliases].join(' ');

  const score = { zh: 0, ja: 0, ko: 0, en: 0, other: 0 };

  // —— 歌名信号权重最高 ——
  if (hasKana(title)) {
    score.ja += 6;
    score.other += 1;
  }
  if (hasHangul(title)) {
    score.ko += 6;
  }
  const allArtistsLatin =
    artists.length > 0 && artists.every((a) => !hasHan(a) && !hasKana(a) && !hasHangul(a));
  if (hasHan(title) && !hasKana(title) && !hasHangul(title)) {
    // 纯汉字歌名：中文可能性大，但日语汉字歌名（如「残響散歌」）同样常见
    score.zh += 4;
    score.ja += 0.5;
    // 汉字歌名 + 全拉丁歌手名 → 强烈偏向日语
    // （Aimer / LiSA / milet / Ado / YOASOBI 这类日本艺人惯用拉丁艺名，
    //   而中文歌手极少在网易云上只挂一个纯拉丁名搭配纯汉字歌名）
    if (allArtistsLatin) {
      score.ja += 3;
      score.zh -= 1.5;
    }
  }
  if (hasLatin(title) && !hasHan(title) && !hasKana(title) && !hasHangul(title)) {
    score.en += 5;
    // 纯拉丁歌名 + 纯汉字歌手名 → 无法凭字面区分中日，两边都给分
    if (artists.some((a) => hasHan(a) && !hasKana(a) && !hasHangul(a))) {
      score.zh += 1.5;
      score.ja += 1.5;
      score.en -= 1;
    }
    // 纯拉丁歌名 + 纯拉丁歌手名 → 倾向英语
    if (allArtistsLatin) score.en += 1.5;
  }

  // —— 别名（网易云常给原文名 / 译名）——
  for (const a of aliases) {
    if (hasKana(a)) score.ja += 3;
    if (hasHangul(a)) score.ko += 3;
    if (hasHan(a) && !hasKana(a) && !hasHangul(a)) score.zh += 1.5;
    if (hasLatin(a) && !hasHan(a) && !hasKana(a) && !hasHangul(a)) score.en += 2;
  }

  // —— 歌手名 ——
  // 歌手名里带假名基本可以断定是日语歌（宇多田ヒカル / あいみょん / Official髭男dism），
  // 权重给高，并反过来抑制 en —— 否则「宇多田ヒカル - First Love」
  // 会因为拉丁歌名拿了 en 的分而被判成英语。
  let artistHasKana = false;
  for (const ar of [...artists, ...artistAliases]) {
    if (hasKana(ar)) {
      artistHasKana = true;
      score.ja += 4;
    }
    if (hasHangul(ar)) score.ko += 3;
  }
  if (artistHasKana) score.en -= 2;
  // 网易云有时直接在名字里标语言，如「Lemon（日）」
  if (/[（(]日[)）]/.test(all)) score.ja += 3;
  if (/[（(]韩[)）]/.test(all)) score.ko += 3;
  if (/[（(]英[)）]/.test(all)) score.en += 3;

  // —— 字形兜底：无歌词时区分简体中文与日文 ——
  const lean = glyphLean(`${title} ${artists.join('')} ${artistAliases.join('')}`);

  // 日本新字体独占字形（気/図/対/楽/団/処…）：简体圈和繁体圈都不会这么写，
  // 所以不论标题长什么样，命中了就是日语，直接给强信号。
  if (lean.jp > 0) {
    score.ja += 3.5 * Math.min(lean.jp, 2);
    score.zh -= 1.5 * Math.min(lean.jp, 2);
    score.en -= 1.5;
  }

  // PRC 简体独占字形（师/时/乐/团/气…）：日文用的是另一种写法 → 偏中文。
  if (lean.cn > 0) {
    score.zh += 3 * Math.min(lean.cn, 2);
    score.ja -= 1 * Math.min(lean.cn, 2);
    score.en -= 1;
  }

  // 繁体字形（陳/師/響…）只在「标题本身看不出语种」时才作为证据。
  // 标题已经是汉字时（富士山下）不要用它推翻已有判断 ——
  // 否则「陳奕迅 - 富士山下」会因为 陳 被误判成日语。
  const titleScriptAmbiguous = !hasHan(title) && !hasKana(title) && !hasHangul(title);
  if (titleScriptAmbiguous && lean.trad > 0 && lean.cn === 0) {
    score.ja += 3;
    score.zh -= 1.5;
    score.en -= 1;
  }

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;

  let lang = best;
  if (bestScore === 0) lang = LANG.OTHER;
  // 中日难分时默认按日语处理：日语的「中日双语」需求更常见，
  // 而且用中日双语检索中文歌的代价，通常小于反向（仍能召回带中字的版本）。
  //
  // ⚠️ 必须限定「前两名恰好是 zh 和 ja」。
  // 曾经只判断「zh>0 && ja>0 && 分差<1.2」就倒向日语，
  // 结果「周杰伦 - Always Online」的 zh=4 与 en=4 平局被误判成日语。
  const top2 = ranked
    .slice(0, 2)
    .map(([k]) => k)
    .sort()
    .join(',');
  if (bestScore - second < 1.2 && top2 === 'ja,zh') lang = LANG.JA;
  // 只有「既没有汉字标题、也没有简体字形证据」时才降级 ——
  // 否则「周杰伦 - Always Online」这类会白白丢掉已经拿到手的中文判断。
  if (lang === LANG.ZH && bestScore - second < 2 && hasHan(title) === false && lean.cn === 0) {
    lang = LANG.OTHER;
  }

  const conf = bestScore === 0 ? 0 : Math.min(1, (bestScore - second) / 6 + bestScore / 12);
  return {
    lang,
    confidence: Number(conf.toFixed(2)),
    reason: `title=${title} | 字形 简=${lean.cn} 日=${lean.jp}${lean.jp ? `[${lean.jpChars.join('')}]` : ''}${lean.cn ? `[${lean.cnChars.join('')}]` : ''} | scores=${JSON.stringify(score)}`,
  };
}

/**
 * 生成多路检索词。
 * 思路：单条关键词无法同时兼顾「找对歌」和「找双语版」，
 * 所以并行发多条，最后在本地按特征重新打分融合。
 *
 * @param {{title:string, aliases?:string[], artists?:string[]}} song
 * @param {string} lang
 * @param {{bilingualFirst?:boolean}} [opts]
 * @returns {{query:string, kind:string, weight:number}[]}
 */
export function buildQueries(song, lang, opts = {}) {
  const title = clean(song.title || '');
  const alias = (song.aliases || []).map(clean).filter(Boolean);
  const artist = (song.artists || []).map(clean).filter(Boolean);

  // 去掉歌名里的括号补充信息，得到检索主名
  const bare = title.replace(/[（(【\[].*?[)）】\]]/g, ' ').replace(/\s+/g, ' ').trim() || title;
  const mainArtist = artist[0] || '';

  const out = [];
  const push = (query, kind, weight) => {
    const q = query.replace(/\s+/g, ' ').trim();
    if (!q) return;
    if (out.some((x) => x.query === q)) return;
    out.push({ query: q, kind, weight });
  };

  const isForeign = lang !== LANG.ZH;
  const suffix = BILINGUAL_SUFFIX[lang] || BILINGUAL_SUFFIX.other;

  // —— 基础路：确保「歌对了」——
  push(`${bare} ${mainArtist}`.trim(), 'base', 1.0);
  push(`${bare} ${mainArtist} MV`.trim(), 'base_mv', 0.95);

  // —— 原文名路：日语/韩语歌用别名（原文名）检索往往更准 ——
  for (const a of alias.slice(0, 2)) {
    push(`${a} ${mainArtist}`.trim(), 'alias', 0.9);
    push(`${a} ${mainArtist} MV`.trim(), 'alias_mv', 0.85);
  }

  // —— 双语路：外语歌的核心 ——
  if (isForeign) {
    for (const s of suffix.slice(0, 3)) {
      push(`${bare} ${mainArtist} ${s}`.trim(), 'bilingual', 1.15);
    }
    // 复合路：MV + 双语关键词。
    // 只用双语关键词容易召回纯歌词视频，只用 MV 容易召回无字幕版，
    // 组合起来才最可能直接捞出「带字幕的官方 MV」。
    push(`${bare} ${mainArtist} MV ${suffix[0]}`.trim(), 'bilingual_mv', 1.2);
    // 别名 + 双语，覆盖「网易云给中文译名、B站用原文名」的情况
    if (alias[0] && alias[0] !== bare) {
      push(`${alias[0]} ${mainArtist} ${suffix[0]}`.trim(), 'bilingual_alias', 1.1);
    }
  }

  // —— 官方路：官方 MV 通常画质最好、最不容易带错 ——
  push(`${bare} ${mainArtist} 官方 MV`.trim(), 'official', 0.9);

  if (opts.bilingualFirst && isForeign) {
    out.sort((a, b) => (b.kind.startsWith('bilingual') ? 1 : 0) - (a.kind.startsWith('bilingual') ? 1 : 0));
  }
  return out;
}

/** 该语种是否需要找双语字幕（中文歌不需要） */
export const needsBilingual = (lang) => lang !== LANG.ZH;
