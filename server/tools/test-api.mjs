/**
 * 接口联调测试：验证 HTTP 服务端到端可用
 * 用法：node tools/test-api.mjs [playlistId] [limit]
 */
const id = process.argv[2] ?? '3778678';
const limit = Number(process.argv[3] ?? 6);
const base = process.env.API_BASE ?? 'http://127.0.0.1:8787';

const t0 = Date.now();
const res = await fetch(`${base}/api/match?id=${id}&limit=${limit}`);
console.log('HTTP', res.status);
const j = await res.json();
if (!j.results) {
  console.log(JSON.stringify(j).slice(0, 500));
  process.exit(1);
}
console.log(`歌单: ${j.playlist?.name}  共 ${j.total} 首，本次匹配 ${j.results.length} 首\n`);
for (const r of j.results) {
  console.log(`【${r.langLabel}】${r.song.title} — ${r.song.artistText}`);
  console.log(`   置信度=${r.confidence} 需双语=${r.bilingualNeeded}`);
  if (r.best) {
    console.log(`   ▶ [${r.best.score}] ${r.best.title.slice(0, 70)}`);
    console.log(`      ${r.best.author} | ${r.best.playText}播放 | ${r.best.durationText} | ${r.best.url}`);
    console.log(`      理由: ${(r.best.reasons || []).join(' / ')}`);
  } else {
    console.log('   ✖ 未找到候选');
  }
  console.log('');
}
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('B站统计:', JSON.stringify(j.biliStats));
