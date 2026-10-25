const { app, BrowserWindow, ipcMain, Menu, dialog, shell, screen, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');
const { Store } = require('./store');

const DEFAULT_TITLE = 'New terminal';
const TITLE_MAX = 40;

let win = null;
let store = null;
let quitting = false;
const live = new Map();

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function broadcastSessions() {
  send('sessions:changed', store.list(), [...live.keys()]);
}

function shellEnv() {
  const env = { ...process.env };
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'TermHub';
  env.TERM_PROGRAM_VERSION = app.getVersion();
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  if (!env.CLICOLOR) env.CLICOLOR = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

function shellEnvFor(shellPath) {
  const env = shellEnv();
  if (store.settings.styledPrompt === false || path.basename(shellPath) !== 'zsh') return env;
  env.TERMHUB_PROMPT = '1';
  if (process.env.ZDOTDIR) env.TERMHUB_USER_ZDOTDIR = process.env.ZDOTDIR;
  env.ZDOTDIR = shellIntegrationDir();
  return env;
}

function stamp(text) {
  const when = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  return `\r\n\x1b[2m╌╌ ${text} · ${when} ╌╌\x1b[0m\r\n`;
}

const ZSH_FILES = ['zshenv', 'zprofile', 'zshrc', 'zlogin'];

function shellIntegrationDir() {
  return path.join(app.getPath('userData'), 'shell', 'zsh');
}

function installShellIntegration() {
  const dir = shellIntegrationDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ZSH_FILES) {
    fs.writeFileSync(path.join(dir, `.${name}`), fs.readFileSync(path.join(__dirname, 'shell', 'zsh', name)));
  }
}

function spawnPty(session, cols, rows) {
  const shellPath = process.env.SHELL || '/bin/zsh';
  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
  const proc = pty.spawn(shellPath, ['-l'], {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 30,
    cwd,
    env: shellEnvFor(shellPath),
  });
  const entry = { proc, line: '', esc: null, out: '', altScreen: false, pending: [] };
  live.set(session.id, entry);

  proc.onData((data) => {
    trackOutput(entry, data);
    store.append(session.id, data);
    send('pty:data', session.id, data);
  });

  proc.onExit(({ exitCode }) => {
    if (live.get(session.id) !== entry) return;
    live.delete(session.id);
    const current = store.get(session.id);
    if (!current) return;
    if (current.commands === 0 && !current.titleLocked && !current.pinned && !quitting) {
      store.remove(session.id);
      send('pty:removed', session.id);
    } else {
      const ended = stamp(`session ended (exit ${exitCode})`);
      store.append(session.id, ended);
      store.update(session.id, { updatedAt: Date.now() });
      send('pty:exit', session.id, ended);
    }
    if (!quitting) broadcastSessions();
  });

  return entry;
}

const MULTI = new Set(['git', 'npm', 'npx', 'yarn', 'pnpm', 'mvn', 'mvnw', 'gradle', 'gradlew', 'docker', 'kubectl', 'brew', 'cargo', 'go', 'make', 'aws', 'gh', 'pip', 'pip3', 'poetry', 'terraform', 'helm', 'pulumi']);
const SKIP = new Set(['cd', 'ls', 'll', 'la', 'l', 'clear', 'pwd', 'echo', 'cat', 'exit', 'history', 'which', 'man', 'true', 'export', 'source', '.', 'z', 'j', 'reset', 'read', 'false', 'sleep', 'wait']);
const EDITORS = new Set(['vim', 'nvim', 'vi', 'nano', 'code', 'emacs', 'less', 'subl', 'idea']);
const RUNNERS = new Set(['python', 'python3', 'node', 'java', 'bash', 'sh', 'zsh', 'ruby', 'deno', 'bun']);
const RECENT_MAX = 30;
const OUT_TAIL = 4096;

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g, '');
}

function describeSegment(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && (/^\w+=/.test(tokens[0]) || ['sudo', 'time', 'nohup', 'env', 'exec', 'command'].includes(tokens[0]))) tokens.shift();
  if (!tokens.length) return null;
  const base = tokens[0].split('/').pop();
  if (!base || SKIP.has(base) || /^[:#!]/.test(base)) return null;
  const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
  if (MULTI.has(base)) return args[0] ? `${base} ${args[0]}` : base;
  if (base === 'ssh') return args[0] ? `ssh ${args[0].split('@').pop()}` : 'ssh';
  if (base === 'claude') return 'Claude Code';
  if (EDITORS.has(base) || RUNNERS.has(base)) return args.length ? `${base} ${path.basename(args[args.length - 1])}` : base;
  return base;
}

function describeLine(line) {
  return line
    .split(/&&|\|\||;/)
    .map((part) => part.split('|')[0])
    .map(describeSegment)
    .filter(Boolean);
}

function gitRoot(cwd) {
  let dir = cwd;
  while (dir && dir !== path.dirname(dir) && dir !== os.homedir()) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function gitBranch(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (!pointer) return null;
      gitDir = path.resolve(root, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    return null;
  }
}

function projectName(cwd) {
  if (!cwd || cwd === os.homedir()) return '~';
  const root = gitRoot(cwd);
  return path.basename(root || cwd);
}

function gitInfo(cwd) {
  const root = cwd ? gitRoot(cwd) : null;
  return { project: projectName(cwd), branch: root ? gitBranch(root) : null };
}

const TASKS = [
  [/^gh pr\b/, () => 'PR', 9],
  [/^git (commit|ci)\b/, () => 'commit', 9],
  [/^git push\b/, () => 'push', 9],
  [/^claude\b/, () => 'Claude Code', 8],
  [/^(mvnw?|gradlew?) .*\btest|^(npm|yarn|pnpm|bun) (run )?test\b|^(pytest|jest|vitest)\b|^(go|cargo) test\b/, () => 'tests', 8],
  [/^(kubectl|helm|k9s)\b/, () => 'kubernetes', 7],
  [/^(terraform|pulumi)\b/, () => 'infra', 7],
  [/^(mvnw?|gradlew?)\b|^(npm|yarn|pnpm|bun) (run )?build\b|^make\b|^(go|cargo) build\b/, () => 'build', 7],
  [/^(npm|yarn|pnpm|bun) (run )?(dev|start|serve)\b/, () => 'dev server', 6],
  [/^docker(-compose)?\b/, () => 'docker', 6],
  [/^git (pull|fetch|rebase|merge|cherry-pick)\b/, () => 'sync', 6],
  [/^git (checkout|switch|branch)\b/, () => 'branches', 5],
  [/^ssh (?:-\S+ )*(\S+)/, (m) => `ssh ${m[1].split('@').pop()}`, 6],
  [/^(vim|nvim|vi|nano|code|emacs|subl|idea)\b.*?(\S+)$/, (m) => `edit ${path.basename(m[2])}`, 5],
  [/^aws\b/, () => 'aws', 5],
  [/^(tail|less|stern)\b.*(log|-f)/, () => 'logs', 4],
  [/^(npm|yarn|pnpm|pip3?|poetry|brew) (install|add|i)\b/, () => 'deps', 4],
  [/^(curl|http|wget|grpcurl)\b/, () => 'API calls', 4],
  [/^(python3?|node|ruby|bash|sh|deno|bun) \S/, () => 'scripts', 3],
  [/^git (diff|log|status|show|blame|stash)\b/, () => 'git', 2],
];

function normalizeSegment(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && (/^\w+=/.test(tokens[0]) || ['sudo', 'time', 'nohup', 'env', 'exec', 'command'].includes(tokens[0]))) tokens.shift();
  if (!tokens.length) return '';
  tokens[0] = tokens[0].split('/').pop();
  return tokens.join(' ');
}

function taskOf(segment) {
  const cmd = normalizeSegment(segment);
  if (!cmd) return null;
  for (const [re, label, weight] of TASKS) {
    const m = cmd.match(re);
    if (m) return { label: label(m), weight };
  }
  const fallback = describeSegment(cmd);
  return fallback ? { label: fallback.split(' ')[0], weight: 1, raw: true } : null;
}

function activityTitle(session) {
  const recent = session.recent || [];
  const scores = new Map();
  const raw = new Set();
  recent.forEach((line, i) => {
    const recency = 1 + i / recent.length;
    for (const part of line.split(/&&|\|\||;/)) {
      const task = taskOf(part.split('|')[0]);
      if (!task) continue;
      scores.set(task.label, (scores.get(task.label) || 0) + task.weight * recency);
      if (task.raw) raw.add(task.label);
    }
  });
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label]) => label);
  const project = projectName(session.cwd);
  if (!top.length) return project;
  const summary = top.join(' & ');
  const lead = raw.has(top[0]) ? summary : `${summary.charAt(0).toUpperCase()}${summary.slice(1)}`;
  const title = `${project} · ${lead}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function retitle(id) {
  const session = store.get(id);
  if (!session || session.titleLocked || !(session.recent || []).length) return;
  const title = activityTitle(session);
  if (title !== session.title) store.update(id, { title });
}

function wasEchoed(buf, line) {
  const squash = (s) => s.replace(/[\s\x08]+/g, '');
  return squash(stripAnsi(buf)).includes(squash(line));
}

function trackOutput(entry, data) {
  entry.out = (entry.out + data).slice(-OUT_TAIL);
  for (const p of entry.pending) if (p.buf.length < 4096) p.buf += data.slice(0, 4096 - p.buf.length);
  const on = data.lastIndexOf('\x1b[?1049h');
  const off = data.lastIndexOf('\x1b[?1049l');
  if (on !== off) entry.altScreen = on > off;
}

function nextEscState(state, ch) {
  if (state === 'esc') {
    if (ch === '[') return 'csi';
    if (ch === ']' || ch === 'P' || ch === '_' || ch === '^') return 'string';
    if (ch === 'O') return 'ss3';
    return null;
  }
  if (state === 'csi') return ch >= '@' && ch <= '~' ? null : 'csi';
  if (state === 'ss3') return null;
  if (state === 'string') {
    if (ch === '\x07') return null;
    return ch === '\x1b' ? 'string-esc' : 'string';
  }
  if (state === 'string-esc') return ch === '\\' ? null : 'string';
  return null;
}

function trackInput(id, data) {
  const entry = live.get(id);
  const session = store.get(id);
  if (!entry || !session) return;
  for (const ch of data) {
    if (entry.esc) {
      entry.esc = nextEscState(entry.esc, ch);
      continue;
    }
    if (ch === '\x1b') {
      entry.esc = 'esc';
    } else if (ch === '\r') {
      const line = entry.line.trim();
      const pending = { line, altScreen: entry.altScreen, buf: entry.out.slice(-1024) };
      entry.pending.push(pending);
      setTimeout(() => {
        entry.pending = entry.pending.filter((p) => p !== pending);
        onCommand(id, line && !pending.altScreen && wasEchoed(pending.buf, line) ? line : '');
      }, 250);
      entry.line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      entry.line = entry.line.slice(0, -1);
    } else if (ch === '\x03' || ch === '\x15') {
      entry.line = '';
    } else if (ch >= ' ') {
      entry.line += ch;
    }
  }
}

function onCommand(id, line) {
  const session = store.get(id);
  if (!session) return;
  const patch = { updatedAt: Date.now() };
  if (line) {
    patch.commands = (session.commands || 0) + 1;
    patch.recent = [...(session.recent || []), line].slice(-RECENT_MAX);
  }
  store.update(id, patch);
  retitle(id);
  broadcastSessions();
  setTimeout(() => refreshCwd(id), 400);
}

function refreshCwd(id) {
  const entry = live.get(id);
  if (!entry) return;
  execFile('lsof', ['-a', '-p', String(entry.proc.pid), '-d', 'cwd', '-Fn'], (err, out) => {
    if (err) return;
    const line = out.split('\n').find((l) => l.startsWith('n'));
    if (!line) return;
    const cwd = line.slice(1);
    const session = store.get(id);
    if (!session) return;
    const info = gitInfo(cwd);
    if (session.cwd !== cwd || session.branch !== info.branch || session.project !== info.project) {
      store.update(id, { cwd, ...info });
      retitle(id);
      broadcastSessions();
    }
  });
}

function createSession(opts = {}) {
  const cwd = opts.cwd || os.homedir();
  const session = store.create(cwd);
  store.update(session.id, gitInfo(cwd));
  spawnPty(session, opts.cols, opts.rows);
  broadcastSessions();
  return session;
}

function resumeSession(id, cols, rows, restored) {
  const session = store.get(id);
  if (!session) return null;
  if (live.has(id)) return session;
  const banner = stamp(restored ? 'restored' : 'resumed');
  store.append(id, banner);
  send('pty:data', id, banner);
  spawnPty(session, cols, rows);
  setTimeout(() => refreshCwd(id), 300);
  store.update(id, { updatedAt: Date.now() });
  broadcastSessions();
  return session;
}

function killSession(id) {
  const entry = live.get(id);
  if (entry) entry.proc.kill();
}

async function deleteSession(id) {
  const session = store.get(id);
  if (!session) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Delete “${session.title}”?`,
    detail: live.has(id)
      ? 'The running shell will be terminated and its history erased.'
      : 'Its saved history will be erased.',
  });
  if (response !== 0) return;
  const entry = live.get(id);
  live.delete(id);
  if (entry) entry.proc.kill();
  store.remove(id);
  send('pty:removed', id);
  broadcastSessions();
}

function registerIpc() {
  for (const s of store.list()) {
    if (!s.project) Object.assign(s, gitInfo(s.cwd));
    if (!s.titleLocked && (s.recent || []).length) s.title = activityTitle(s);
  }
  store.saveIndex();
  ipcMain.handle('state:init', () => ({
    sessions: store.list(),
    live: [...live.keys()],
    settings: store.settings,
    home: os.homedir(),
    shell: path.basename(process.env.SHELL || '/bin/zsh'),
    user: os.userInfo().username,
    host: os.hostname().replace(/\.local$/, ''),
    fullscreen: win ? win.isFullScreen() : false,
  }));
  ipcMain.handle('session:create', (_e, opts) => createSession(opts));
  ipcMain.handle('session:resume', (_e, id, cols, rows, restored) => resumeSession(id, cols, rows, restored));
  ipcMain.handle('session:history', (_e, id) => store.readLog(id));
  ipcMain.handle('session:rename', (_e, id, title) => {
    const clean = String(title || '').trim();
    store.update(id, clean ? { title: clean, titleLocked: true } : { title: DEFAULT_TITLE, titleLocked: false });
    broadcastSessions();
  });
  ipcMain.handle('session:pin', (_e, id, pinned) => {
    store.update(id, { pinned: !!pinned });
    broadcastSessions();
  });
  ipcMain.handle('session:delete', (_e, id) => deleteSession(id));
  ipcMain.handle('session:kill', (_e, id) => killSession(id));
  ipcMain.handle('settings:update', (_e, patch) => {
    Object.assign(store.settings, patch);
    store.saveSettings();
    syncNativeTheme();
    return store.settings;
  });

  ipcMain.on('win:fullscreen', (_e, on) => setFullScreen(!!on));
  ipcMain.on('app:badge', (_e, count) => {
    if (app.dock) app.dock.setBadge(count > 0 ? String(count) : '');
  });

  ipcMain.on('pty:write', (_e, id, data) => {
    const entry = live.get(id);
    if (!entry) return;
    trackInput(id, data);
    entry.proc.write(data);
  });
  ipcMain.on('pty:resize', (_e, id, cols, rows) => {
    const entry = live.get(id);
    if (!entry || !cols || !rows) return;
    try {
      entry.proc.resize(cols, rows);
    } catch {}
  });

  ipcMain.on('menu:session', (_e, id) => {
    const session = store.get(id);
    if (!session) return;
    const isLive = live.has(id);
    Menu.buildFromTemplate([
      { label: 'Rename…', click: () => send('ui:rename', id) },
      { label: session.pinned ? 'Unpin' : 'Pin to top', click: () => store.update(id, { pinned: !session.pinned }) && broadcastSessions() },
      { type: 'separator' },
      isLive
        ? { label: 'End shell', click: () => killSession(id) }
        : { label: 'Resume shell', click: () => send('ui:resume', id) },
      { label: 'New session in this folder', click: () => send('ui:new', { cwd: session.cwd }) },
      { label: 'Reveal folder in Finder', click: () => shell.openPath(session.cwd) },
      { type: 'separator' },
      { label: 'Delete…', click: () => deleteSession(id) },
    ]).popup({ window: win });
  });

  ipcMain.on('menu:terminal', (_e, hasSelection) => {
    Menu.buildFromTemplate([
      { label: 'Copy', role: 'copy', enabled: hasSelection },
      { label: 'Paste', role: 'paste' },
      { label: 'Select All', click: () => send('ui:action', 'selectAll') },
      { type: 'separator' },
      { label: 'Clear Scrollback', click: () => send('ui:action', 'clear') },
      { label: 'Find…', click: () => send('ui:action', 'find') },
    ]).popup({ window: win });
  });
}

function canvasColor() {
  const theme = store.settings.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : store.settings.lightTheme) : store.settings.theme;
  return { dark: '#161618', harbor: '#202123', paper: '#f3f3f1' }[theme] || '#202123';
}

function syncNativeTheme() {
  const theme = store.settings.theme;
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'system' ? 'system' : 'light';
  if (win && !win.isDestroyed()) win.setBackgroundColor(canvasColor());
}

function setFullScreen(on) {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() !== on) win.setFullScreen(on);
}

function action(name) {
  return () => send('ui:action', name);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: action('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Shell',
      submenu: [
        { label: 'New Session', accelerator: 'Cmd+T', click: action('new') },
        { label: 'New Session in Same Folder', accelerator: 'Cmd+Shift+T', click: action('newHere') },
        { type: 'separator' },
        { label: 'End Shell', accelerator: 'Cmd+W', click: action('close') },
        { label: 'Resume Shell', accelerator: 'Cmd+R', click: action('resume') },
        { type: 'separator' },
        { label: 'Rename Session…', accelerator: 'Cmd+Shift+R', click: action('rename') },
        { label: 'Pin / Unpin Session', accelerator: 'Cmd+Shift+P', click: action('pin') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All', accelerator: 'Cmd+A', click: action('selectAll') },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'Cmd+F', click: action('find') },
        { label: 'Find Next', accelerator: 'Cmd+G', click: action('findNext') },
        { label: 'Find Previous', accelerator: 'Cmd+Shift+G', click: action('findPrev') },
        { label: 'Search Sessions', accelerator: 'Alt+Cmd+F', click: action('searchSessions') },
        { type: 'separator' },
        { label: 'Clear Scrollback', accelerator: 'Cmd+K', click: action('clear') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+\\', click: action('toggleSidebar') },
        { type: 'separator' },
        { label: 'Bigger', accelerator: 'Cmd+=', click: action('fontBigger') },
        { label: 'Bigger', accelerator: 'Cmd+Plus', visible: false, acceleratorWorksWhenHidden: true, click: action('fontBigger') },
        { label: 'Smaller', accelerator: 'Cmd+-', click: action('fontSmaller') },
        { label: 'Default Size', accelerator: 'Cmd+0', click: action('fontReset') },
        { type: 'separator' },
        { label: 'Focus Mode (Full Screen)   ⇧⌘F', click: action('focus') },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'Alt+Cmd+I' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Previous Tab   ⇧⌘←', click: action('prev') },
        { label: 'Show Next Tab   ⇧⌘→', click: action('next') },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function windowBounds() {
  const saved = store.settings.window;
  if (!saved) return { width: 1280, height: 820 };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y;
  });
  return visible ? saved : { width: saved.width, height: saved.height };
}

function createWindow() {
  win = new BrowserWindow({
    ...windowBounds(),
    minWidth: 640,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: canvasColor(),
    fullscreenable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('enter-full-screen', () => send('ui:fullscreen', true));
  win.on('leave-full-screen', () => send('ui:fullscreen', false));
  win.on('close', saveWindowBounds);
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function saveWindowBounds() {
  if (win && !win.isDestroyed() && !win.isFullScreen()) store.settings.window = win.getBounds();
}

function shutdown() {
  if (quitting) return;
  quitting = true;
  saveWindowBounds();
  store.settings.lastLive = [...live.keys()];
  for (const [id, entry] of live) {
    const session = store.get(id);
    if (session && session.commands === 0 && !session.titleLocked && !session.pinned) {
      store.remove(id);
      store.settings.lastLive = store.settings.lastLive.filter((x) => x !== id);
    }
    try {
      entry.proc.kill();
    } catch {}
  }
  live.clear();
  store.close();
}

app.setName('TermHub');
if (process.env.TERMHUB_USER_DATA) app.setPath('userData', process.env.TERMHUB_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  installShellIntegration();
  if (app.dock && !app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  registerIpc();
  buildMenu();
  createWindow();
  syncNativeTheme();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', shutdown);
app.on('activate', () => {
  if (!win) createWindow();
});
