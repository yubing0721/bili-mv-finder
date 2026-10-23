/**
 * 歌单找 MV · Windows 桌面版主进程
 *
 * 设计要点：
 *
 * 1. **后端复用 Electron 自带的 Node**。
 *    Electron 可以用 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 跑，
 *    所以打包后不需要用户另外安装 Node —— 直接把 server 目录塞进 resources 即可。
 *
 * 2. **后端与界面同源**。
 *    后端既提供 API 也提供页面，所以窗口直接加载 http://127.0.0.1:PORT/desktop，
 *    不用 file:// 再处理跨域。
 *
 * 3. **退出时一定回收子进程**。
 *    否则关掉窗口后 node 还在后台跑、端口被占，下次启动就会莫名其妙失败。
 *
 * 4. **环境自愈**（见下面的 selfHeal）。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');

// ════════════════════════════════════════════════════ 环境自愈
//
// 如果环境里存在 ELECTRON_RUN_AS_NODE=1，Electron 会以**纯 Node 模式**启动：
//   · require('electron') 返回可执行文件路径（字符串），而不是 Electron API
//   · 于是 app / BrowserWindow 全是 undefined，脚本直接崩
// 这个变量可能是我们自己 spawn 子进程时留下的，也可能来自用户的开发终端。
// 实测本机就带着它 —— 所以这里检测到 Node 模式时，清掉该变量并把自己重新拉起一次。
(function selfHeal() {
  let electron = null;
  try {
    electron = require('electron');
  } catch {
    /* 打包环境下可能取不到 */
  }
  const isAppMode = electron && typeof electron === 'object' && electron.app;
  if (isAppMode) return false;

  if (process.env.BMF_RELAUNCHED === '1') {
    console.error(
      '[启动失败] 仍以 Node 模式运行。请手动清除环境变量 ELECTRON_RUN_AS_NODE 后重试：\n' +
        '           set ELECTRON_RUN_AS_NODE=\n' +
        '           npm start'
    );
    process.exit(1);
  }

  const env = { ...process.env, BMF_RELAUNCHED: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  // 开发态与打包态的启动方式不同，必须分开处理：
  //   · 开发态（process.execPath 是 electron.exe）：Electron 需要显式告知应用目录在哪，
  //     即 `electron <appDir>`。
  //   · 打包态（process.execPath 就是这个应用自己的 exe）：它已经知道自己的入口，
  //     多传一个路径参数反而会让 Electron 认为要加载别的应用而启动失败。
  // 实测踩过：打包后照搬开发态的参数，应用直接退出。
  const exeName = path.basename(process.execPath).toLowerCase();
  const isDevElectron = exeName === 'electron.exe' || exeName === 'electron';

  const args = isDevElectron ? [__dirname] : [];
  // 转发 Electron 自身的开关（例如 --remote-debugging-port）
  args.push(...process.argv.slice(1).filter((a) => a.startsWith('--')));

  console.log(`[环境自愈] 检测到 ELECTRON_RUN_AS_NODE，正在以 App 模式重新启动…（${isDevElectron ? '开发态' : '打包态'}）`);
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  return true;
})();

// 已移交给自己重新拉起，当前这个 Node 进程直接结束即可。
// （CommonJS 模块顶层允许 return）
if (!require('electron')?.app) return;

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const PORT = Number(process.env.BMF_PORT || 8787);
const APP_URL = `http://127.0.0.1:${PORT}/desktop`;

/** @type {import('node:child_process').ChildProcess | null} */
let serverProc = null;
/** @type {BrowserWindow | null} */
let win = null;
/** 子进程是否由本进程拉起（若端口本来就有人在用，就不该由我们关掉） */
let weStartedServer = false;
let quitting = false;

// ─────────────────────────────────────────────── 路径

/** 定位 server 目录：开发时在 ../server，打包后在 resources/server */
function serverDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'server'),
    path.join(__dirname, '..', 'server'),
    path.join(__dirname, 'server'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'src', 'index.mjs'))) return c;
  }
  return null;
}

/** 窗口尺寸记忆，免得每次都要手动拉大 */
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s && s.width > 800 && s.height > 560) return s;
  } catch {
    /* 首次运行或文件损坏 */
  }
  return { width: 1360, height: 900 };
}
function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(b), 'utf8');
  } catch {
    /* 存不上不影响使用 */
  }
}

// ─────────────────────────────────────────────── 端口探测

function probePort(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ─────────────────────────────────────────────── 启动后端

function startServer(dir) {
  const entry = path.join(dir, 'src', 'index.mjs');
  const logPath = path.join(app.getPath('userData'), 'server.log');

  serverProc = spawn(process.execPath, [entry], {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 让 Electron 以纯 Node 身份运行这份脚本
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      HOST: '0.0.0.0',
      // 缓存写到用户数据目录，避免装到 Program Files 时没有写权限
      CACHE_DIR: path.join(app.getPath('userData'), 'cache'),
    },
  });

  // 把后端输出转存到日志文件，出问题时能查
  const out = fs.createWriteStream(logPath, { flags: 'a' });
  serverProc.stdout?.pipe(out);
  serverProc.stderr?.pipe(out);

  serverProc.on('exit', (code) => {
    serverProc = null;
    if (!quitting && code !== 0 && code !== null) {
      dialog.showErrorBox('后端服务已退出', `退出码 ${code}\n日志：${logPath}`);
    }
  });
  serverProc.on('error', (e) => {
    serverProc = null;
    if (!quitting) dialog.showErrorBox('无法启动后端服务', String(e?.message ?? e));
  });
}

function stopServer() {
  if (!serverProc || !weStartedServer) return;
  const p = serverProc;
  serverProc = null;
  try {
    // Windows 上 kill() 对 node 通常有效；再兜一层 taskkill 处理可能的孙进程
    p.kill();
    if (process.platform === 'win32' && p.pid) {
      spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } catch {
    /* 已经退出了 */
  }
}

// ─────────────────────────────────────────────── 窗口

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0e0f13;color:#f0f2f7;
    font:14px/1.6 "Segoe UI","Microsoft YaHei UI",sans-serif;
    display:grid;place-items:center;-webkit-user-select:none}
  .b{text-align:center}
  .logo{width:52px;height:52px;border-radius:15px;margin:0 auto 16px;
    background:linear-gradient(135deg,#fb7299,#23ade5);display:grid;place-items:center;font-size:26px}
  .t{font-size:15px;font-weight:700}
  .s{color:#6b7383;font-size:12px;margin-top:6px}
  .bar{width:190px;height:3px;background:#2b3040;border-radius:9px;margin:18px auto 0;overflow:hidden}
  .bar i{display:block;height:100%;width:40%;background:linear-gradient(90deg,#fb7299,#23ade5);
    border-radius:9px;animation:m 1.1s ease-in-out infinite}
  @keyframes m{0%{transform:translateX(-110%)}100%{transform:translateX(360%)}}
</style></head><body><div class="b">
  <div class="logo">🎬</div>
  <div class="t">歌单找 MV</div>
  <div class="s">正在启动本地服务…</div>
  <div class="bar"><i></i></div>
</div></body></html>`)}`;

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0e0f13',
    title: '歌单找 MV',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      // 页面来自本地 HTTP 服务，不需要任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadURL(SPLASH);

  win.once('ready-to-show', () => win.show());

  // 站外链接（B站 视频）一律交给系统默认浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(www\.)?bilibili\.com|^https?:\/\/b23\.tv/.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (/^https?:/.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 主框架意外跳到站外时也拦下来
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  for (const ev of ['resize', 'move']) win.on(ev, debounce(saveState, 400));
  win.on('close', saveState);
  win.on('closed', () => {
    win = null;
  });

  return win;
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** 极简菜单：只留有实际用处的项 */
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'F5', click: () => win?.webContents.reload() },
        { label: '清空服务端缓存', click: clearCache },
        { type: 'separator' },
        { label: '打开日志文件夹', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '在浏览器中打开（手机也能用）', click: () => shell.openExternal(APP_URL) },
        { label: '关于', click: showAbout },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function clearCache() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/cache/clear`, { method: 'POST' });
    dialog.showMessageBox(win, { type: 'info', message: '服务端缓存已清空', buttons: ['好'] });
  } catch (e) {
    dialog.showErrorBox('清理失败', String(e?.message ?? e));
  }
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: '关于',
    message: '歌单找 MV',
    detail:
      `版本 ${app.getVersion()}\n\n` +
      '输入网易云歌单，自动在 B站 匹配每首歌的 MV；\n' +
      '外语歌优先匹配中外双语字幕版本。\n\n' +
      `后端端口：${PORT}\n日志与缓存目录：${app.getPath('userData')}`,
    buttons: ['好'],
  });
}

// ─────────────────────────────────────────────── 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();
    buildMenu();

    // 端口已经有服务在跑（例如用户自己开过 node），就不再重复启动
    if (await probePort(PORT)) {
      weStartedServer = false;
      win?.loadURL(APP_URL);
      return;
    }

    const dir = serverDir();
    if (!dir) {
      dialog.showErrorBox(
        '找不到后端服务',
        '未能在应用目录下定位到 server/src/index.mjs。\n如果是开发模式，请确认 desktop 与 server 是同级目录。'
      );
      return;
    }

    weStartedServer = true;
    startServer(dir);

    const ok = await waitForPort(PORT);
    if (!ok) {
      const logPath = path.join(app.getPath('userData'), 'server.log');
      dialog.showErrorBox(
        '后端启动超时',
        `等待 ${PORT} 端口超时。\n\n常见原因：端口被其它程序占用，或防火墙拦截。\n日志：${logPath}`
      );
      return;
    }
    win?.loadURL(APP_URL);
  });

  // 所有窗口关闭即退出（这是个单窗口工具，不需要留在后台）
  app.on('window-all-closed', () => {
    quitting = true;
    stopServer();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopServer();
  });

  // 兜底：进程被杀时也尽量回收
  process.on('exit', stopServer);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      quitting = true;
      stopServer();
      app.quit();
    });
  }
}
