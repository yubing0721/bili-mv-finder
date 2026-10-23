/**
 * 匹配质量评估工具
 *
 * 用一批「语种已知、正确答案大致可预期」的歌曲跑一遍算法，
 * 输出 Top3 候选 + 得分构成 + 判定理由，用于调参与回归验证。
 *
 * 用法：
 *   node tools/eval.mjs                 # 跑内置用例
 *   node tools/eval.mjs --enrich        # 额外拉取视频详情（更准，但更慢）
 *   node tools/eval.mjs --only=日语      # 只跑某类
 */
import { BilibiliClient } from '../src/bilibili.mjs';
import { matchSong } from '../src/match.mjs';
import { detectLang, LANG_LABEL } from '../src/lang.mjs';
import { formatCount, formatDuration } from '../src/text.mjs';
import { NeteaseClient } from '../src/netease.mjs';

const args = process.argv.slice(2);
const enrich = args.includes('--enrich');
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1];

/**
 * 从网易云检索到真实歌曲，拿到真实时长 + 歌词。
 * 这样评估才和线上行为一致 —— 特别是歌词，它是语种识别的关键依据。
 */
const netease = new NeteaseClient();
async function resolveFromNetease(c) {
  const list = await netease.searchSong(`${c.title} ${c.artists[0] ?? ''}`.trim(), 8);
  if (!list.length) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s/g, '');
  const wantTitle = norm(c.title);
  const wantArtist = norm(c.artists[0]);
  const score = (s) => {
    let v = 0;
    if (norm(s.title) === wantTitle) v += 3;
    else if (norm(s.title).includes(wantTitle)) v += 1;
    if (s.artists.some((a) => norm(a) === wantArtist)) v += 10;
    else if (s.artists.some((a) => norm(a).includes(wantArtist) || wantArtist.includes(norm(a)))) v += 4;
    return v;
  };
  // 关键：优先歌手匹配，避免「晴天 周杰伦」检索到某翻唱版本
  const hit = [...list].sort((a, b) => score(b) - score(a))[0];
  const lyric = await netease.getLyric(hit.id);
  return { ...hit, lyric };
}

/** 测试用例：expect 只用于人工核对，不参与算法 */
const CASES = [
  // —— 中文歌（不需要双语）——
  { title: '晴天', artists: ['周杰伦'], durationSec: 269, langHint: 'zh' },
  { title: '稻香', artists: ['周杰伦'], durationSec: 223, langHint: 'zh' },
  { title: '富士山下', artists: ['陈奕迅'], durationSec: 258, langHint: 'zh' },
  // —— 日语歌（需要中日双语）——
  { title: 'Lemon', artists: ['米津玄師'], aliases: ['Lemon'], durationSec: 256, langHint: 'ja' },
  { title: '夜に駆ける', artists: ['YOASOBI'], aliases: ['向夜晚奔去'], durationSec: 261, langHint: 'ja' },
  { title: 'First Love', artists: ['宇多田ヒカル'], durationSec: 253, langHint: 'ja' },
  { title: '残響散歌', artists: ['Aimer'], durationSec: 189, langHint: 'ja' },
  // —— 英语歌（需要中英双语）——
  { title: 'Love Story', artists: ['Taylor Swift'], durationSec: 235, langHint: 'en' },
  { title: 'Shape of You', artists: ['Ed Sheeran'], durationSec: 233, langHint: 'en' },
  { title: 'Hello', artists: ['Adele'], durationSec: 295, langHint: 'en' },
  // —— 韩语歌（需要中韩双语）——
  // 注意：Dynamite 是韩国团体唱的**英语**歌，歌词全英文。
  // 判定为 en（→ 中英双语）才是正确行为，所以期望值是 en。
  { title: 'Dynamite', artists: ['BTS'], aliases: ['방탄소년단'], durationSec: 199, langHint: 'en' },
  { title: 'How You Like That', artists: ['BLACKPINK'], durationSec: 182, langHint: 'ko' },
];

const bili = new BilibiliClient({ debug: false });

const line = (s = '') => console.log(s);
const bar = () => line('─'.repeat(96));

async function main() {
  const cases = CASES.filter((c) => !only || LANG_LABEL[c.langHint] === only || c.langHint === only);
  line(`\n🎬 匹配质量评估  |  用例 ${cases.length} 个  |  enrich=${enrich}\n`);

  const summary = { total: 0, langOk: 0, high: 0, medium: 0, low: 0, bilingualTop: 0, foreignTotal: 0, nameHitTop: 0, elapsed: [] };

  for (const c of cases) {
    const song = {
      id: `eval-${c.title}`,
      title: c.title,
      aliases: c.aliases ?? [],
      artists: c.artists,
      artistAliases: [],
      artistText: c.artists.join(' / '),
      durationSec: c.durationSec,
    };
    const resolved = await resolveFromNetease(c).catch(() => null);
    if (resolved) {
      song.id = resolved.id;
      song.aliases = [...new Set([...(song.aliases ?? []), ...(resolved.aliases ?? [])])];
      song.artistAliases = resolved.artistAliases ?? [];
      song.durationSec = resolved.durationSec ?? song.durationSec;
      song.lyric = resolved.lyric ?? '';
      song.resolvedFrom = `${resolved.title} — ${resolved.artistText}`;
    }

    const t0 = Date.now();
    const r = await matchSong(bili, song, { enrich, topN: 4 });
    const ms = Date.now() - t0;
    summary.elapsed.push(ms);
    summary.total++;
    if (r.lang === c.langHint) summary.langOk++;
    if (r.confidence === 'high') summary.high++;
    else if (r.confidence === 'medium') summary.medium++;
    else summary.low++;
    if (r.bilingualNeeded) {
      summary.foreignTotal++;
      if (r.best?.bilingualHit >= 0.6) summary.bilingualTop++;
    }
    if (r.best?.titleOnlyHit >= 0.95) summary.nameHitTop++;

    bar();
    const langFlag = r.lang === c.langHint ? '✅' : `⚠️ (期望 ${c.langHint})`;
    line(
      `【${LANG_LABEL[r.lang]}】${c.title} — ${c.artists.join('/')}  ` +
        `(${formatDuration(song.durationSec)})  ${langFlag}`
    );
    if (song.resolvedFrom) line(`  网易云: ${song.resolvedFrom}`);
    if (song.lyric) line(`  语种依据: ${detectLang(song).reason}`);
    line(
      `  判定语种=${r.lang} 需双语=${r.bilingualNeeded ? '是' : '否'} | 置信度=${r.confidence} | ` +
        `候选池=${r.meta.uniqueCandidates}/${r.meta.rawCandidates} | 耗时=${(ms / 1000).toFixed(1)}s`
    );
    if (r.best) {
      line(`  检索路: ${r.meta.queries.map((q) => q.kind).join(' + ')}`);
    }
    for (const [i, cand] of r.candidates.entries()) {
      const mark = i === 0 ? '▶' : ' ';
      const bi = cand.bilingualHit >= 0.6 ? ' 【双语】' : '';
      line(
        `${mark} ${i + 1}. [${cand.score.toFixed(1)}] ${cand.title.slice(0, 62)}${bi}`
      );
      line(
        `      UP=${cand.author.slice(0, 18)} 播放=${formatCount(cand.play)} 时长=${cand.durationText} ` +
          `(${cand.durationSec ?? '?'}s) 置信=${cand.confidence} 召回=${cand.sources.join(',')}`
      );
      line(
        `      分量: 歌名${cand.breakdown.title} 歌手${cand.breakdown.artist} 时长${cand.breakdown.duration} ` +
          `MV${cand.breakdown.mv} 双语${cand.breakdown.bilingual} 播放${cand.breakdown.play} ` +
          `官方${cand.breakdown.officialUp} 罚${-cand.breakdown.penalty}`
      );
      if (cand.negativeTags?.length) line(`      ⚠️ 降权标签: ${cand.negativeTags.join('/')}`);
    }
  }

  bar();
  const avg = summary.elapsed.reduce((a, b) => a + b, 0) / (summary.elapsed.length || 1);
  line(`\n📊 汇总`);
  line(`   语种识别正确率: ${summary.langOk}/${summary.total} (${((summary.langOk / summary.total) * 100).toFixed(0)}%)`);
  line(`   置信度分布:     high=${summary.high} medium=${summary.medium} low/none=${summary.low}`);
  line(`   Top1 标题精确含歌名: ${summary.nameHitTop}/${summary.total}`);
  line(
    `   Top1 带双语字幕:     ${summary.bilingualTop}/${summary.foreignTotal}  (仅统计外语歌)`
  );
  line(`   平均单曲耗时:   ${(avg / 1000).toFixed(1)}s`);
  line(`   B站 请求数:     ${bili.stats.requests}  风控命中: ${bili.stats.riskHits}\n`);
}

main().catch((e) => {
  console.error('评估失败:', e);
  process.exit(1);
});
