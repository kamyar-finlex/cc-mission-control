# Changelog

All notable changes to CC Mission Control. Versions follow [Semantic Versioning](https://semver.org); while the version is 0.x, a minor version can include breaking changes, and they are listed under **Upgrading**.

## 0.3.0 — 2026-10-30

### Upgrading from 0.2.0

1. **Install the new version.** If you installed from GitHub: `npm install -g github:kamyar-finlex/cc-mission-control#v0.3.0`. If your global command links to a clone, run `git pull` in the clone instead.
2. **Run `cc-mission-control setup` again** to restart the always-on service on the new code. Open tabs reload onto the new page by themselves.
3. **"new replies" may count fewer sessions.** That's because of quiet runs (below). To count them again, set **Quiet runs** to "count as new".

### Added

- **Notice cards.** Notices that Claude Code or the Claude app put into a session now show as cards in the session drawer, instead of raw `<task-notification>…` tags in a user bubble:
  - a finished background task, with ✓ / ✗ and its exit code;
  - a scheduled run, with its instructions folded;
  - slash commands and shell commands (`$ cmd` with its output);
  - pasted text, as a folded quote in your bubble;
  - other app events.

  A message made only of notices gets a row of its own. Tags that a message merely mentions stay as text. ([#12](https://github.com/kamyar-finlex/cc-mission-control/pull/12))
- **Scheduled runs, grouped.** In each column, the runs of one scheduled task, and of its numbered copies such as `nightly-report-2`, share one group:
  - a header with the run and slot counts;
  - the newest run's card;
  - the earlier runs folded as rows that open the run.

  A working run, or one that asks you something, keeps its own card. ([#13](https://github.com/kamyar-finlex/cc-mission-control/pull/13))
- **Quiet runs.** A scheduled run that says it had nothing to do ("skipped", "no changes", "nothing new", "all clear") gets no NEW badge or notification, isn't counted as a new reply, and moves to Ended after 30 minutes.
  - A run that mentions a failure, names something it did, or has a PR, ticket or open question attached is never quiet.
  - The new **Quiet runs** menu picks the behaviour: to Ended after 30 min, to Ended at once, stay in Waiting, or count as new.

  The wording rules are listed in the README's assumptions table. ([#14](https://github.com/kamyar-finlex/cc-mission-control/pull/14))

### Changed

- **Board titles.** A session started by a notice is titled with a plain line, such as "Scheduled run: nightly-report", instead of raw markup. ([#12](https://github.com/kamyar-finlex/cc-mission-control/pull/12))

## 0.2.0 — 2026-10-30

### Upgrading from 0.1.0

1. **Install the new version.** If you installed from GitHub: `npm install -g github:kamyar-finlex/cc-mission-control#v0.2.0`. If your global command links to a clone, run `git pull` in the clone instead.
2. **Run `cc-mission-control setup` again.** It restarts the always-on service on the new code with its new restart rule and log trimming, and updates the `/project-updates` skill (your previous copy is kept as `SKILL.md.bak`).
3. **Sign in each browser once with `cc-mission-control open`.** The page no longer carries its access token. A browser that hasn't signed in sees a short page telling it to run that command; tabs left open from 0.1.0 reload onto that page by themselves.
- Scripts that call the console directly (the `/project-updates` skill does) send the token from `~/.claude/cc-mission-control/token` in an `X-Console-Token` header.

### Security

- **Sign-in.** Browsers sign in through a one-time link from `cc-mission-control open`, which becomes an `HttpOnly`, `SameSite=Strict` cookie. Every data route needs it: the live board, transcripts, the digest, images and attachments. Actions also need a header only the console's own page sends, and a local `Origin`. ([#2](https://github.com/kamyar-finlex/cc-mission-control/pull/2))
- **Page protections.** The page runs under a strict Content-Security-Policy (`script-src 'self'`), and every response sends `nosniff`, `no-referrer` and `X-Frame-Options: DENY`. Transcript images are served only as PNG, JPEG, GIF or WebP. (#2, [#5](https://github.com/kamyar-finlex/cc-mission-control/pull/5))
- **Agent launches.**
  - Agents started from the console can't skip permission prompts: `bypassPermissions` and `dontAsk` are refused.
  - Your text is always passed to `claude` after `--`, so it can't be read as an option.
  - Ids passed to Terminal commands are quoted. (#2)
- **Crash fixes.** A malformed request no longer crashes the server, and actions without their session are refused instead of crashing. (#2)
- **Owner-only data.** The data folder is owner-only, and the speech cache moved into it from the shared temp folder. ([#10](https://github.com/kamyar-finlex/cc-mission-control/pull/10))
- **Password managers.** *Send to agent* never saves or restores a clipboard a password manager has marked concealed or transient. (#10)

### Performance

Measured on a machine with about 2,450 sessions and 3.5 GB of transcripts ([#6](https://github.com/kamyar-finlex/cc-mission-control/pull/6)):

- **Memory:** about 1.6 GB down to 0.37 GB; the startup peak fell from 3.9 GB. The Claude app's 2,567 session-metadata files (1.2 GB) are now read 8 at a time instead of all at once, and only changed ones are re-read (the folder is watched).
- **Page traffic:** 42–77 MB a minute down to about 25 KB. Pages get the board once, then only the sessions that changed.
- **CPU while idle:** about halved. A finished session's card is reused until something it is built from changes. `CCMC_VERIFY_CACHE=1` double-checks that.

### Added

- **`cc-mission-control open`**, which opens the dashboard signed in; `--help` and `--version`; `--port=N`. Unknown options and invalid ports are errors. (#2)
- **A real `uninstall`.** It removes what `setup` added: the service, the status line and the skill (only while they're unchanged), the log and the speech cache. `uninstall --purge` also deletes saved data. ([#8](https://github.com/kamyar-finlex/cc-mission-control/pull/8))
- **The talking avatar** (optional): reads a session's replies aloud, with local Kokoro speech and a pre-built mouth bank. `avatar/requirements.txt` lists its Python packages. ([#1](https://github.com/kamyar-finlex/cc-mission-control/pull/1), #8)
- **Keyboard access.**
  - Cards and tree sessions open on Enter or Space.
  - The "why" line and project tabs are focusable.
  - The menu works with arrow keys, Home and End.
  - The menu and the quick reply give focus back to what opened them.
  - Focus survives live updates. ([#9](https://github.com/kamyar-finlex/cc-mission-control/pull/9))
- **Spoken status** for status dots, PR chips and the live indicator; toasts are announced. (#9)
- **Tests and CI:** 61 `node:test` tests, and a GitHub Actions workflow on Node 20, 22 and 24. (#2 and later)

### Changed

- **Code layout.** The server is split into modules under `src/`, and the page into `public/app.css` and native ES modules under `public/js/`, still with no build step. Neither split changes behaviour: old and new outputs were compared on real data. ([#4](https://github.com/kamyar-finlex/cc-mission-control/pull/4), #5)
- **Restarts.**
  - The always-on service restarts only after a crash. When its port is taken, it stops instead of retrying (and logging) every 5 seconds, and `setup` says which program holds the port.
  - Its log is trimmed to the last 1 MB once it passes 5 MB. (#8)
  - `setup` waits for the old service to stop before starting the new one. ([#3](https://github.com/kamyar-finlex/cc-mission-control/pull/3))
- **`setup` and settings.json.**
  - `setup` never rewrites a `settings.json` it can't parse.
  - It writes the file atomically and keeps your original backup.
  - It points its own status line at a new Node.js after an upgrade. (#2, #8)
- **Saved data files** are written atomically. A damaged file is set aside and logged, never silently replaced. (#2)
- **The `/project-updates` skill.**
  - It checks what was already posted, so running it twice doesn't post twice.
  - It repeats back a partial selection before posting.
  - It honours `CCMC_PORT`. (#8, #10)
- **Clipboard.** After a successful *Send to agent*, the whole clipboard comes back (images and files too), unless you copied something new in the meantime. (#10)

### Fixed

- **The "yesterday" digest** dropped sessions that also worked today. ([#7](https://github.com/kamyar-finlex/cc-mission-control/pull/7))
- **Ticket detection.** Names of standards such as `SHA-256` or `UTF-8` became tickets when a team's key matched. They now need real evidence in the session: the branch, a Linear tool call or a link. (#7)
- **"Waiting on X"** wasn't shown as blocked. (#7)
- **`setup`** failed with "Bootstrap failed: 5" when restarting the service. (#3)
- **Keyboard users** couldn't reach the quick reply: Enter on a card's Reply button opened the session instead. (#9)
- **The live transcript view.**
  - A session that was empty when opened never updated.
  - A transcript rewritten while open was shown twice.
  - A line still being written when the session opened was lost.
  - Text split inside a multi-byte character was garbled. (#10)
- **The voice worker.** Its errors were discarded, and it said "ready" before loading the model, so the first request could time out. (#10)
- **The page.**
  - An out-of-range character entity in a transcript blanked the rest of it.
  - Shortcuts fired while a dialog was open.
  - Escape in a dialog also closed the session drawer. (#2)

## 0.1.0

The first version: a live board of every local Claude Code session, with each session's story, open items, Linear tickets, pull requests and deployments; actions in the Claude app, Terminal and background agents; project updates; a usage toolbar; and an always-on macOS service.
