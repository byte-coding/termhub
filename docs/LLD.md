# TermHub — Low-Level Design

This document describes how each module works. For the big picture, read the [HLD](HLD.md) first.

## 1. Module map

| File | Process | Responsibility |
|---|---|---|
| `src/main.js` | main | App lifecycle, PTY management, input tracking, titles, git/cwd detection, IPC handlers, menus, window, Dock badge, shell-integration install. |
| `src/store.js` | main | `Store` class: session index, settings, buffered append-only output logs. |
| `src/preload.js` | preload | `window.termhub` bridge (contextBridge → ipcRenderer). |
| `src/renderer.js` | renderer | UI state, sidebar, xterm.js views, history replay, unread tracking, themes, shortcuts, settings modal. |
| `src/index.html`, `src/styles.css` | renderer | Markup, CSP, theme tokens and layout. |
| `src/shell/zsh/{zshenv,zprofile,zshrc,zlogin}` | shell | Optional prompt integration (installed as dotfiles into a private `ZDOTDIR`). |
| `scripts/make-icon.js`, `build/icon.html` | build | Renders the app icon with Electron offscreen. |

## 2. Main process

### 2.1 Startup

```
app.setName('TermHub')
if TERMHUB_USER_DATA → app.setPath('userData', …)        // isolated data for development/tests
requestSingleInstanceLock() or exit                       // one writer per data folder
whenReady:
  store = new Store(userData)
  installShellIntegration()                               // copy src/shell/zsh/<f> → userData/shell/zsh/.<f>
  registerIpc()                                           // also backfills project/branch + recomputes titles
  buildMenu(); createWindow(); syncNativeTheme()
before-quit → shutdown()
```

The integration files are shipped without leading dots (packagers often skip dotfiles, and zsh can't
read files inside `app.asar`) and copied out on every launch.

### 2.2 Spawning a shell

`spawnPty(session, cols, rows)`:

- Shell: `$SHELL` (fallback `/bin/zsh`), started as a login shell (`-l`).
- Working directory: `session.cwd` if it still exists, else `$HOME`.
- Environment (`shellEnv` + `shellEnvFor`):
  - `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=TermHub`, `TERM_PROGRAM_VERSION`.
  - `LANG=en_US.UTF-8` and `CLICOLOR=1` if unset.
  - Removed: `ELECTRON_RUN_AS_NODE`, `CLAUDECODE`, every `CLAUDE_CODE_*`.
  - zsh only, unless `settings.styledPrompt === false`: `TERMHUB_PROMPT=1`, `ZDOTDIR=<userData>/shell/zsh`,
    and `TERMHUB_USER_ZDOTDIR` = the user's original `ZDOTDIR` if they had one.
- Live entry kept in `live: Map<id, Entry>`:

```js
Entry = { proc, line, esc, out, altScreen, pending: [{ line, altScreen, buf }] }
```

- `onData`: update output tracking → `store.append` → send `pty:data`.
- `onExit`: if the session never ran a command (and isn't renamed or pinned, and the app isn't
  quitting) it is deleted (`pty:removed`); otherwise an `╌╌ session ended (exit N) ╌╌` marker is
  appended and `pty:exit` is sent.

### 2.3 Input tracking and command capture

Every `pty:write` passes through `trackInput` before reaching the PTY. It maintains the current line:

| Input | Effect on `line` |
|---|---|
| printable char | appended |
| `DEL` / `BS` | last char removed |
| `^C` / `^U` | cleared |
| `ESC …` | consumed by the escape parser (below) |
| `CR` | line is *submitted* (below) and cleared |

**Escape parser** — `nextEscState(state, ch)`, a small state machine so terminal *replies* (cursor
position, device attributes, OSC color answers, focus events) and key sequences never leak into `line`:

```
null --ESC--> esc
esc  --'['--> csi        (ends on a final byte 0x40–0x7E)
esc  --']' 'P' '_' '^'--> string   (ends on BEL, or ESC '\')
esc  --'O'--> ss3        (ends after one byte)
esc  --other--> null     (two-byte sequence, e.g. Meta-b)
```

**Echo verification** — on `CR`, a pending record is created with the last 1 KB of output and the
alternate-screen flag. For 250 ms, new output is appended to its buffer (up to 4 KB). Then:

```
recorded = line != ''  &&  !altScreen  &&  squash(stripAnsi(buf)).includes(squash(line))
```

`squash` removes whitespace and backspaces. Hidden input (passwords) is normally not echoed, and
keystrokes in full-screen apps (vim, less, Claude Code's UI) occur with the alternate screen active, so
neither is normally recorded.

After **every** Enter, `onCommand` bumps `updatedAt`, retitles, broadcasts and schedules `refreshCwd`
400 ms later. Only an accepted line also increments `commands` and is appended to `recent` (max 30).

**Limits** (it is a heuristic over raw keystrokes and the raw output stream, not the rendered screen):

- Hidden input that happens to appear in the output buffer (a short answer like `y`, text shown earlier)
  is recorded.
- Commands recalled from history (↑, ^R) aren't recorded: their keys go through the escape parser, so
  `line` stays empty.
- Tab completion is dropped, so a completed command is stored as the typed prefix.
- Lines edited with ←/→, ^W/⌥⌫ or a mid-line fix may fail verification and be dropped.

`trackOutput` keeps a 4 KB tail of output and flips `altScreen` on `ESC[?1049h` / `ESC[?1049l`.

### 2.4 Working directory and git

`refreshCwd(id)` runs `lsof -a -p <shell pid> -d cwd -Fn` and parses the `n<path>` line. Then:

- `gitRoot(cwd)`: walk up until a directory containing `.git`; stops before reaching `$HOME` or `/`
  (neither is checked itself, so a repo rooted at `~` is not detected).
- `gitBranch(root)`: read `.git/HEAD`; if `.git` is a file (worktree/submodule), follow `gitdir:`.
  `ref: refs/heads/<name>` → `<name>`; a detached HEAD → first 7 chars of the hash.
- `projectName(cwd)`: `~` for home, else the git root's basename, else the folder's basename.

Changes to `cwd`, `project` or `branch` are saved, retitled and broadcast.

### 2.5 Title generation

```
title = "<project> · <Task1> & <task2>"      (max 40 chars, ellipsized)
```

For each recorded command line (oldest → newest, index `i` of `n`), split on `&&`, `||` and `;`,
keep the part before any `|`, strip `sudo`/`env`/`time`/`VAR=` prefixes and path prefixes, and
classify it with the first matching rule:

| Weight | Label | Matches |
|---:|---|---|
| 9 | PR · commit · push | `gh pr`, `git commit`, `git push` |
| 8 | Claude Code · tests | `claude`; `gradle/mvn … test`, `npm/yarn/pnpm/bun test`, `pytest`, `jest`, `vitest`, `go/cargo test` |
| 7 | kubernetes · infra · build | `kubectl`/`helm`/`k9s`; `terraform`/`pulumi`; `gradle`/`mvn`, `npm run build`, `make`, `go/cargo build` |
| 6 | dev server · docker · sync · ssh *host* | `npm run dev/start/serve`; `docker`; `git pull/fetch/rebase/merge/cherry-pick`; `ssh host` |
| 5 | branches · edit *file* · aws | `git checkout/switch/branch`; `vim/code/nano … file`; `aws` |
| 4 | logs · deps · API calls | `tail`/`less`/`stern` with `-f` or `log` in the arguments; `npm/pip/brew install`; `curl`/`http`/`wget`/`grpcurl` |
| 3 | scripts | `python`/`node`/`bash`/… *file* |
| 2 | git | `git diff/log/status/show/blame/stash` |
| 1 | *raw command name* | anything else not in the skip list (`cd`, `ls`, `echo`, `cat`, `clear`, `sleep`, `false`, …) |

Each match adds `weight × (1 + i/n)` to its label's score, so recent work outweighs old work. The two
highest labels form the title; the first is capitalized unless it is a raw command name. Sessions with
`titleLocked` (user-renamed) are never retitled. Titles of existing sessions are recomputed at startup,
so rule changes apply retroactively.

### 2.6 Resume, delete, shutdown

- `resumeSession(id, cols, rows, restored)`: no-op if already live; append and send a
  `╌╌ resumed ╌╌` (or `╌╌ restored ╌╌` at launch) marker, spawn a PTY, refresh cwd after 300 ms.
- `deleteSession(id)`: native confirmation dialog → kill PTY (removing it from `live` first, so its
  exit handler is ignored) → `store.remove` → `pty:removed`.
- `shutdown()` (on `before-quit`): save window bounds, set `settings.lastLive = live ids` minus
  sessions with zero commands that are neither renamed nor pinned (those are deleted), kill all PTYs,
  then `store.close()` (final flush + save). After a crash this never runs: nothing is restored and
  running sessions appear as ended.

### 2.7 Window, menus, theme

- `BrowserWindow`: `titleBarStyle: 'hiddenInset'`, traffic lights at (16, 16), min 640×400. Saved
  position is reused only if it intersects a display's work area (otherwise only the size is kept).
  Bounds are saved on window close and at quit (skipped while full screen).
- `syncNativeTheme()`: `nativeTheme.themeSource` = `dark` / `light` / `system`, and the window
  background is set to the theme's frame color to avoid flashes.
- Menu items dispatch `ui:action` events to the renderer. Shortcuts that macOS menus handle unreliably
  are handled in the renderer (§4.6); `⇧⌘F` and `⇧⌘←`/`→` appear in menu labels as hints, while
  `⇧⌘[`/`]`, `⌃⌘F` and `⌃Tab` are not shown in the menu.
- New-window requests are denied; only `http(s)` URLs are passed to `shell.openExternal`.
- The Dock badge shows the number of unread sessions (`app:badge`).

## 3. Persistence

All paths are relative to `app.getPath('userData')` = `~/Library/Application Support/TermHub`.

### 3.1 `sessions.json`

An array, newest first. Rewritten atomically (`.tmp` + `rename`) on every update.

```jsonc
{
  "id": "c1f6…",              // crypto.randomUUID()
  "title": "api-server · Tests & push",
  "titleLocked": false,        // true after a manual rename
  "cwd": "/Users/me/code/api-server",
  "project": "api-server",
  "branch": "fix/billing",     // null outside a git repo
  "pinned": false,
  "commands": 12,              // echo-verified commands ever run
  "recent": ["make test", "git push"],   // last 30 recorded command lines
  "createdAt": 1792931999280,
  "updatedAt": 1792935512004   // last Enter keypress / resume / exit; drives sidebar grouping
}
```

### 3.2 `sessions/<id>.log`

Raw PTY output bytes, including TermHub's own markers. `append()` buffers chunks per session in
memory; `flush()` runs every **400 ms**, appends each buffer with `appendFileSync`, and if the file
exceeds **4 MB** rewrites it to its newest **~3 MB**, starting at a newline. `readLog()` flushes first,
so a history read is always current.

### 3.3 `settings.json`

| Key | Default | Meaning |
|---|---|---|
| `theme` | `harbor` | `harbor` (shown as *Graphite*), `paper`, `dark`, `system` |
| `lightTheme` | `harbor` | Light theme used by `system` and the dark-mode toggle |
| `terminalColors` | *(unset = `mac`)* | `mac` = Terminal.app Basic palette on white (light themes only; Dark always uses the dark palette); `theme` = theme palette |
| `fontFamily` | `"SF Mono", Menlo, Monaco, monospace` | |
| `fontSize` | `13` | 8–32, changed with ⌘= / ⌘- / ⌘0 |
| `optionIsMeta` | `true` | Option sends Meta (Esc-prefix) |
| `cursorBlink` | `true` | |
| `restoreOnLaunch` | `true` | Respawn `lastLive` sessions at startup |
| `lastLive` | `[]` | Ids running at last quit; cleared after being read |
| `styledPrompt` | *(unset = on)* | `false` disables the zsh integration (Settings checkbox; applies to new sessions) |
| `gpuRendering` | *(unset = off)* | Use xterm's WebGL renderer (≤ 10 contexts) |
| `window`, `sidebarWidth`, `sidebarHidden` | — | Layout state |
| `harborIntroduced` | — | One-time migration marker |

Migrations on load: `light → paper`, `aubergine → harbor` (theme and lightTheme), and a one-time switch
marked by `harborIntroduced` that sets `lightTheme = harbor` and `theme = harbor` unless the theme is
`dark` (this is also where `lightTheme`'s default comes from).

## 4. Renderer

### 4.1 State

```js
state = { sessions, live: Set<id>, activeId, settings, home, shell, query, renamingId, unread: Set<id> }
views = Map<id, View>      // one xterm instance per *open* session
orphans = Map<id, chunk[]> // output that arrived before its view existed (≤ 200 chunks)

View = { id, el, term, fit, search, webgl, loading, queue: chunk[], quietUntil }
```

### 4.2 View lifecycle

- **makeView(id)** — creates `Terminal` with `termOptions()`, loads Fit, Search and WebLinks addons
  (WebLinks opens only on ⌘-click), optionally WebGL, wires `onData → pty:write`,
  `onResize → pty:resize`, and the context menu. All views stay mounted with `visibility: hidden`
  so background terminals keep correct dimensions.
- **ensureView(id)** — `makeView` + `loadHistoryInto`.
- **select(id)** — clears the session's unread flag, ensures a view, shows it, and **disposes the
  previously selected view if that session is not live** (ended sessions are cheap to rebuild from disk).
- **createNew(opts)** — `session:create` with the current terminal size, then drains any `orphans`.

### 4.3 History replay

```
view.loading = true            // live output arriving meanwhile is queued
log = await session:history(id)
term.write(log.replace(PROMPT_SP, ''))    // drop zsh's '%' partial-line markers (they wrap at new widths)
if log ends inside the alternate screen: write ESC[?1049l + CRLF
write ESC[?1000l ESC[?1002l ESC[?1003l ESC[?1006l ESC[?2004l ESC[0m ESC[?25h
view.loading = false; flush queue
```

The reset sequence turns off mouse reporting and bracketed paste and restores attributes and the
cursor, so an old vim or Claude Code session can't leave the view in a broken mode. `?1049l` is sent
only when needed, because it also restores a saved cursor position.

### 4.4 Sidebar

- Grouping by `updatedAt`: Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, Older; newest
  first within each group.
- Filter (`⌥⌘F`): substring match on title, folder, and every entry in `recent`.
- Each row: project badge (letter + hue hashed from the project name; live dot), title, branch or
  path, relative time, unread dot, and a ⋯ button that opens a native context menu.
- Re-rendered on every `sessions:changed` broadcast and once a minute (relative times).

### 4.5 Unread tracking

`markUnread(id)` runs on `pty:data` / `pty:exit` for a session that is not active. It is ignored while
the view is replaying history and during a **quiet window** after the view was created or resumed
(2.5 s) or resized (1 s), because shells redraw their prompt then. The count is mirrored to the Dock
badge; selecting a session clears it.

### 4.6 Keyboard

A capture-phase `keydown` listener on `window` handles app shortcuts by **physical key**
(`KeyboardEvent.code`), so they work on any keyboard layout and never reach xterm:

| Keys | Action |
|---|---|
| `⇧⌘F`, `⌃⌘F` | Focus mode |
| `⇧⌘←` `⇧⌘[` / `⇧⌘→` `⇧⌘]` | Previous / next session (wraps) |
| `⌃Tab` / `⌃⇧Tab` | Next / previous session |

`⌘1`–`⌘8` select the n-th visible session and `⌘9` the last. Inside xterm, a custom key handler
maps `⌘←/→` to `^A`/`^E`, `⌘⌫` to `^U`, (when `optionIsMeta` is on) `⌥←/→` to `ESC b`/`ESC f` and
`⌥⌫` to `^W`, and `⇧↩` to `ESC CR`,
and lets every other `⌘` combination fall through to the menu.

**Focus mode** remembers whether the sidebar was hidden, hides it without persisting, and requests
full screen. Leaving full screen by any means (green button, Esc) restores the sidebar.

### 4.7 Themes

- UI: CSS custom properties per `[data-theme]` (`harbor`, `paper`, `dark`), with separate
  `--sb-*` tokens for the sidebar so frame and card can differ.
- Terminal palettes: `mac` (Terminal.app Basic; used by light themes when `terminalColors` is `mac`),
  `ivory` (Graphite), `paper`, `dark` (always used by the Dark theme).
  `minimumContrastRatio` is 4.5 for the soft palettes and 1 for `mac`/`dark` (colors shown exactly).
- Text renders through xterm's DOM renderer (native macOS anti-aliasing), `lineHeight: 1`,
  `fontWeightBold: 'bold'`.

## 5. IPC contract

### Renderer → main (request/response, `ipcRenderer.invoke`)

| Channel | Args | Returns |
|---|---|---|
| `state:init` | — | `{ sessions, live, settings, home, shell, user, host, fullscreen }` |
| `session:create` | `{ cwd?, cols?, rows? }` | session record |
| `session:resume` | `id, cols, rows, restored` | session record |
| `session:history` | `id` | log contents (string) |
| `session:rename` | `id, title` | — (empty title resets to `New terminal` and unlocks auto-titling, applied on the next Enter or folder change) |
| `session:pin` | `id, pinned` | — |
| `session:delete` | `id` | — (after a native confirmation) |
| `session:kill` | `id` | — |
| `settings:update` | `patch` | full settings |

### Renderer → main (fire and forget, `ipcRenderer.send`)

| Channel | Args |
|---|---|
| `pty:write` | `id, data` |
| `pty:resize` | `id, cols, rows` |
| `menu:session` | `id` |
| `menu:terminal` | `hasSelection` |
| `win:fullscreen` | `on` |
| `app:badge` | `count` |

### Main → renderer (events)

| Channel | Args | Meaning |
|---|---|---|
| `pty:data` | `id, data` | Output (and resume/restore markers) |
| `pty:exit` | `id, banner` | Shell ended; session kept |
| `pty:removed` | `id` | Session deleted or discarded |
| `sessions:changed` | `sessions, liveIds` | Index changed |
| `ui:action` | `name` | Menu command (`new`, `close`, `resume`, `find`, `focus`, `prev`, `next`, …) |
| `ui:rename` / `ui:resume` / `ui:new` | `id` / `id` / `{ cwd }` | Context-menu actions |
| `ui:fullscreen` | `on` | Window entered or left full screen |

## 6. Shell integration (zsh)

zsh reads its startup files from `$ZDOTDIR`. TermHub points `ZDOTDIR` at its own folder; each file
temporarily switches back to the user's folder to source the real file:

```
.zshenv    remember TermHub dir; ZDOTDIR=user; source user .zshenv; ZDOTDIR=TermHub
.zprofile  ZDOTDIR=user; source user .zprofile; ZDOTDIR=TermHub
.zshrc     fix HISTFILE*; ZDOTDIR=user; source user .zshrc; ZDOTDIR=TermHub
           if TERMHUB_PROMPT=1 and PROMPT is still macOS's default '%n@%m %1~ %# ' (or empty):
             PROMPT='%B%F{green}%1~%f%b${vcs_info_msg_0_} %(?.%F{cyan}.%F{red})›%f '
.zlogin    ZDOTDIR=user; source user .zlogin; restore or unset ZDOTDIR;
           unset TERMHUB_ZDOTDIR TERMHUB_USER_ZDOTDIR TERMHUB_PROMPT
```

\* macOS's `/etc/zshrc` sets `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` *before* the user's `.zshrc`
runs; without the fix, TermHub shells would write a separate history file. After startup, `HISTFILE`,
`PATH` and `ZDOTDIR` are identical to a Terminal.app shell.

## 7. Build and packaging

- `npm install` runs `electron-rebuild -f -w node-pty` (postinstall) to compile the PTY addon for Electron's ABI.
- `npm run dist` → `electron-builder --mac --dir` → `dist/mac-arm64/TermHub.app`, using `build/icon.icns`.
- `npm run release` → DMG + ZIP for `arm64` and `x64`. electron-builder's own signing is disabled
  (`mac.identity: null`); the `afterPack` hook `scripts/adhoc-sign.js` ad-hoc signs each `.app`
  (`codesign --force --deep --sign -`) and verifies it with `--strict` before the DMG/ZIP are made, so
  downloads open with Gatekeeper's "unverified developer" prompt instead of "damaged". The x64 build
  compiles `node-pty` with node-gyp, which needs a Python that still has `distutils` (≤ 3.11).
- `.github/workflows/release.yml` runs on `release: published` (or manually with a tag): Python 3.11,
  Node 22, `npm ci`, version taken from the tag, `npm run release`, signature check, then
  `gh release upload` of the four files.
- `npm run icon` re-renders `build/icon.png` from `build/icon.html` with an offscreen Electron window,
  then builds `build/icon.icns` from it with `sips` + `iconutil`.

## 8. Testing approach

There is no automated test suite yet. Changes are verified by:

1. Running an isolated instance: `TERMHUB_USER_DATA=/tmp/termhub-test npm start -- --remote-debugging-port=9333`.
2. Driving it over the Chrome DevTools Protocol (typing via `window.termhub.write`, key events via
   `Input.dispatchKeyEvent`, screenshots via `Page.captureScreenshot`) — this is also how the README
   GIF is recorded.
3. Pure functions (title rules, escape parser) are checked with small Node scripts.

## 9. Constants

| Constant | Value | Where |
|---|---|---|
| Log flush interval | 400 ms | `store.js` |
| Log cap / trim target | 4 MB / 3 MB | `store.js` |
| Echo verification window | 250 ms (buffer ≤ 4 KB) | `main.js` |
| cwd refresh after a command / resume | 400 ms / 300 ms | `main.js` |
| Recent commands kept | 30 | `main.js` |
| Title length | 40 chars | `main.js` |
| Output tail for tracking | 4 KB | `main.js` |
| Unread quiet window | 2.5 s (create/resume), 1 s (resize) | `renderer.js` |
| Orphaned output chunks | 200 per session | `renderer.js` |
| Max WebGL views | 10 | `renderer.js` |
| Scrollback | 10 000 lines | `renderer.js` |
