/**
 * 混合语种端到端测试：直接 POST tracks，验证「外语歌优先双语」这一核心诉求
 * 用法：node tools/test-mixed.mjs
 */
const base = process.env.API_BASE ?? 'http://127.0.0.1:8787';

const tracks = [
  { id: 'test-zh-1', title: '晴天', artists: ['周杰伦'], aliases: [], durationSec: 269, artistText: '周杰伦' },
  { id: 'test-ja-1', title: 'Lemon', artists: ['米津玄師'], aliases: [], durationSec: 256, artistText: '米津玄師' },
  { id: 'test-ja-2', title: '夜に駆ける', artists: ['YOASOBI'], aliases: ['向夜晚奔去'], durationSec: 261, artistText: 'YOASOBI' },
  { id: 'test-en-1', title: 'Shape of You', artists: ['Ed Sheeran'], aliases: [], durationSec: 234, artistText: 'Ed Sheeran' },
  { id: 'test-ko-1', title: 'How You Like That', artists: ['BLACKPINK'], aliases: [], durationSec: 182, artistText: 'BLACKPINK' },
  { id: 'test-ja-3', title: '残酷な天使のテーゼ', artists: ['高橋洋子'], aliases: [], durationSec: 245, artistText: '高橋洋子' },
];

const t0 = Date.now();
const res = await fetch(`${base}/api/match`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tracks, limit: tracks.length, enrich: false }),
});
console.log('HTTP', res.status);
const j = await res.json();

let withSubs = 0;
let foreign = 0;
for (const r of j.results) {
  const b = r.best;
  if (r.bilingualNeeded) foreign++;
  if (r.bilingualNeeded && b && b.bilingualHit >= 0.6) withSubs++;
  console.log(`\n【${r.langLabel}】${r.song.title} — ${r.song.artistText}  置信=${r.confidence}`);
  if (!b) {
    console.log('   ✖ 无候选');
    continue;
  }
  console.log(`   ▶ [${b.score}] ${b.title.slice(0, 74)}`);
  console.log(`      ${b.author} | ${b.playText}播放 | ${b.durationText} | 双语强度=${b.bilingualHit} | ${b.url}`);
  // 再列出第 2、3 名，便于人工核对
  for (const alt of r.candidates.slice(1, 3)) {
    console.log(`      · [${alt.score}] ${alt.title.slice(0, 62)} (双语=${alt.bilingualHit})`);
  }
}
console.log(`\n外语歌 ${foreign} 首，其中 ${withSubs} 首 Top1 带双语字幕`);
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('B站统计:', JSON.stringify(j.biliStats));
