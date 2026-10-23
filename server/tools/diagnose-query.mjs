/** 诊断：B站 对不同查询的返回差异（含极简查询） */
import { BilibiliClient } from '../src/bilibili.mjs';

const b = new BilibiliClient({ debug: false });
await b.ensureSession();

const queries = ['周杰伦', '周杰伦 晴天', '晴天 周杰伦 MV', 'Lemon', '米津玄師 Lemon'];
for (const q of queries) {
  const r = await b.searchVideo(q, { pageSize: 5 });
  const head = r[0] ? `| 首条: ${r[0].title.slice(0, 44)}` : '';
  console.log(`查询 "${q}" → ${r.length} 条 ${head}`);
}
console.log('\nstats:', JSON.stringify(b.stats));
