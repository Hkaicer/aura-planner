# AURA

AURA is a local-first planning app with an AI assistant. You tell it what you need to do in plain language. It turns that into tasks, places them in a realistic schedule around your fixed commitments, and keeps the plan up to date when your day changes.

Everything runs on your own computer: the interface, the API, the scheduler and the SQLite database. It works on Windows, macOS and Linux. The assistant uses the AI account **you** already have:

* your **Claude** plan, through the official Claude Code app
* your **ChatGPT** plan, through Sign in with ChatGPT
* or your own **API key** (Anthropic or DeepSeek)

AURA has no server of its own, no account and no telemetry. Each person who installs it uses their own AI account, and nothing is ever sent to the author of AURA.

## Contents

1. [Quick start](#quick-start)
2. [Choose your AI](#choose-your-ai)
3. [What you can do](#what-you-can-do)
4. [How the assistant works](#how-the-assistant-works)
5. [What is sent to the AI](#what-is-sent-to-the-ai)
6. [Configuration](#configuration)
7. [Data, backups and the database](#data-backups-and-the-database)
8. [Architecture](#architecture)
9. [Tests](#tests)
10. [Keyboard shortcuts](#keyboard-shortcuts)
11. [Limitations](#limitations)
12. [Troubleshooting](#troubleshooting)
13. [License](#license)

## Quick start

Requirements:

* [Node.js](https://nodejs.org) 22.13 or newer (tested with Node 24)
* For the assistant, one of the options in [Choose your AI](#choose-your-ai). Everything else works without it.

Get the code with git:

```bash
git clone https://github.com/Hkaicer/aura-planner.git
```

or download it with **Code → Download ZIP** on GitHub and unzip it.

### Windows

Double-click **`start-aura.bat`**. It checks Node.js, installs dependencies (about a minute the first time), builds the interface, starts the local server in a console window and opens AURA in your browser. Close that console to stop AURA.

To get a Desktop icon and a Start Menu entry that open AURA in its own window, without tabs or a console, run this once from the AURA folder:

```bash
powershell -ExecutionPolicy Bypass -File scripts/install-shortcuts.ps1
```

An icon-started AURA stops by itself about 20 minutes after you close its window. Time the computer spends asleep does not count. Run the same command with `-Remove` to delete the icons.

### macOS

Double-click **`start-aura.command`** in the Finder. A Terminal window opens, prepares AURA the first time and opens it in your browser. Close that window to stop AURA.

The first time, macOS may say the file cannot be opened because it comes from an unidentified developer. Right-click the file, choose **Open**, then **Open** again. If macOS says you do not have permission, open Terminal in the AURA folder and run:

```bash
chmod +x start-aura.sh start-aura.command
```

### Linux

From the AURA folder:

```bash
./start-aura.sh
```

### Manual start

The same result on any system:

```bash
npm install
npm run build
npm start
```

Then open `http://127.0.0.1:4317`. Development mode with live reload (interface on port 5317, API on 4317):

```bash
npm run dev
```

The first time, a short welcome dialog asks for your name, language and usual planning hours. It also offers to keep a set of example tasks so you can explore. The example data is clearly marked and can be removed in one click.

## Choose your AI

Pick one in **Settings → Assistant → AI provider**. You can switch at any time, and AURA never switches on its own.

| Option | What you need | Who pays |
|---|---|---|
| Claude plan (via Claude Code) | [Claude Code](https://code.claude.com) installed and signed in with your Claude account | Counts against your Claude plan's usage |
| ChatGPT plan | A ChatGPT Plus or Pro account | Counts against your ChatGPT plan's usage |
| API key | An Anthropic or DeepSeek API key | Billed per token to that account |
| Off | Nothing | Planning without AI keeps working |

### Claude plan, through Claude Code

1. Install Claude Code from [code.claude.com](https://code.claude.com).
2. In a terminal, run `claude auth login` and sign in with your Claude account (not a Console account).
3. In AURA, open **Settings → Assistant** and click **Check connection**.

AURA does not call the Anthropic API with your subscription and never touches your Claude credentials. It runs the unmodified `claude` command on your computer in non-interactive mode (`claude -p`), the same way you could run it from a terminal. Claude Code handles the sign-in.

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) forbids third-party apps from offering Claude.ai login and from collecting or relaying Claude credentials. It also says it does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". AURA is built to stay on that side: it has no Claude login of its own, each person signs in to their own Claude Code, and requests go from that person's computer under their own plan. This is the author's reading of the page, not legal advice. If you are unsure, use an API key instead.

### ChatGPT plan, through Sign in with ChatGPT

1. In **Settings → Assistant**, click **Continue with ChatGPT** and confirm.
2. Sign in on OpenAI's own page and allow AURA to use your ChatGPT plan.
3. OpenAI sends you back to AURA, which now uses your plan.

OpenAI offers [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) to open-source apps and personal apps that run locally. AURA never sees your password. It receives tokens for its own loopback address, keeps them in `data/secrets.json` on your computer and sends them only to OpenAI. Requests count toward your plan's usage, which you can see and manage at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage). **Sign out** in the same card revokes the sign-in.

OpenAI describes ChatGPT plan usage as a preview. AURA's integration follows OpenAI's documentation and is covered by automated tests against a simulated OpenAI server. If something does not work with your account, please open an issue.

### API key

1. Create a key in the [Claude Console](https://platform.claude.com) (Anthropic) or on [DeepSeek's platform](https://platform.deepseek.com).
2. Paste it in **Settings → Assistant → API key**. AURA recognizes the service from the key and checks it with a free call before saving it.
3. Choose the API key option in **AI provider** and confirm the billing notice.

The key is kept in `data/secrets.json` on your computer only. It never goes into the database, backups, exports, logs or the interface.

* With a Claude key, automatic mode sends simple requests to Haiku, which costs far less, and Haiku can also be picked by hand.
* With a DeepSeek key, simple and ordinary requests use DeepSeek Flash and complex ones DeepSeek V4 Pro. DeepSeek stores requests on its servers in China, and the confirmation dialog says so.

## What you can do

### Plan by talking

Open the assistant (`J` or **Ask AURA**) and write the way you would to a person, for example:

> Tomorrow I have class from 09:00 to 12:00. I need to study for two hours, work on a project for 90 minutes, exercise for one hour and buy groceries for 30 minutes. I want a lunch break and to finish by 20:00.

AURA creates the class as a fixed event, adds the four tasks with their durations, sets the end of your day, and asks the scheduler for a plan. You get a preview with every change and the proposed times, plus anything that does not fit. Nothing is saved until you approve it.

Follow-ups work in the same conversation: "move exercise to 18:00 and make the project my highest priority", "I lost 90 minutes, reorganize the rest of my day", "I'm exhausted, give me a lighter schedule", "find a free 90-minute block this week for exam prep", "what should I do right now?", "move all unfinished tasks to tomorrow but keep their deadlines".

Small, safe changes (one new task, a completion, a rename) apply immediately with an Undo button. Larger changes, anything that reschedules several tasks, and every deletion wait for your approval. You can untick individual changes before applying.

### Today

* Greeting, date and a summary of the day. **Brief me** asks the assistant for a short written overview, cached for the day.
* Completed vs remaining, planned work vs available time, and a clear status: realistic, tight or overloaded (with how much does not fit).
* Three views: a time-blocked **timeline**, an ordered **list** (drag to reorder flexible tasks) and a **priority** view with the transparent priority score of each task.
* On the timeline you can drag a task to a new time, resize it to change its duration, drag flexible tasks onto it, and click a free stretch to add a task there. Commitments, breaks and lunch are shown in place. A red line marks the current time.
* Tasks without a fixed time stay in a flexible list instead of being forced into a slot.
* **Plan my day** runs the local scheduler with no AI at all. You can rebuild the whole day, keep valid times and fill the gaps, shift the rest of the day from now, or plan a lighter day.
* Morning planning and evening review are guided flows.

### Everything else

* **Upcoming**: the next two weeks, day by day, with each day's load against its free time.
* **Inbox**: quick ideas to process later.
* **All tasks**: search, filters, sorting, grouping, and the list of recurring series.
* **Projects**: progress, deadlines and their tasks.
* **Calendar**: day and week views, drag across days, resize, double-click to create a task or an event, import and export `.ics` files.
* **Calendars by link**: paste a calendar's iCal or webcal link (a school timetable, Google, Outlook) in the chat or in **Settings → Data**. AURA downloads it from its server, keeps its events up to date every 6 hours and removes them if you remove the calendar. This never goes through the AI: the link usually holds a private key, so it is hidden in the conversation and never sent to the AI.
* **Completed**: history with estimated vs actual time, weekly statistics and a 14-day chart.
* **Focus mode** (`F`): one task, a countdown or Pomodoro timer, its subtasks. Focused time is recorded as the actual time spent.
* **Quick add** (`N`) understands shorthand in English and French, for example `Call mom tomorrow 18:00 30m !high #family +Personal` or `Rapport demain 14h 1h30 !critique avant vendredi`.
* **Command palette** (`Ctrl K`), undo of the last change (`Ctrl Z`), optional reminders before a task starts, a completion streak.
* Tasks support descriptions, notes, links, tags, categories, subtasks, dependencies (cycles are rejected), hard or soft deadlines, a "not before" date, effort level, recurrence (daily, weekly on chosen days, monthly, with an optional fixed time) and estimated vs actual minutes.
* English and French, light and dark themes, usable down to phone width.

## How the assistant works

### Safety of each request

Whatever the provider, the AI can only use AURA's planning tools. It has no shell, no file access and no web access. Each tool call is validated with a strict schema and executed by the same functions the interface uses, on a private copy of your data. Invalid or hostile calls are rejected and reported back to the AI, which can correct itself. When it finishes, AURA turns the staged changes into a proposal. Nothing is written to the database until the proposal is applied, and every applied proposal can be undone.

With Claude Code, every request starts `claude -p` with:

* **No built-in tools** (`--tools ""`): no shell, no file reading or writing, no web access.
* **Only AURA's planning tools**, served by AURA on a loopback address (`127.0.0.1`) through a small Model Context Protocol endpoint. The address contains a random token that is valid only for that one request.
* `--strict-mcp-config` so your other MCP servers are never loaded, `--setting-sources project` so your personal Claude Code settings and hooks are not loaded, and a per-request settings file that excludes every `CLAUDE.md` and turns off auto memory, so your personal instructions and memory are not sent either.
* `--no-session-persistence` so these runs do not appear in your Claude Code history.
* `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` so Claude Code sends no telemetry or error reports for these runs.
* A clean environment. Any `ANTHROPIC_*` variable is removed, so a stray API key can never switch the run to API billing. AURA also checks the `apiKeySource` that Claude Code reports at startup and stops the request if it is anything other than your subscription sign-in.

With ChatGPT or an API key, AURA calls the service directly and passes the same tools as function definitions. With ChatGPT, requests are sent with `store: false`, as OpenAI asks for this flow, and the whole context goes with each request.

### Models and reasoning effort

The model is chosen by a local classifier, with no extra AI call, so routing adds no delay:

| Request | Examples | Claude default |
|---|---|---|
| Simple | add a task, mark one done, a quick question | Sonnet, low effort (Haiku with a Claude API key) |
| Moderate | organize the day, move or reprioritize tasks, a delay | Sonnet, medium effort |
| Complex | many tasks and constraints, multi-day planning | Sonnet, high effort |
| Very complex | heavily disrupted, ambiguous, multi-day with many dependencies | Opus, medium effort (can be turned off) |

* With Claude Code, models are passed as the aliases `sonnet` and `opus`, which always point to the latest version on your plan. The exact model that answered is shown in the interface.
* With ChatGPT, every request uses the model you pick in the ChatGPT card (by default the first one your account offers), and harder requests get more reasoning.
* The composer lets you force a model and an effort for one message. Each answer offers a retry with the stronger model or more reasoning.
* With Claude Code, the status pill also shows the usage of your 5-hour and 7-day windows.

### When the AI is not available

If the provider is missing, signed out, rate-limited or offline, AURA says exactly what happened and what to do. It never fakes a reply and never switches provider on its own. Tasks, projects, the calendar and the scheduler keep working.

## What is sent to the AI

Only when you send a message or ask for a brief:

* your message
* open tasks planned or due in the next 14 days (and overdue ones), tasks done today, fixed events for the next 7 days, project names, your planning preferences and the current date and time
* the last messages of the conversation (12 by default, configurable)
* your saved assistant notes
* the results of planning tools the AI decides to call, for example a past day's review or your backlog when it needs them

Nothing else leaves the computer: no database file, backups, logs or other files. **Settings → Assistant → What is sent to …** shows this list and a live preview of the exact next request. What the provider does with these requests is governed by your own account's settings with that provider.

## Configuration

Copy `.env.example` to `.env` to change anything. All values are optional.

| Variable | Default | Meaning |
|---|---|---|
| `AURA_HOST` | `127.0.0.1` | AURA refuses any address other than this computer |
| `AURA_PORT` | `4317` | Local port |
| `AURA_DATA_DIR` | `data` | Database, secrets, backups and logs |
| `AURA_OPEN` | `browser` | How the launchers open AURA: `browser`, `app` (an Edge or Chrome app window) or `none` |
| `AURA_IDLE_EXIT_MIN` | `20` | Minutes without an open AURA window before an icon-started server stops (Windows icons) |
| `AURA_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `AURA_SEED_DEMO` | `true` | Load example data on the first launch |

Everything else (name, language, theme, time zone, working days and hours, weekend planning, sleep window, default duration, focus block length, breaks, buffers, lunch, best time for demanding work, scheduling strategy, recurring unavailable periods, reminders, AI provider, model and effort policy) is in **Settings**.

## Data, backups and the database

* The database is `data/aura.db` (SQLite, WAL mode). Writes go through transactions and validated schemas.
* API keys and the ChatGPT sign-in are in `data/secrets.json` (on macOS and Linux, readable by your user only). This file is never included in backups or exports.
* A backup is made automatically every time AURA starts (the 20 most recent automatic backups are kept) and before any import, restore or full deletion. **Settings → Data & privacy** lists them and restores any of them. A safety copy of the current data is always made first.
* **Export all data** produces a JSON file. **Import** validates it before replacing anything.
* Calendars can be exported to and imported from `.ics` files. Calendars added by link are stored with their link on this computer only.
* **Remove example data**, **Clear conversation** and **Delete all data** (type `DELETE` to confirm, optional backup first) are in Settings.
* Logs (`data/logs/aura.log`) record events, timings and errors only. They never contain your messages, task content or secrets.
* The whole `data` folder is ignored by git, so your data and keys can never be committed by mistake.

### Migrations

Schema changes are versioned in `server/db/migrations.ts` and applied automatically at startup. To apply or inspect them by hand:

```bash
npm run db:migrate
```

```bash
npm run db:status
```

To start from scratch, stop AURA and move the `data` folder elsewhere. A new empty database is created on the next start.

### Updating

```bash
git pull
```

Then start AURA again with your launcher. It rebuilds the interface on every launch, and new migrations apply automatically. If dependencies changed, run `npm install` first.

## Architecture

```
start-aura.bat          Windows launcher (Node check, install, build, start, open)
start-aura.command      macOS launcher (double-click in the Finder, runs start-aura.sh)
start-aura.sh           macOS and Linux launcher
scripts/                Windows icons: silent app launcher and shortcut installer
shared/                 types, validation schemas, time helpers, quick-add parser, key detection
server/
  app.ts                Fastify app, local-only guard, static files
  secrets.ts            the local secrets file (API key, ChatGPT sign-in)
  routes/               REST API (tasks, projects, events, days, schedule, proposals, history, data, AI)
  db/                   SQLite wrapper, migrations, entity store, example data
  domain/               business rules: tasks, recurrence, projects, events, planning glue, undo history, proposals
  scheduling/engine.ts  deterministic scheduler (pure functions)
  ai/
    agent.ts            orchestration: routing, prompt, provider call, proposal creation
    router.ts           local complexity classification and model and effort choice
    tools.ts            the validated tools the AI can use
    mcp.ts              loopback MCP endpoint for Claude Code
    prompt.ts           system prompt and request context
    chatgpt/auth.ts     Sign in with ChatGPT (OAuth with PKCE on the loopback address)
    providers/          claudeCode.ts, chatgpt.ts, apiKey.ts and anthropicApi.ts (Claude or DeepSeek key)
  services/             settings, conversation, ICS, calendar links, export and backups
web/                    React interface (views, assistant, components, styles)
tests/                  unit and integration tests
```

### The scheduler

The scheduler is deterministic and does not depend on the AI. For one day it:

1. builds the planning window from your settings (never inside your sleep window), with per-day overrides such as "finish by 20:00"
2. blocks fixed events, recurring unavailable periods and fixed-time tasks, with a buffer around commitments
3. reserves lunch inside your lunch window
4. scores every open task: priority (critical 100, high 70, medium 40, low 15), deadline urgency (overdue, today, within 2, 3 or 7 days, softer for soft deadlines), postponements and project deadlines, weighted by your strategy
5. places tasks in score order at the earliest free slot, putting demanding tasks in your best hours when possible, never before their dependencies, never after a hard deadline, and inserting a break after your longest focus block
6. reports everything that does not fit, why (no time, deadline, blocked, left out of a light day) and the first day with room for it

Completed and fixed-time tasks never move. The "keep valid times" mode only moves what must move, and "shift from now" re-flows the rest of the day after a delay, keeping your order whenever it still fits.

## Tests

```bash
npm test
```

72 automated tests:

* **Scheduler** (17): no overlaps with commitments, hard deadlines met or reported, overload detection, dependencies, fixed and completed tasks untouched, breaks, lunch, peak hours, preserve and re-flow modes, light days, past days, score breakdown.
* **Tasks and history** (12): validation, scheduling, postponement keeps deadlines, cycle rejection, subtasks, recurrence, free-time search, multi-day distribution, undo and refusal when data changed since.
* **Assistant and tools** (19): malformed and hostile tool calls rejected with no change, half-failed calls rolled back, writes staged until approval, read-only runs, approval for deletions and large changes, conflict detection, provider failure leaves data intact and never falls back to another provider, one request at a time, conversation history, model routing.
* **HTTP API** (9): validation, plan, apply and undo without AI, persistence across a restart, AI unavailable, ICS and JSON round-trips, local-only guard, MCP token check.
* **AI accounts** (4): API key kept out of the database and exports, consent asked again when the service changes, subscription tokens refused, the full ChatGPT sign-in (PKCE, signed identity token, nonce), a ChatGPT answer that uses AURA's tools, token refresh and sign-out.
* **Calendars by link** (4), **idle clock** (3), **quick add parser** (4).

The assistant scenarios (planning by talking, follow-ups, completions, delays, persistence, AI unavailable, invalid AI output, data safety) were also run by hand against the real app with Claude through Claude Code.

## Keyboard shortcuts

On a Mac, use `Cmd` where this table says `Ctrl`.

| Keys | Action |
|---|---|
| `Ctrl K` | Command palette |
| `N` | New task |
| `J` or `Ctrl J` | Open or close the assistant |
| `/` | Write to the assistant |
| `F` | Focus mode on the current task |
| `Ctrl Z` | Undo the last change |
| `1` `2` `3` | Timeline, list or priority view (Today) |
| `G` then `T` `U` `I` `A` `P` `C` `D` `S` | Go to Today, Upcoming, Inbox, All tasks, Projects, Calendar, Completed, Settings |
| `?` | Show shortcuts |

## Limitations

* **No system-wide shortcut.** A browser-based app cannot register a global hotkey.
* **Reminders need AURA open.** Notifications come from the browser while the AURA page is open.
* **Recurring events are edited as a series.** Moving one occurrence by drag is disabled. Deleting one occurrence is supported.
* **Tasks cannot span midnight.** A scheduled block starts and ends on the same day.
* **Plan limits apply.** Assistant requests count against your Claude or ChatGPT plan's usage. With Claude Code, each request starts the `claude` program, which adds a few seconds.
* **Model routing is heuristic.** It is based on keywords and the shape of the request, and can be overridden per message.
* **ICS import** covers common files (single events, daily and weekly recurrences, time zones). Complex rules such as "second Tuesday of the month" are imported as single events.
* **One running request at a time.** A second request waits until the first finishes or is stopped.
* **One person per install.** AURA has no login and only answers requests from the computer it runs on.

## Troubleshooting

**The launcher closes immediately or says Node.js is missing.** Install Node.js 22.13 or newer from nodejs.org, then run the launcher again. `node -v` in a terminal should print v22.13 or higher.

**macOS says the file cannot be opened.** Right-click `start-aura.command`, choose **Open**, then **Open** again. If it says you lack permission, run `chmod +x start-aura.sh start-aura.command` in the AURA folder.

**"The port is already in use".** AURA is probably already running: open `http://127.0.0.1:4317`. Otherwise set another `AURA_PORT` in `.env`.

**The page is blank after an update.** Run `npm run build`, then reload the page. The launchers do this automatically.

**"Claude Code is not installed".** Install Claude Code from code.claude.com, check that `claude --version` works in a new terminal, then click **Check connection**. If it is installed in an unusual place, set its path in **Settings → Assistant → Claude Code location**.

**"Not signed in" with Claude Code.** Run `claude auth login` in a terminal and sign in with your Claude account. `claude auth status` should show `"authMethod": "claude.ai"`.

**"Signed in with an API key" with Claude Code.** Claude Code is using an API key or Console account, which would bill API usage. AURA refuses to use it. Run `claude auth login` and choose your Claude subscription, or save the key in AURA's API key card instead.

**ChatGPT sign-in did not finish.** Start again from **Settings → Assistant**. The sign-in link is valid for 10 minutes and must come back to the same AURA. If AURA says plan usage was not allowed, sign out, then continue with ChatGPT again and allow it.

**"Usage limit reached".** Your plan's usage is used up for now. Planning without AI keeps working. For ChatGPT, see [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).

**Claude could not connect to AURA's tools.** Make sure nothing else is using AURA's port, that a firewall or security tool is not blocking local connections to `127.0.0.1`, then try again. `data/logs/aura.log` contains the details.

**Something looks wrong with my data.** Restore an automatic backup from **Settings → Data & privacy → Backups**. A safety copy of the current state is made before every restore.

## License

[MIT](LICENSE).

AURA is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI or DeepSeek. Claude is a trademark of Anthropic, and ChatGPT is a trademark of OpenAI.
