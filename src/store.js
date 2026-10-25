const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_MAX_BYTES = 4 * 1024 * 1024;
const LOG_TRIM_TO_BYTES = 3 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 400;

class Store {
  constructor(rootDir) {
    this.dir = path.join(rootDir, 'sessions');
    this.indexFile = path.join(rootDir, 'sessions.json');
    this.settingsFile = path.join(rootDir, 'settings.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = this._readJson(this.indexFile, []);
    this.settings = Object.assign(
      {
        fontSize: 13,
        fontFamily: '"SF Mono", Menlo, Monaco, monospace',
        optionIsMeta: true,
        theme: 'harbor',
        restoreOnLaunch: true,
        cursorBlink: true,
        lastLive: [],
        window: null,
      },
      this._readJson(this.settingsFile, {})
    );
    if (this.settings.theme === 'light') this.settings.theme = 'paper';
    if (this.settings.theme === 'aubergine') this.settings.theme = 'harbor';
    if (this.settings.lightTheme === 'aubergine') this.settings.lightTheme = 'harbor';
    if (!this.settings.harborIntroduced) {
      this.settings.harborIntroduced = true;
      if (this.settings.theme !== 'dark') this.settings.theme = 'harbor';
      this.settings.lightTheme = 'harbor';
    }
    this.pending = new Map();
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  _writeJson(file, value) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  saveIndex() {
    this._writeJson(this.indexFile, this.sessions);
  }

  saveSettings() {
    this._writeJson(this.settingsFile, this.settings);
  }

  list() {
    return this.sessions;
  }

  get(id) {
    return this.sessions.find((s) => s.id === id);
  }

  create(cwd) {
    const now = Date.now();
    const session = {
      id: crypto.randomUUID(),
      title: 'New terminal',
      titleLocked: false,
      cwd,
      pinned: false,
      commands: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.unshift(session);
    this.saveIndex();
    return session;
  }

  update(id, patch) {
    const session = this.get(id);
    if (!session) return null;
    Object.assign(session, patch);
    this.saveIndex();
    return session;
  }

  remove(id) {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.pending.delete(id);
    this.saveIndex();
    fs.rmSync(this.logPath(id), { force: true });
  }

  logPath(id) {
    return path.join(this.dir, `${id}.log`);
  }

  append(id, data) {
    const chunks = this.pending.get(id);
    if (chunks) chunks.push(data);
    else this.pending.set(id, [data]);
  }

  flush() {
    for (const [id, chunks] of this.pending) {
      if (!this.get(id)) continue;
      const file = this.logPath(id);
      fs.appendFileSync(file, chunks.join(''));
      this._trimIfNeeded(file);
    }
    this.pending.clear();
  }

  _trimIfNeeded(file) {
    const { size } = fs.statSync(file);
    if (size <= LOG_MAX_BYTES) return;
    const buf = fs.readFileSync(file);
    let start = buf.length - LOG_TRIM_TO_BYTES;
    const newline = buf.indexOf(0x0a, start);
    if (newline !== -1) start = newline + 1;
    fs.writeFileSync(file, buf.subarray(start));
  }

  readLog(id) {
    this.flush();
    try {
      return fs.readFileSync(this.logPath(id), 'utf8');
    } catch {
      return '';
    }
  }

  close() {
    clearInterval(this.timer);
    this.flush();
    this.saveIndex();
    this.saveSettings();
  }
}

module.exports = { Store };
