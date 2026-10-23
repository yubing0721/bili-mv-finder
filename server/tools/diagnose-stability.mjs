/**
 * 诊断：同样的请求重复跑，结果是否稳定？
 * 用来区分「打分逻辑有问题」和「B站 搜索结果本身有波动」。
 */
const base = 'http://127.0.0.1:8787';
const tracks = [
  { id: '536622304', title: 'Lemon', artists: ['米津玄師'], aliases: [], durationSec: 256, artistText: '米津玄師' },
];

async function run(label, preferBilingual, clearCache) {
  if (clearCache) await fetch(base + '/api/cache/clear', { method: 'POST' });
  const t0 = Date.now();
  const r = await fetch(base + '/api/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks, preferBilingual }),
  });
  const j = await r.json();
  const res = j.results[0];
  console.log(`\n===== ${label}  (preferBilingual=${preferBilingual}, 清缓存=${clearCache}) =====`);
  console.log(`语种=${res.lang} 候选池=${res.meta.uniqueCandidates}/${res.meta.rawCandidates} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s 请求数=${j.biliStats.requests} 风控=${j.biliStats.riskHits}`);
  console.log(`检索路: ${res.meta.queries.map((q) => q.kind).join(', ')}`);
  for (const c of res.candidates.slice(0, 5)) {
    console.log(`  [${c.score.toFixed(1)}] 双语=${c.bilingualHit.toFixed(2)} MV=${c.mvHit.toFixed(2)} 罚=${c.breakdown?.penalty} | ${c.title.slice(0, 56)}`);
  }
  return res;
}

// 同一组参数跑两次，看是否稳定
await run('A1 同参数第一次', true, true);
await run('A2 同参数第二次(无缓存，仍走网络)', true, true);
// 对照组：关闭双语优先
await run('B1 关闭双语优先', false, true);
// 再次确认开启时结果
await run('A3 开启双语优先(第三次)', true, true);
