const api = window.termhub;
const $ = (sel) => document.querySelector(sel);

const THEMES = {
  dark: {
    background: '#1d1d20',
    foreground: '#dcdce0',
    cursor: '#c8c8ce',
    cursorAccent: '#1d1d20',
    selectionBackground: '#8fa8d640',
    black: '#1d1f24', red: '#ff6b6b', green: '#5fd38d', yellow: '#f5c25b',
    blue: '#6ab0ff', magenta: '#c792ea', cyan: '#5fd7d7', white: '#d4d4d8',
    brightBlack: '#6b7080', brightRed: '#ff8787', brightGreen: '#7ee2a8', brightYellow: '#ffd479',
    brightBlue: '#8cc4ff', brightMagenta: '#d9a8f5', brightCyan: '#86e6e6', brightWhite: '#ffffff',
  },
  paper: {
    background: '#fbfbfa',
    foreground: '#33332f',
    cursor: '#55554f',
    cursorAccent: '#fbfbfa',
    selectionBackground: '#4a6fa526',
    selectionInactiveBackground: '#4a6fa514',
    black: '#33332f', red: '#b5483f', green: '#3f7f52', yellow: '#9a6b1f',
    blue: '#3f67a3', magenta: '#875a95', cyan: '#2f7f7f', white: '#7c7c76',
    brightBlack: '#8e8e87', brightRed: '#c25d54', brightGreen: '#4f9163', brightYellow: '#a97b2c',
    brightBlue: '#5277b0', brightMagenta: '#976aa5', brightCyan: '#3c8f8f', brightWhite: '#5a5a55',
  },
};
THEMES.ivory = {
  background: '#f3f2ee',
  foreground: '#30312e',
  cursor: '#557a66',
  cursorAccent: '#f3f2ee',
  selectionBackground: '#557a6626',
  selectionInactiveBackground: '#557a6614',
  black: '#2b3136', red: '#b8514a', green: '#3f8061', yellow: '#8d7a12',
  blue: '#4a6b8a', magenta: '#85607f', cyan: '#3d7a72', white: '#7d7e79',
  brightBlack: '#8f918d', brightRed: '#c6645c', brightGreen: '#4f9272', brightYellow: '#9c8a1e',
  brightBlue: '#5a7b98', brightMagenta: '#94708e', brightCyan: '#4b8a81', brightWhite: '#575853',
};
THEMES.mac = {
  background: '#ffffff',
  foreground: '#000000',
  cursor: '#7f7f7f',
  cursorAccent: '#ffffff',
  selectionBackground: '#b4d5fe',
  selectionInactiveBackground: '#dcdcdc',
  black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900',
  blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
  brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900', brightYellow: '#e5e500',
  brightBlue: '#0000ff', brightMagenta: '#e500e5', brightCyan: '#00e5e5', brightWhite: '#e5e5e5',
};
const PROMPT_SP = /\x1b\[1m\x1b\[7m%\x1b\[27m\x1b\[1m\x1b\[0m +\r \r/g;
const FIND_DECORATIONS = {
  matchBackground: '#6b5a1e',
  matchOverviewRuler: '#b8952a',
  activeMatchBackground: '#d19a00',
  activeMatchColorOverviewRuler: '#ffcc33',
};
const MAX_WEBGL = 10;
const DEFAULT_FONT_SIZE = 13;
const ORPHAN_LIMIT = 200;
const HUES = [234, 262, 290, 330, 8, 28, 152, 178, 200];

const state = {
  sessions: [],
  live: new Set(),
  activeId: null,
  settings: {},
  home: '',
  query: '',
  renamingId: null,
  unread: new Set(),
};
const views = new Map();
const orphans = new Map();
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolvedTheme() {
  const t = state.settings.theme;
  if (t === 'system') return darkQuery.matches ? 'dark' : state.settings.lightTheme || 'harbor';
  return ['paper', 'harbor', 'dark'].includes(t) ? t : 'harbor';
}

function macTerminal() {
  return resolvedTheme() !== 'dark' && state.settings.terminalColors !== 'theme';
}

function termTheme() {
  if (macTerminal()) return 'mac';
  return { dark: 'dark', harbor: 'ivory' }[resolvedTheme()] || 'paper';
}

function contrastFor(name) {
  return name === 'paper' || name === 'ivory' ? 4.5 : 1;
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('mac-terminal', macTerminal());
  const name = termTheme();
  for (const v of views.values()) {
    v.term.options.theme = THEMES[name];
    v.term.options.minimumContrastRatio = contrastFor(name);
    v.term.options.drawBoldTextInBrightColors = name === 'dark';
  }
}

function termOptions() {
  const s = state.settings;
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: 1,
    fontWeight: '400',
    fontWeightBold: 'bold',
    letterSpacing: 0,
    cursorBlink: s.cursorBlink,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    macOptionIsMeta: s.optionIsMeta,
    macOptionClickForcesSelection: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: THEMES[termTheme()],
    minimumContrastRatio: contrastFor(termTheme()),
    drawBoldTextInBrightColors: termTheme() === 'dark',
  };
}

function shortPath(p) {
  if (!p) return '';
  return p.startsWith(state.home) ? `~${p.slice(state.home.length)}` : p;
}

function projectOf(s) {
  if (s.project) return s.project;
  if (!s.cwd || s.cwd === state.home) return '~';
  return s.cwd.split('/').filter(Boolean).pop() || '~';
}

function paintAvatar(el, s) {
  const project = projectOf(s);
  let h = 0;
  for (const ch of project) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  el.style.setProperty('--h', HUES[h % HUES.length]);
  el.textContent = project === '~' ? '~' : project.replace(/^[^a-z0-9]+/i, '').charAt(0) || project.charAt(0);
  el.classList.toggle('live', state.live.has(s.id));
}

function webglCount() {
  let n = 0;
  for (const v of views.values()) if (v.webgl) n++;
  return n;
}

function makeView(id) {
  const el = document.createElement('div');
  el.className = 'term-host';
  $('#terminals').appendChild(el);

  const term = new Terminal(termOptions());
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon.WebLinksAddon((event, uri) => {
      if (event.metaKey) window.open(uri);
    })
  );
  term.open(el);

  const view = { id, el, term, fit, search, webgl: null, loading: false, queue: [], quietUntil: Date.now() + 2500 };
  if (state.settings.gpuRendering && webglCount() < MAX_WEBGL) {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        view.webgl = null;
      });
      term.loadAddon(webgl);
      view.webgl = webgl;
    } catch {}
  }

  term.attachCustomKeyEventHandler((e) => handleTermKey(view, e));
  term.onData((data) => {
    if (state.live.has(id)) api.write(id, data);
  });
  term.onResize(({ cols, rows }) => {
    view.quietUntil = Math.max(view.quietUntil, Date.now() + 1000);
    if (state.live.has(id)) api.resize(id, cols, rows);
    if (state.activeId === id) renderStatus();
  });
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (state.activeId !== id) return;
    $('#find-count').textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : 'No results';
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.terminalMenu(term.hasSelection());
  });

  views.set(id, view);
  safeFit(view);
  return view;
}

function handleTermKey(view, e) {
  if (isAppShortcut(e)) return false;
  if (e.type !== 'keydown') return !e.metaKey;
  const write = (seq) => {
    if (state.live.has(view.id)) api.write(view.id, seq);
    e.preventDefault();
    return false;
  };
  if (e.metaKey) {
    if (e.key === 'ArrowLeft') return write('\x01');
    if (e.key === 'ArrowRight') return write('\x05');
    if (e.key === 'Backspace') return write('\x15');
    return false;
  }
  if (e.altKey && state.settings.optionIsMeta) {
    if (e.key === 'ArrowLeft') return write('\x1bb');
    if (e.key === 'ArrowRight') return write('\x1bf');
    if (e.key === 'Backspace') return write('\x17');
  }
  if (e.shiftKey && e.key === 'Enter') return write('\x1b\r');
  return true;
}

function appShortcut(e) {
  if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
    if (e.code === 'KeyF') return () => setFocusMode(!focus.on);
    if (e.code === 'BracketLeft' || e.code === 'ArrowLeft') return () => stepSession(-1);
    if (e.code === 'BracketRight' || e.code === 'ArrowRight') return () => stepSession(1);
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Tab') return () => stepSession(e.shiftKey ? -1 : 1);
  if (e.metaKey && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyF') return () => setFocusMode(!focus.on);
  return null;
}

function isAppShortcut(e) {
  return appShortcut(e) !== null;
}

function disposeView(id) {
  const view = views.get(id);
  if (!view) return;
  view.term.dispose();
  view.el.remove();
  views.delete(id);
}

function safeFit(view) {
  try {
    view.fit.fit();
  } catch {}
}

function markUnread(id) {
  const view = views.get(id);
  if (id === state.activeId || state.unread.has(id) || !view || view.loading || Date.now() < view.quietUntil) return;
  state.unread.add(id);
  renderSidebar();
  api.setBadge(state.unread.size);
}

function clearUnread(id) {
  if (!state.unread.delete(id)) return;
  api.setBadge(state.unread.size);
}

function writeOrQueue(view, data) {
  if (view.loading) view.queue.push(data);
  else view.term.write(data);
}

async function loadHistoryInto(view) {
  view.loading = true;
  const history = await api.history(view.id);
  orphans.delete(view.id);
  if (history) {
    view.term.write(history.replace(PROMPT_SP, ''));
    const inAltScreen = history.lastIndexOf('\x1b[?1049h') > history.lastIndexOf('\x1b[?1049l');
    view.term.write(`${inAltScreen ? '\x1b[?1049l\r\n' : ''}\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h`);
  }
  view.loading = false;
  for (const chunk of view.queue) view.term.write(chunk);
  view.queue = [];
}

async function ensureView(id) {
  let view = views.get(id);
  if (view) return view;
  view = makeView(id);
  await loadHistoryInto(view);
  return view;
}

function activeView() {
  return state.activeId ? views.get(state.activeId) : null;
}

function activeSession() {
  return state.sessions.find((s) => s.id === state.activeId) || null;
}

async function select(id) {
  if (!id) {
    state.activeId = null;
    render();
    return;
  }
  const previous = state.activeId;
  state.activeId = id;
  clearUnread(id);
  const view = await ensureView(id);
  if (state.activeId !== id) return;
  for (const v of views.values()) v.el.classList.toggle('active', v.id === id);
  if (previous && previous !== id && !state.live.has(previous)) disposeView(previous);
  closeFind();
  render();
  requestAnimationFrame(() => {
    safeFit(view);
    view.term.focus();
  });
}

async function createNew(opts = {}) {
  const dims = activeView() ? { cols: activeView().term.cols, rows: activeView().term.rows } : {};
  const session = await api.createSession({ ...opts, ...dims });
  state.live.add(session.id);
  if (!state.sessions.some((s) => s.id === session.id)) state.sessions.unshift(session);
  const view = makeView(session.id);
  for (const chunk of orphans.get(session.id) || []) view.term.write(chunk);
  orphans.delete(session.id);
  await select(session.id);
}

async function resume(id, restored = false) {
  if (!id || state.live.has(id)) return;
  const view = await ensureView(id);
  state.live.add(id);
  view.quietUntil = Date.now() + 2500;
  await api.resumeSession(id, view.term.cols, view.term.rows, restored);
  if (state.activeId === id) {
    render();
    view.term.focus();
  }
}

function orderedSessions() {
  const q = state.query.trim().toLowerCase();
  const list = q
    ? state.sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          (s.cwd || '').toLowerCase().includes(q) ||
          (s.recent || []).some((c) => c.toLowerCase().includes(q))
      )
    : state.sessions.slice();
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = [
    { label: 'Pinned', items: [] },
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ];
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const day = 86400000;
  for (const s of list) {
    let g;
    if (s.pinned) g = 0;
    else if (s.updatedAt >= startOfToday) g = 1;
    else if (s.updatedAt >= startOfToday - day) g = 2;
    else if (s.updatedAt >= startOfToday - 7 * day) g = 3;
    else if (s.updatedAt >= startOfToday - 30 * day) g = 4;
    else g = 5;
    groups[g].items.push(s);
  }
  return groups.filter((g) => g.items.length);
}

function flatOrder() {
  return orderedSessions().flatMap((g) => g.items);
}

function relativeTime(ts) {
  const d = new Date(ts);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ts >= startOfToday - 6 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderSidebar() {
  const nav = $('#session-list');
  nav.textContent = '';
  const groups = orderedSessions();
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = state.query ? 'No matching sessions' : 'No sessions yet';
    nav.appendChild(empty);
    return;
  }
  for (const group of groups) {
    const h = document.createElement('div');
    h.className = 'group-label';
    h.textContent = group.label;
    nav.appendChild(h);
    for (const s of group.items) nav.appendChild(renderItem(s));
  }
}

function renderItem(s) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.classList.toggle('active', s.id === state.activeId);
  item.classList.toggle('live', state.live.has(s.id));
  item.classList.toggle('unread', state.unread.has(s.id));
  item.dataset.id = s.id;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  paintAvatar(avatar, s);
  item.appendChild(avatar);

  const text = document.createElement('div');
  text.className = 'item-text';
  if (state.renamingId === s.id) {
    text.appendChild(renameInput(s));
  } else {
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = s.title;
    title.title = s.title;
    text.appendChild(title);
  }
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const where = document.createElement('span');
  if (s.branch) {
    where.className = 'branch';
    where.textContent = `⎇ ${s.branch}`;
  } else {
    where.className = 'path';
    where.textContent = shortPath(s.cwd);
  }
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = relativeTime(s.updatedAt);
  meta.append(where, time);
  text.appendChild(meta);
  item.appendChild(text);

  const dotEl = document.createElement('span');
  dotEl.className = 'unread-dot';
  item.appendChild(dotEl);

  const more = document.createElement('button');
  more.className = 'more-btn';
  more.title = 'More';
  more.textContent = '⋯';
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    api.sessionMenu(s.id);
  });
  item.appendChild(more);

  item.addEventListener('click', () => {
    if (state.renamingId !== s.id) select(s.id);
  });
  item.addEventListener('dblclick', () => startRename(s.id));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.sessionMenu(s.id);
  });
  return item;
}

function renameInput(s) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = s.title;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    state.renamingId = null;
    if (commit && input.value.trim() !== s.title) api.rename(s.id, input.value);
    else renderSidebar();
    activeView()?.term.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
}

function startRename(id) {
  if (!id) return;
  document.body.classList.remove('sidebar-hidden');
  state.renamingId = id;
  renderSidebar();
}

function renderHeader() {
  const s = activeSession();
  const isLive = s && state.live.has(s.id);
  $('#header-title').textContent = s ? s.title : 'TermHub';
  $('#header-cwd').textContent = s ? shortPath(s.cwd) : 'No session';
  $('#chip-branch').hidden = !(s && s.branch);
  $('#header-branch').textContent = (s && s.branch) || '';
  const avatar = $('#header-avatar');
  avatar.hidden = !s;
  if (s) paintAvatar(avatar, s);
  $('#header-status-text').textContent = s ? (isLive ? 'Running' : 'Ended') : '';
  $('#header-status').className = s ? (isLive ? 'running' : 'ended') : 'none';
  $('#header-more').hidden = !s;
  $('#ended-bar').hidden = !s || isLive;
  $('#empty').hidden = !!s;
  $('#statusbar').hidden = !s;
  renderStatus();
  const running = state.sessions.filter((x) => state.live.has(x.id)).length;
  $('#brand-sub').textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'} · ${running} running`;
  document.title = s ? `${s.title} — TermHub` : 'TermHub';
}

function renderStatus() {
  const view = activeView();
  const left = $('#status-left');
  left.textContent = '';
  if (!view) return;
  const parts = [state.shell, `${view.term.cols}×${view.term.rows}`, 'UTF-8'];
  const s = activeSession();
  if (s && s.commands) parts.push(`${s.commands} command${s.commands === 1 ? '' : 's'}`);
  for (const p of parts) {
    const span = document.createElement('span');
    span.textContent = p;
    left.appendChild(span);
  }
}

function render() {
  renderSidebar();
  renderHeader();
}

function openFind() {
  const view = activeView();
  if (!view) return;
  $('#findbar').hidden = false;
  const input = $('#find-input');
  const selection = view.term.getSelection();
  if (selection && !selection.includes('\n')) input.value = selection;
  input.focus();
  input.select();
  if (input.value) findNext();
}

function closeFind() {
  if ($('#findbar').hidden) return;
  $('#findbar').hidden = true;
  $('#find-count').textContent = '';
  const view = activeView();
  if (view) {
    view.search.clearDecorations();
    view.term.focus();
  }
}

function findNext(incremental = false) {
  const view = activeView();
  const q = $('#find-input').value;
  if (!view || !q) return;
  view.search.findNext(q, { incremental, decorations: FIND_DECORATIONS });
}

function findPrev() {
  const view = activeView();
  const q = $('#find-input').value;
  if (!view || !q) return;
  view.search.findPrevious(q, { decorations: FIND_DECORATIONS });
}

async function updateSettings(patch) {
  state.settings = await api.updateSettings(patch);
  for (const v of views.values()) {
    v.term.options.fontFamily = state.settings.fontFamily;
    v.term.options.fontSize = state.settings.fontSize;
    v.term.options.cursorBlink = state.settings.cursorBlink;
    v.term.options.macOptionIsMeta = state.settings.optionIsMeta;
  }
  applyTheme();
  fitAll();
}

function fitAll() {
  for (const v of views.values()) safeFit(v);
}

function setFontSize(size) {
  updateSettings({ fontSize: Math.max(8, Math.min(32, size)) });
}

function toggleSidebar(force, persist = true) {
  const hidden = force ?? !document.body.classList.contains('sidebar-hidden');
  document.body.classList.toggle('sidebar-hidden', hidden);
  if (persist) api.updateSettings({ sidebarHidden: hidden });
  setTimeout(fitAll, 260);
}

const focus = { on: false, sidebarWasHidden: false };

function setFocusMode(on) {
  if (focus.on === on) return;
  focus.on = on;
  if (on) {
    focus.sidebarWasHidden = document.body.classList.contains('sidebar-hidden');
    toggleSidebar(true, false);
  } else {
    toggleSidebar(focus.sidebarWasHidden, false);
  }
  api.setFullScreen(on);
}

function stepSession(delta) {
  const list = flatOrder();
  if (!list.length) return;
  const i = list.findIndex((s) => s.id === state.activeId);
  const next = list[(i + delta + list.length) % list.length];
  select(next.id);
}

function openSettings() {
  const s = state.settings;
  $('#set-theme').value = s.theme;
  $('#set-font').value = s.fontFamily;
  $('#set-size').value = s.fontSize;
  $('#set-meta').checked = s.optionIsMeta;
  $('#set-termcolors').value = s.terminalColors === 'theme' ? 'theme' : 'mac';
  $('#set-blink').checked = s.cursorBlink;
  $('#set-restore').checked = s.restoreOnLaunch;
  $('#set-prompt').checked = s.styledPrompt !== false;
  $('#settings').hidden = false;
}

function closeSettings() {
  $('#settings').hidden = true;
  activeView()?.term.focus();
}

const actions = {
  new: () => createNew(),
  newHere: () => createNew({ cwd: activeSession()?.cwd }),
  close: () => {
    if (state.activeId && state.live.has(state.activeId)) api.kill(state.activeId);
  },
  resume: () => resume(state.activeId),
  rename: () => startRename(state.activeId),
  pin: () => {
    const s = activeSession();
    if (s) api.pin(s.id, !s.pinned);
  },
  selectAll: () => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.classList.contains('xterm-helper-textarea')) el.select();
    else activeView()?.term.selectAll();
  },
  find: openFind,
  findNext: () => ($('#findbar').hidden ? openFind() : findNext()),
  findPrev: () => ($('#findbar').hidden ? openFind() : findPrev()),
  searchSessions: () => {
    toggleSidebar(false);
    $('#session-search').focus();
    $('#session-search').select();
  },
  clear: () => activeView()?.term.clear(),
  toggleSidebar: () => toggleSidebar(),
  fontBigger: () => setFontSize(state.settings.fontSize + 1),
  fontSmaller: () => setFontSize(state.settings.fontSize - 1),
  fontReset: () => setFontSize(DEFAULT_FONT_SIZE),
  focus: () => setFocusMode(!focus.on),
  prev: () => stepSession(-1),
  next: () => stepSession(1),
  settings: openSettings,
};

function wireUi() {
  $('#new-session').addEventListener('click', () => createNew());
  $('#empty-new').addEventListener('click', () => createNew());
  $('#toggle-sidebar').addEventListener('click', () => toggleSidebar(false));
  $('#collapse-sidebar').addEventListener('click', () => toggleSidebar(true));
  $('#header-more').addEventListener('click', () => state.activeId && api.sessionMenu(state.activeId));
  $('#theme-toggle').addEventListener('click', () =>
    updateSettings(resolvedTheme() === 'dark' ? { theme: state.settings.lightTheme || 'harbor' } : { theme: 'dark', lightTheme: resolvedTheme() })
  );
  $('#resume-btn').addEventListener('click', () => resume(state.activeId));
  $('#open-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings').addEventListener('click', (e) => {
    if (e.target.id === 'settings') closeSettings();
  });
  $('#set-theme').addEventListener('change', (e) => {
    const theme = e.target.value;
    updateSettings(theme === 'paper' || theme === 'harbor' ? { theme, lightTheme: theme } : { theme });
  });
  $('#set-font').addEventListener('change', (e) => updateSettings({ fontFamily: e.target.value || '"SF Mono", Menlo, monospace' }));
  $('#set-size').addEventListener('change', (e) => setFontSize(Number(e.target.value) || DEFAULT_FONT_SIZE));
  $('#set-termcolors').addEventListener('change', (e) => updateSettings({ terminalColors: e.target.value }));
  $('#set-meta').addEventListener('change', (e) => updateSettings({ optionIsMeta: e.target.checked }));
  $('#set-blink').addEventListener('change', (e) => updateSettings({ cursorBlink: e.target.checked }));
  $('#set-restore').addEventListener('change', (e) => updateSettings({ restoreOnLaunch: e.target.checked }));
  $('#set-prompt').addEventListener('change', (e) => updateSettings({ styledPrompt: e.target.checked }));

  const search = $('#session-search');
  search.addEventListener('input', () => {
    state.query = search.value;
    renderSidebar();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      state.query = '';
      renderSidebar();
      activeView()?.term.focus();
    }
    if (e.key === 'Enter') {
      const first = flatOrder()[0];
      if (first) select(first.id);
    }
  });

  const findInput = $('#find-input');
  findInput.addEventListener('input', () => findNext(true));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.shiftKey ? findPrev : findNext)();
    if (e.key === 'Escape') closeFind();
  });
  $('#find-next').addEventListener('click', () => findNext());
  $('#find-prev').addEventListener('click', () => findPrev());
  $('#find-close').addEventListener('click', closeFind);

  window.addEventListener(
    'keydown',
    (e) => {
      const run = appShortcut(e);
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) run();
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settings').hidden) return closeSettings();
    if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const list = flatOrder();
      const target = e.key === '9' ? list[list.length - 1] : list[Number(e.key) - 1];
      if (target) select(target.id);
      e.preventDefault();
    }
  });

  const resizer = $('#resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.max(200, Math.min(460, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
      fitAll();
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10);
      api.updateSettings({ sidebarWidth: w });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  new ResizeObserver(() => fitAll()).observe($('#terminals'));
  darkQuery.addEventListener('change', applyTheme);
  setInterval(renderSidebar, 60000);
}

function wireIpc() {
  api.onData((id, data) => {
    const view = views.get(id);
    if (view) {
      writeOrQueue(view, data);
      return markUnread(id);
    }
    const list = orphans.get(id) || [];
    if (list.length < ORPHAN_LIMIT) list.push(data);
    orphans.set(id, list);
  });
  api.onExit((id, banner) => {
    state.live.delete(id);
    const view = views.get(id);
    if (view) writeOrQueue(view, banner);
    if (id !== state.activeId) {
      markUnread(id);
      disposeView(id);
    }
    render();
  });
  api.onRemoved((id) => {
    state.live.delete(id);
    state.sessions = state.sessions.filter((s) => s.id !== id);
    disposeView(id);
    orphans.delete(id);
    clearUnread(id);
    if (state.activeId === id) {
      const next = flatOrder().find((s) => state.live.has(s.id)) || flatOrder()[0];
      select(next ? next.id : null);
    } else {
      render();
    }
  });
  api.onSessions((sessions, live) => {
    state.sessions = sessions;
    state.live = new Set(live);
    render();
  });
  api.onAction((name) => actions[name]?.());
  api.onRename((id) => startRename(id));
  api.onResume((id) => select(id).then(() => resume(id)));
  api.onNew((opts) => createNew(opts));
  api.onFullscreen((on) => {
    document.body.classList.toggle('fullscreen', on);
    if (!on && focus.on) {
      focus.on = false;
      toggleSidebar(focus.sidebarWasHidden, false);
    }
    setTimeout(fitAll, 300);
  });
}

async function boot() {
  const init = await api.init();
  state.sessions = init.sessions;
  state.live = new Set(init.live);
  state.settings = init.settings;
  state.home = init.home;
  state.shell = init.shell || 'zsh';
  $('#profile-name').textContent = init.user || '';
  $('#profile-host').textContent = init.host || '';
  $('#profile-avatar').textContent = (init.user || '?').charAt(0);
  document.body.classList.toggle('fullscreen', init.fullscreen);
  document.body.classList.toggle('sidebar-hidden', !!state.settings.sidebarHidden);
  if (state.settings.sidebarWidth) {
    document.documentElement.style.setProperty('--sidebar-width', `${state.settings.sidebarWidth}px`);
  }
  applyTheme();
  wireUi();
  wireIpc();
  render();

  const known = new Set(state.sessions.map((s) => s.id));
  const restore = state.settings.restoreOnLaunch ? (state.settings.lastLive || []).filter((id) => known.has(id)) : [];
  await api.updateSettings({ lastLive: [] });
  if (!restore.length) return createNew();
  for (const id of restore) {
    await ensureView(id);
    await resume(id, true);
  }
  await select(restore[0]);
}

boot();
