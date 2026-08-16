# meow-memory 🐱📝

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Born from the "meow" fork — hence the name — but works on any DSH profile.

**The idea**: every workspace keeps a structured memory database (`.dsh-meow/memory.db`,
SQLite via `node:sqlite`). New sessions get the essential layers injected as a **prefix of the
first user message** (not the system prompt), so the prompt prefix — and your LLM provider's
KV/context cache — stays untouched. The model deep-dives into the rest on demand with
`memory_search` / `memory_find_similar`. Each window's own agent consolidates its memories at
night ("dream"), and only its own memories — with the window's knowledge frozen at the last
conversation timestamp.

## ✨ Features

- **Six memory layers** (`soul` = the AI itself / `user` = user basics & preferences /
  `project` = per-project info with `subcategory` (overview/structure/decisions/quotes/ops/todo) /
  `fact` = atomic facts / `lesson` = mistakes & corrections / `topic` = ongoing discussion arcs
  with a goal sentence). One SQLite table per layer, UUIDs are time-prefixed so id order ==
  creation order.
- **Cache-friendly by design**: `soul`/`user` are injected in full on the first user message,
  plus a memory index (project/topic titles) and keyword-hit short facts/lessons. The system
  prompt never changes; the snapshot is frozen for the whole session. Already-seen memories
  (`injected` + `searched`) are recorded per session and never re-injected or re-searched.
- **Toolset**: `memory_remember` (write, with dedup merge) / `memory_search` (BM25 × recency,
  filters: level/project/status/days, sorted by memory timestamp) / `memory_find_similar`
  (duplicate & conflict detection) / `memory_read` / `memory_update` (incl. status
  active/archived/stale, importance, goal) / `memory_dream` (manual trigger).
- **Memory timestamp** (`dream_at`): each window's dreams stamp its entries with the last
  conversation time before the dream — later windows can tell which entry is newer. Search
  results are re-ordered by it with a "conflict → newest wins" hint.
- **Per-window dream**: at night (02:00–05:00, idle) every window whose last chat is newer than
  its last dream gets consolidated by its own main agent — one project group per turn — using
  its full conversation context. Old windows (no live agent, >24h) are left alone.
- **Reflection**: after ≥7 consecutive tool turns the plugin asks the model whether anything
  since the last consolidation is worth remembering. Cancelled turns never trigger it.
- **Zero runtime dependencies**: `node:sqlite` (built into Node ≥22.5) + self-contained esbuild
  bundle (`lib/index.js`). No native modules.

## 📦 Install

### Via npm (published package)

```sh
# 1. Install into the profile's node_modules (the loader resolves plugins there)
cd $DSH_HOME/profiles/web          # default home: ~/.dsh/profiles/web
npm install meow-memory

# 2. Register in the profile's cordis.patch.yml:
#    - insert:
#        - id: meow-memory
#          name: 'meow-memory'
#          config:
#            enabled: true

# 3. Restart dsh web. New sessions pick up the plugin automatically.
```

### By hand (any DSH install, no npm needed)

1. Copy (or symlink) this package into the profile's `node_modules`:
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```
   (On Windows: `New-Item -ItemType Junction ...` — NTFS junction, no admin needed.)
2. Register in the profile's `cordis.patch.yml` (same insert block as above).
3. Restart `dsh web`. New sessions pick up the plugin automatically.

## ⚙️ Configuration

All fields are optional (profile patch or `cordis.patch.yml`):

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # master switch
    projectDir: '.dsh-meow' # memory directory, relative to the workspace
    hitTopK: 3             # keyword-hit facts/lessons injected on the first message
    reflect: true          # auto-reflection after ≥reflectTurns tool turns
    reflectTurns: 7        # consecutive tool turns before reflection triggers
    dream:
      enabled: true
      windowStart: 0       # night window hours, computed in timeZone (below)
      windowEnd: 7
      idleMinutes: 30      # no session events for this long before dreaming
      checkMinutes: 15
      timeZone: 'Asia/Shanghai'  # the user's machine clock is US time; the night
                                 # window must follow this fixed zone instead
```

## 🧠 How it works

```
First user message            memory tools                     night
┌──────────────────┐          ┌──────────────────┐            ┌──────────────────────┐
│ [soul 核心]       │          │ remember/search/  │            │ per-window dream:     │
│ [user 偏好]       │          │ find_similar/     │            │ own memories, grouped │
│ [记忆导引]        │          │ read/update       │            │ by project, one group │
│ [相关记忆 命中]    │          └──────────────────┘            │ per turn, dream_at    │
│ ─────────────    │          seen ids recorded                │ stamped at T          │
│ [user text]      │          per session (json)               └──────────────────────┘
└──────────────────┘
   injected once per
   session, never again
```

## 🛠 Development

```sh
npm install
npm run build          # esbuild bundle → lib/index.js (self-contained)
npm run test           # 80 logic tests: db / bm25 / migrate / inject / reflect / dream / tools
```

The `@deepseek-ai/*` packages live in the dsh-meow pnpm workspace, not in this package's
`node_modules`. On Windows, `npm run link-workspace` (or `scripts/link-workspace.ps1`)
creates junction mirrors of the workspace packages so esbuild can resolve them;
`build.mjs` uses `nodePaths` to pick them up. The links are build-time only.

## 📄 License

MIT — see [LICENSE](LICENSE).
