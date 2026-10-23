/**
 * SSE 流式匹配测试：模拟 App 端的消费方式
 * 用法：node tools/test-sse.mjs [playlistId] [limit]
 */
const id = process.argv[2] ?? '3778678';
const limit = Number(process.argv[3] ?? 5);
const base = process.env.API_BASE ?? 'http://127.0.0.1:8787';

const t0 = Date.now();
const res = await fetch(`${base}/api/match/stream?id=${id}&limit=${limit}`);
console.log('HTTP', res.status, res.headers.get('content-type'));

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let songs = 0;
let playlistName = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop() ?? '';
  for (const f of frames) {
    if (!f.trim()) continue;
    const ev = /^event: (.+)$/m.exec(f)?.[1];
    const dataLine = /^data: (.+)$/m.exec(f)?.[1];
    if (!ev || !dataLine) continue;
    const data = JSON.parse(dataLine);
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (ev === 'playlist_start') console.log(`[${t}s] playlist_start → 歌单 ${data.id}`);
    else if (ev === 'playlist') {
      playlistName = data.name;
      console.log(`[${t}s] playlist → 《${data.name}》 共 ${data.trackCount} 首`);
    } else if (ev === 'progress') {
      if (data.done) process.stdout.write(`\r[${t}s] 进度 ${data.done}/${data.total}   `);
    } else if (ev === 'song') {
      songs++;
      process.stdout.write('\n');
      const b = data.best;
      console.log(
        `[${t}s] #${data.index} 【${data.langLabel}】${data.song.title} → ` +
          (b ? `${b.confidence} [${b.score}] ${b.title.slice(0, 52)}` : '未找到')
      );
    } else if (ev === 'done') {
      console.log(`\n[${t}s] done → ${data.count} 首，耗时 ${(data.elapsedMs / 1000).toFixed(1)}s，还有更多: ${data.hasMore}`);
      console.log('   B站统计:', JSON.stringify(data.biliStats));
    } else if (ev === 'error') {
      console.log(`\n[${t}s] error → ${data.message}`);
    }
  }
}
console.log(`\n收到 ${songs} 首结果，《${playlistName}》总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
