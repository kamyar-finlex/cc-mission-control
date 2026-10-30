# CC Mission Control

**One live dashboard for every Claude Code session on your machine.**

When you run several Claude Code sessions at once (in the Claude desktop app, in terminals, as background agents), it gets hard to keep track of them. Which ones are working? Which are waiting for you, and why? Which can be archived? CC Mission Control puts them all on one board at `http://localhost:7777`, updated live, with each session's story, open work, tickets and pull requests one click away.

> **Unofficial.** CC Mission Control is a community project. It is not made by, endorsed by or affiliated with Anthropic. It reads files that Claude Code and the Claude desktop app keep on your machine; those formats are internal and can change with any update, so parts of the dashboard may stop working until it is updated.

## Setup on a new Mac

**You need:**
- a Mac
- a Claude plan that includes Claude Code
- Node.js 18 or newer

About 5 minutes.

1. **Install Claude Code and use it once.** Install the [Claude desktop app](https://claude.ai/download), sign in, and start a session in its **Code** tab. You can use the terminal `claude` CLI as well or instead. The dashboard only shows sessions that Claude Code has run on this Mac, so it starts empty on a new machine.
2. **Install Node.js** from [nodejs.org](https://nodejs.org), or run `brew install node`. Check it with:
   ```bash
   node -v
   ```
3. **Install CC Mission Control** from GitHub:
   ```bash
   npm install -g github:kamyar-finlex/cc-mission-control
   ```
   Or from a clone:
   ```bash
   git clone https://github.com/kamyar-finlex/cc-mission-control.git
   cd cc-mission-control
   npm install -g .
   ```
4. **Run setup:**
   ```bash
   cc-mission-control setup
   ```
   It does four things. Each is safe to run again:
   - **Always-on service (macOS):** the dashboard starts at login and restarts if it stops. Add `--no-service` to skip it.
   - **Status line:** lets terminal `claude` sessions report your plan limits. It's added to `~/.claude/settings.json` (backed up first, written in one step) only if you have no status line yet. A status line of your own is never touched, and a `settings.json` that isn't valid JSON is left exactly as it is. Running setup again after a Node.js upgrade points it at the new Node.js.
   - **The `project-updates` skill:** copied to `~/.claude/skills/`. Running setup again updates it; the previous copy is kept as `SKILL.md.bak`.
   - **Usage task:** it prints a message to paste into a Claude app session (step 6).
5. **Open it:**
   ```bash
   cc-mission-control open
   ```
   This opens http://localhost:7777 with a one-time link that signs your browser in (see [Security](#security)); the browser stays signed in after that. If you skipped the service, start the dashboard yourself with `cc-mission-control`, which also opens it signed in. Press Ctrl+C to stop it.
6. **Optional extras**, whenever you want them:

| To get | Do this once |
|---|---|
| Plan limits in the bottom bar, from the Claude app | Paste the message `setup` printed into any Claude Code session in the Claude app. It creates a scheduled task that refreshes the numbers every 30 minutes while the app is open. Print it again with `cc-mission-control usage-task`. |
| PR states on cards | Install the [GitHub CLI](https://cli.github.com) and run `gh auth login` |
| Ticket and project data, and *Project updates* | Connect **Linear** to Claude (Claude app → Settings → Connectors), then use it in your sessions |
| *Write with Claude*, *Check with Claude*, background agents | Run `claude` once in a terminal and log in |
| *Send to agent* (type replies into the Claude app for you) | Turn it on in the dashboard. It guides you through the macOS Accessibility permission. |
| Desktop notifications | Click **Notify** in the dashboard and allow notifications in your browser |

To install a specific release, add its tag: `npm install -g github:kamyar-finlex/cc-mission-control#v0.3.0`. What changed in each release, and what to do when upgrading, is in [CHANGELOG.md](CHANGELOG.md).

Once the package is published to npm, `npm install -g cc-mission-control` and `npx cc-mission-control` work too.

### What to expect on first run

- **An empty board** until Claude Code has sessions. New sessions appear within a second.
- **"No usage reading yet"** in the bottom bar until the usage task has run once, or a terminal `claude` session has drawn its status line.
- **Permission prompts:**
  - your browser asks before showing notifications (only if you turn them on)
  - the first time you use *Send to agent*, macOS asks whether **node** may control **System Events**: choose **Allow**

## What you get

**The board**
- Three live columns: **Working**, **Waiting for you** and **Ended**. They update about once a second.
- Time filters: Today, Last two days, Last three days, This week, This month, All. Keys `1`–`6` pick them.
- A **NEW** badge on sessions that replied since you last looked. The browser tab title shows how many there are.
- Search across titles, folders, branches, tickets and messages. `/` focuses it.
- Optional desktop notifications when a session finishes and is waiting for you.
- **Scheduled runs**, grouped: the runs of each scheduled task (and its numbered copies, like `nightly-report-2`) share one card per column, with the earlier runs folded under it. A working run, or one that asks you something, keeps its own card.
- **Quiet runs**: a scheduled run that says it had nothing to do ("skipped", "no changes", "nothing new", "all clear") gets no NEW badge or notification and moves to Ended after 30 minutes. Pick another behaviour in the **Quiet runs** menu, or turn it off. A run that mentions a failure, touches a PR or ticket, or asks you something is never quiet.

**On every card**
- Status, project folder, branch or worktree, model and context size.
- **Why it's still alive**: one coloured line, in the session's own voice, saying why it's waiting:
  - *Waiting for your answer: "Open the PR?"*
  - *Blocked: …*
  - *Not shipped yet: …*
  - *TICKET-123 is still In Progress. Don't archive me.*
  - *Nothing open that I can see. Safe to archive.*
- A **?** that opens the full picture:
  - the session's open question, with its own suggested replies as one-click buttons
  - everything still open (unfinished work, unanswered points, tickets not done, PRs needing review)
  - general nudges such as "Carry on with what is open"
- The latest **Linear ticket** with its status, and *+N ▾* for the others. Ticket facts are learned from Linear MCP replies already in your transcripts; the dashboard never calls Linear.
- Open **pull requests** with review and check state (or the most recently merged one), and *+N ▾* for the rest. This uses read-only `gh` lookups.
- The **Linear project** as a small tab under the card. Click it to filter the board to that project.
- Sessions started from another session appear as a **tree** under their parent.

**Session detail** (click a card)
- The live transcript as a chat:
  - your messages as bubbles, with any images you sent
  - Claude's replies rendered as Markdown; HTML in a message (such as a GitHub or Linear bot comment, often entity-escaped) is shown as formatted text, not tags
  - the tool calls between messages folded into one *N steps* row (with icons, results, and any screenshots kept visible)
  - click any image to see it full size
- Linear and PR panels, each collapsible.
- `f` maximizes the panel and `d` collapses the details.
- An optional **talking avatar** that reads the session's replies aloud (see below).

**Talking avatar** (optional, off until you build one)
- A face above the transcript with **Voice: on/off**, **▶ Read last reply** and **■ Stop**. With Voice on, each new reply in the open session is read aloud as it arrives. Code blocks, tables and URLs are skipped, and long replies stop after about 900 characters.
- Live, all on your machine: speech comes from [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), kept loaded by `avatar/tts_worker.py`. The face is a *mouth bank* built once, offline: a head-motion loop plus, for every loop frame, mouths from several lip-synced passes. While speech plays, each frame shows the mouth whose opening matches the voice's loudness at that moment, so nothing is rendered live.
- Python packages for the voice and the bank: `avatar/requirements.txt` (minimum versions; install into a virtual environment and point `CCMC_KOKORO_PYTHON` at it).
- Building a bank (Apple Silicon works; each step's script explains itself):
  1. a head-motion loop of the face with a closed mouth, e.g. a still portrait animated with [LivePortrait](https://github.com/KwaiVGI/LivePortrait), head pose and blinks only;
  2. `avatar/bank_speech.py`: six speech tracks as long as the loop, in the avatar's Kokoro voice;
  3. [MuseTalk](https://github.com/TMElyralab/MuseTalk) 1.5 over the loop, once per track;
  4. `avatar/bank_build.py`: the loop frames, a mouth sprite sheet per pass and `manifest.json`, into `CCMC_AVATAR_DIR`.
- Label the face honestly: the bank's `label` is shown under it. Use a fictional face, or your own with your consent, never someone else's.

**Deployments** (in the detail panel)
- Which repositories the session is shipping, at which version, and how far each got: *Waiting at the production gate*, *On beta*, *Tagged, not on beta yet*, *Ready, not tagged yet* or *In production*. The ones not yet in production come first.
- Read from the session's turn recaps, so a line like "web-app 1.8.25 is on beta" or "Production for api-server 2.4.0 still waits at the gate" becomes a row. A bare version such as "2.4.1" belongs to the repository last named with that major.minor. Hover a row to see the sentence it came from.
- **🚀 Deploy** on a row that isn't in production asks *Are you sure?*, showing the version, its current stage and what will happen. Confirming sends that session's agent a request to deploy it. The request tells it to check the risks first, report them along with the exact steps it will take, and wait for your explicit "yes, deploy". The dashboard never deploys anything itself.

**Actions** (right-click a card, or use ⋯ in the detail panel)
- **Open in Claude app**: jumps straight to that exact session in the Claude desktop app.
- **Attach in Terminal** or **Stop**, for background agents.
- **Resume in Terminal** or **Continue in background**, for sessions that have ended.
- **Archive** or **Unarchive**. Background agents are stopped and removed. Other sessions are hidden from the board (the Claude app has no outside way to archive). Sessions you archive in the app disappear on their own.
- **Show story** (`s`): the whole session in one paragraph, with **Copy** and **Write with Claude**.
- **Reply** (`r`, the ✎ button on a card, or the editor at the bottom of the detail panel): a Markdown editor with a toolbar, Write/Preview tabs, ⌘↩ to send, and drafts kept per session. **Paste, drop or 📎-attach images**: they're saved under `~/.claude/cc-mission-control/attachments/` and sent as file paths Claude can open (and attached to new Claude app sessions). How the reply is delivered:
  - **Ended terminal sessions:** sent for real, continuing the session in the background.
  - **Claude app sessions:** copied, and the exact session opens in the app, so you paste and press Enter. The app has no outside input.
  - **Claude app sessions with *Send to agent: on*** (opt-in, macOS): the console opens the session, waits until the app reports that exact session focused with Claude in front, then pastes and presses Enter the way you would. It confirms success only when the reply shows up in the session's transcript (as a message, or queued if the session is busy). Otherwise it says so and leaves the reply on your clipboard. The Claude app doesn't let outside processes read its message box, so the console can't check the box before typing. Use it only while you're at the keyboard, and don't click elsewhere during the second it takes. It needs Accessibility permission for the `node` that runs the dashboard.
  - **Running agents:** copied, then attached in Terminal.
- **+ New session** (`n`): write a prompt in Markdown, pick a folder, and *Open in Claude app* opens a new app session with the prompt already typed in. You can also run it as a `claude --bg` background agent.

**Project updates** (📝 in the header)
- Pick Today, Yesterday or This week to see which Linear projects had work and which sessions belong to each. Sessions without a project are left out.
- *Write updates in Claude app* opens a new Claude app session with `/project-updates` typed in. The bundled skill reads the dashboard's `GET /api/digest?range=today` and checks each session really belongs to its project. It writes one short, non-technical update per project with no code, links, names or secrets, and suggests a health. Then it **shows you all drafts and posts nothing until you say yes**. After your yes it posts them as Linear project updates.
- `cc-mission-control setup` installs the skill. Or copy `skills/project-updates/` to `~/.claude/skills/` yourself.

**Usage toolbar**
Your plan limits, like the Claude app's usage card: the current 5-hour session and the weekly limits per model, each with its reset time, plus a **Refresh** button.

## How it works

Everything runs on your machine. The server is a single dependency-free Node file.

| Reads | For |
|---|---|
| `~/.claude/sessions/*.json` | Which sessions are running, busy or idle (Claude Code's live registry) |
| `~/.claude/projects/**/*.jsonl` | Transcripts: messages, tool calls, turn recaps, ticket and PR mentions |
| `~/Library/Application Support/Claude/claude-code-sessions/**` | Claude desktop app sessions: their app id, archived flag and parent session (read-only, macOS) |

It writes only to `~/.claude/cc-mission-control/` (owner-only; the optional avatar keeps its cached speech there too, in `tts/`, pruned to the last 7 days and 500 files): its token, the archive list, saved stories and open-item checks, usage readings and images you paste into replies. `setup` also writes the `statusLine` entry in `~/.claude/settings.json` (keeping a backup next to it, `settings.json.bak-cc-mission-control`), the skill in `~/.claude/skills/`, and (macOS) its LaunchAgent, which logs to `~/Library/Logs/cc-mission-control.log`. The log is trimmed to its last 1 MB whenever it passes 5 MB.

It reaches outside your machine only when you have set that up:
- `gh api graphql`, to read PR states
- `claude -p`, when you click *Write with Claude* or *Check with Claude*

## Security

- The server listens on `127.0.0.1` only. It refuses requests with any other `Host` header, which blocks DNS rebinding.
- Everything except a short sign-in page needs a token. Browsers get it once, from the link `cc-mission-control open` opens, as an `HttpOnly`, `SameSite=Strict` cookie, so the token never appears in the page and other local programs can't read it from there. Scripts (such as the `project-updates` skill) send it in an `X-Console-Token` header, read from `~/.claude/cc-mission-control/token`, which only you can read.
- Actions also need a header that only the console's own page sends (and, when the browser sends one, a local `Origin`), so other websites can't trigger anything.
- The page runs under a strict Content-Security-Policy (only its own script, by nonce), and every response carries `X-Content-Type-Options: nosniff`. Transcript images are served only as PNG, JPEG, GIF or WebP.
- Agents started from the console can't skip permission prompts: `bypassPermissions` and `dontAsk` are refused, and your text is always passed to `claude` after `--`, so it is never read as an option.
- It can start agents and shows every transcript on your machine. **Never expose it on a network.**

## Platform support

- **macOS:** everything.
- **Linux:** the board, transcripts, tickets, PRs, background agents and stories work. Claude desktop app features, Terminal attach and the always-on service don't.
- **Windows:** untested.

## Assumptions and where to change them

CC Mission Control reads plain text from your sessions, so some of its behaviour rests on assumptions. If your team works differently, here's where to adjust each one.

| Assumption | What it affects | Where to change it |
|---|---|---|
| **Tickets live in Linear.** Ticket ids look like `ABC-123`, and ticket facts come from Linear MCP replies already in your transcripts. | Ticket chips, project tabs, the project grouping in *Project updates* | `src/linear.mjs`: `ISSUE_ID`, `LINEAR_TOOL`, `learn()`, `linearFor()` |
| **Pull requests live on GitHub**, read with the `gh` CLI. | PR chips and states | `src/linear.mjs`: `PR_URL`; `src/prs.mjs`: `prTick()` |
| **Releases go through beta (or staging), then a production gate.** The stages are recognised from English wording such as "on beta", "waits at the production gate" or "live in production". | The *Deployments* box | `src/story.mjs`: `deployStage()`, `DEPLOY_LABEL` |
| **Unfinished work is spotted from English phrases** such as "blocked", "not yet", "still to do" or "waiting on". | The *why it's still alive* line and *Still open* lists | `src/story.mjs`: `OPEN_CUE`, `aliveReason()` |
| **A scheduled run with nothing to do says so in English**, such as "skipped", "nothing to process", "no changes", "all clear"; and a failure mentions words like "failed", "error", "limit" or "can't". | Which runs are quiet (no NEW badge, moved to Ended) | `public/js/schedules.js`: `NOTHING_TO_DO`, `SOMETHING_WRONG`, `isQuietRun()` |
| **Deploys are done by the session's agent**, which is asked to report risks and wait for your yes. | The 🚀 *Deploy* request text | `public/js/deploy.js`: `deployPrompt` |
| **Nudge replies are general English sentences.** | *Carry on with what is open* and *What is left, and who owns it?* | `public/js/why.js`: `GENERIC_REPLIES` |
| **The Claude desktop app's internals:** its `claude://claude.ai/epitaxy/…` links, its session metadata under `~/Library/Application Support/Claude`, its scheduled tasks and its `get_usage` tool. None of these are a public API. | Opening sessions in the app, the session tree, archived flags, usage limits | `src/config.mjs`: `APP_DIR`, `USAGE_TASK_ID`; `src/app-meta.mjs`: `scanAppMeta()` |
| **Project updates are posted to Linear** with the Linear MCP `save_status_update` tool, in a short Progress / Next / Needs-attention shape. | The `project-updates` skill | `skills/project-updates/SKILL.md` |

## Options

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `7777` | Port to listen on (or `--port`) |
| `CLAUDE_BIN` | `claude` | The Claude Code CLI to call |
| `RECENT_HOURS` | start of this month or week | How far back ended sessions are shown |
| `CCMC_DATA_DIR` | `~/.claude/cc-mission-control` | Where it saves its own data |
| `CCMC_AVATAR_DIR` | `~/.local/share/presenter-film/avatar/clara` | The talking avatar's bank (`manifest.json`, `base/`, `pass*.jpg`); no bank, no avatar |
| `CCMC_KOKORO_PYTHON` | `~/.local/share/presenter-film/venvs/kokoro/bin/python` | A Python with `kokoro` installed, for the avatar's voice |
| `CCMC_VERIFY_CACHE` | off | Debugging: set to `1` to rebuild every cached card each second and log `card cache stale` if one differs |

## Troubleshooting

| You see | Do this |
|---|---|
| `Port 7777 is already in use` | It's already running: run `cc-mission-control open`. Or start it on another port with `--port 7788`. If the always-on service found the port taken, it stopped instead of retrying; once the port is free, run `cc-mission-control setup` to start it again. |
| The page asks you to sign in | Run `cc-mission-control open` (add `--port` if you use another port). Each browser signs in once. |
| The board stays empty | Start a session in the Claude app's Code tab or with `claude`. The dashboard reads `~/.claude/sessions` and `~/.claude/projects`, so it needs Claude Code to have run as the same macOS user. |
| No PR chips | Run `gh auth status`. The dashboard needs a logged-in `gh`. |
| No tickets or projects on cards | Your sessions need to have used the Linear connector. The dashboard learns ticket facts from those replies. |
| *Write/Check with Claude* says the CLI is logged out | Run `claude` in a terminal and log in, then try again. |
| *Send to agent* says it isn't allowed | Enable your `node` under System Settings → Privacy & Security → Accessibility. The setup dialog in the dashboard shows its exact path. |
| *Send to agent* says the reply didn't arrive | The reply stays on your clipboard. Paste it into the app. Keep the Claude window in view and your hands off the keyboard during the second it takes. |
| The page says it's out of date | It reloads itself. Try the action again. |
| The service stopped after a Node.js upgrade | Run `cc-mission-control setup` again. The service pins the Node.js it was installed with (for example, an nvm version you later removed). |

## Uninstall

```bash
cc-mission-control uninstall
npm uninstall -g cc-mission-control
```

`uninstall` removes what `setup` added: the always-on service, its status line entry and the `/project-updates` skill (each only if it is still exactly what `setup` wrote, so a status line or skill you changed stays), its log and its speech cache. Your saved data in `~/.claude/cc-mission-control/` (archive list, stories, token, pasted images) and the settings backup stay; `cc-mission-control uninstall --purge` deletes the saved data too. Delete the usage task from the Claude app's Scheduled page yourself.

## Contributing

Issues and pull requests are welcome. The server starts in `server.mjs` and does its work in `src/`, one module per concern: `transcript` (reading transcripts), `linear`, `prs`, `story` (reading a session without a model), `llm` (what Claude writes about one), `state` (building the board and pushing it to pages), `actions`, `http`, and the macOS pieces `app-meta` and `send-to-app`. The page is `public/index.html` with its style in `public/app.css` and its script in `public/js/` as native ES modules (no build step), loaded by `main.js`; `markdown.js` and `util.js` need no DOM, so tests import them directly. The CLI is `bin/cli.mjs`, with small helpers in `lib/`; `statusline.mjs` feeds plan limits. Please keep it dependency-free, and run `npm run check` and `npm test` before you open a pull request.

## License

MIT. See [LICENSE](LICENSE).
