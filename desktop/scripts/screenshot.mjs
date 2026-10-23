/**
 * 抓取桌面应用窗口的截图（通过 CDP 的 Page.captureScreenshot）
 *
 * 用法：
 *   node scripts/screenshot.mjs --port=9222 --out=shot.png
 */
import fs from 'node:fs';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || d;
const PORT = Number(arg('port', 9222));
const OUT = arg('out', 'screenshot.png');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url)) ?? list.find((t) => t.type === 'page');
if (!page) {
  console.error('✖ 没找到页面 target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  msg.error ? slot.rej(new Error(msg.error.message)) : slot.res(msg.result);
});

const send = (method, params) =>
  new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

// 让页面布局稳定后再截
await new Promise((r) => setTimeout(r, 800));

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
console.log(`✓ 已保存 ${OUT}（${Math.round(fs.statSync(OUT).size / 1024)} KB）`);
console.log(`  页面: ${page.url}`);
ws.close();
