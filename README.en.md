# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: |

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Born from the "meow" fork — hence the name — but works on any DSH profile.

**The idea**: every workspace keeps a structured memory database (`.dsh-meow/memory.db`,
SQLite via `node:sqlite`). The static tool manual (seven layers + every `memory_*` tool's
usage) lives in the **system prompt** as a fixed section — constant text, so your LLM
provider's KV/context cache stays untouched. Dynamic content (soul/user in full, design
principles, memory guide) is injected as a **prefix of the first user message**, and the
first turn injects long-term memory only — no keyword hits. From the second user message
on, every message gets a keyword hit (top-2). The model deep-dives into the rest on demand
with `memory_search` / `memory_project`. Each window's own agent consolidates its memories
at night ("dream"), and only its own memories — with the window's knowledge frozen at the
last conversation timestamp.

## ✨ Features

- **Seven memory layers** (`soul` = the AI itself / `user` = user basics & preferences /
  `project` = per-project info with `subcategory` (overview/structure/decisions/quotes/ops/todo) /
  `fact` = atomic facts / `lesson` = mistakes & corrections / `topic` = ongoing discussion arcs
  with a goal sentence / `rules` = design principles & behavioral rules). One SQLite table
  per layer, UUIDs are time-prefixed so id order == creation order.
- **First-turn injection (long-term memory block)**: before the first user message, a fixed
  format is injected: `===== 长期记忆 =====` → `【关于你】` (all soul entries) →
  `【关于user】` (all user entries) → `【设计原则】` (global rules with importance ≥ 2 —
  few, imperative guidelines) → `【记忆导引】` (usage note + the dynamic "all your projects"
  list for `memory_project`) → `===== 长期记忆结束 =====` + `本轮用户prompt：`.
  **No keyword hits on the first turn** (hits start from the second message). Even when the
  first user message arrives batched with a plugin notice (e.g. an approval-policy change
  notification), the snapshot still lands on the real user message and hits never fire early.
- **Per-message keyword hits**: from the second user message on, every real user message is
  matched against fact/lesson/rules/topic (scope = global + current-project anchor),
  top-2 hits are injected under a "可能相关的记忆，仅供参考：" prefix. Matching is based on
  **entry keywords** (LLM-extracted or auto bigram) — not full text, which is noisy.
  Scoring = intersection × idf × coverage × Ebbinghaus decay (by memory timestamp) ×
  importance weight × title bonus.
- **Current-project anchor**: any `memory_remember/search/update/project` call with a
  `project` parameter anchors the session's current project; unanchored sessions only hit
  global entries (casual chat stays unaffected).
- **Cache-friendly by design**: the static `meow-memory:guide` section (order 130, right
  after the `tool:*` guidance sections) is registered in the system prompt once — constant
  text, KV-cache friendly. Already-seen memories (`injected` + `searched`) are recorded per
  session (`.dsh-meow/sessions/<id>.json`) and never re-injected or re-searched; a
  session-compaction signal (`compaction/*`) releases the seen records so compressed-away
  memories can be hit again.
- **Toolset**: `memory_remember` (write, dedup merge, returns read-back confirmation:
  keywords/project; accepts a `keywords` parameter — reflection/dream turns have the LLM
  summarize 5–10 content words, auto bigram extraction as fallback) / `memory_search`
  (BM25 × recency, filters: level/project/status/days, sorted by memory timestamp) /
  `memory_project` (whole-project injection paragraph: grouped by subcategory, all
  non-stale entries, todo section with latest 5 done + to-do list, plus memory-db &
  session-history pointers) / `memory_find_similar` (duplicate & conflict detection) /
  `memory_read` / `memory_update` (incl. status active/archived/stale, importance, goal,
  manual keyword fixes) / `memory_dream` (manual trigger).
- **Memory timestamp** (`updated_at` = last update time): refreshed by dream stamping or
  any `memory_update`. Search results are re-ordered by it, hits/injections show relative
  time (e.g. "2 days ago"), with a "conflict → newest wins" hint.
- **Per-window dream**: at night (00:00–07:00 in the configured `timeZone`, default
  Asia/Shanghai, idle) every window whose last chat is newer than its last dream gets
  consolidated by its own main agent — one project group per turn — using its full
  conversation context. Old windows (no live agent, >24h) and archived sessions are left
  alone.
- **Reflection**: after ≥7 consecutive tool steps within one task the plugin asks the
  model whether anything since the last consolidation is worth remembering. A turn whose
  last tool is a `memory_*` tool counts as already having consolidated (no re-reflection);
  cancelled turns never trigger it.
- **Reflection-fold UI (client)**: reflection/dream turns (prompt, think, tool calls and
  the report) collapse into a slim bar (collapsed by default, showing "N memories added");
  clicking expands it into a card with the full record — the message flow stays clean.
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
    hitTopK: 2             # max keyword-hit entries injected per user message (fact/lesson/rules/topic)
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
First user message (turn 1)      Every message from turn 2            night
┌────────────────────┐          ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │          │ 可能相关的记忆，仅供  │        │ per-window dream:     │
│ 【关于你】(soul)     │          │ 参考：keyword hits    │        │ own memories, grouped │
│ 【关于user】         │          │ top-2 (global +     │        │ by project, one group │
│ 【设计原则】(rules)   │          │ current-project     │        │ per turn, updated_at  │
│ 【记忆导引】          │          │ anchor)            │        │ stamped at T          │
│ ─────────────      │          └────────────────────┘        └──────────────────────┘
│ 本轮用户prompt：     │          seen ids recorded
│ [user text]        │          per session (sessions/<id>.json)
└────────────────────┘          compaction signal → seen released
   injected once per
   session, no hits on turn 1
```

## 🛠 Development

```sh
npm install
npm run build          # esbuild bundle → lib/index.js (self-contained)
npm run test           # 144 logic tests: db / bm25 / migrate / inject / reflect / dream / tools / apply
```

The `@deepseek-ai/*` packages live in the dsh-meow pnpm workspace, not in this package's
`node_modules`. On Windows, `npm run link-workspace` (or `scripts/link-workspace.ps1`)
creates junction mirrors of the workspace packages so esbuild can resolve them;
`build.mjs` uses `nodePaths` to pick them up. The links are build-time only.

## 📄 License

MIT — see [LICENSE](LICENSE).
