# meow-memory 🐱📝

Cross-session project memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Born from the "meow" fork — hence the name — but works on any DSH profile.

**The idea**: every workspace keeps one human-readable memory file (`.dsh-meow/PROJECT.md`).
New sessions get it injected as a **prefix of the first user message** (not the system prompt), so
the prompt prefix — and your LLM provider's KV/context cache — stays untouched. The full file is
injected, never truncated. When the model finishes a task (a ReAct turn that used tools), the
plugin gently asks it to reflect and save what's worth remembering.

## ✨ Features

- **Cache-friendly by design**: memory is injected as a plain user-message prefix on the
  session's first user message — the complete memory content comes first, then the user's own
  text. The system prompt never changes, and the snapshot is frozen for the whole session —
  later memory updates cannot invalidate the request prefix.
- **Human-owned memory**: `.dsh-meow/PROJECT.md` per workspace. Plain Markdown, human-editable,
  git-diffable. Injected in full on the first user message — no truncation.
- **`memory_remember` tool**: the model can write a memory anytime (categories: fact / mistake /
  preference / user_said / lesson / detail), appended atomically to the right section.
- **Automatic reflection**: after a task turn ends (model stopped calling tools), the plugin
  steers a reflection prompt. The model decides whether anything is worth remembering — and
  calls `memory_remember` only when there is. Chat-only turns never trigger reflection.
- **No recursion**: reflection rounds are marked; a turn that already reflected, or whose last
  tool call was a `memory_` tool, is never asked again.
- **Zero runtime dependencies**: the host bundle is self-contained (esbuild bundles
  schemastery / dsh-tools / dsh-llm into `lib/index.js`).
- **Per-workspace isolation**: different projects, different memory files.

## 📦 Install

### Via `dsh plugin` (requires the package to be published / linked)

```sh
dsh plugin --profile web add meow-memory
dsh web
```

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
   # e.g. for the web profile of a DSH home at ~/.dsh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```
   (On Windows: `New-Item -ItemType Junction ...` — NTFS junction, no admin needed.)
2. Register in the profile's `cordis.patch.yml`:
   ```yaml
   - insert:
       - id: meow-memory
         name: 'meow-memory'
         config:
           enabled: true
   ```
3. Restart `dsh web`. New sessions pick up the plugin automatically.

## ⚙️ Configuration

All fields are optional (profile patch or `cordis.patch.yml`):

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # master switch (false = no injection, no tool, no reflection)
    projectDir: '.dsh-meow' # memory directory, relative to the workspace
    projectFile: 'PROJECT.md' # memory file name
    reflect: true          # auto-reflection after ReAct task turns
```

## 🧠 How it works

```
First user message            memory_remember tool             task end
┌──────────────────┐          ┌──────────────────┐            ┌──────────────────────┐
│ [PROJECT.md      │          │ model calls it   │            │ agent/turn-stopping  │
│  snapshot]       │          │ → append to       │            │ saw tool calls?      │
│ ─────────────    │          │   .dsh-meow/      │            │ last tool memory_*?  │
│ [user text]      │          │   PROJECT.md      │            │ already reflected?   │
└──────────────────┘          └──────────────────┘            │ → agent.steer(reflect│
   injected once per                atomic write              │   prompt) if yes     │
   session, never again                                       └──────────────────────┘
```

Memory content guidance (embedded in the tool description and the reflection prompt):

- important facts, conclusions, decisions;
- mistakes and **corrections from the user** (always worth keeping);
- the user's own description of the project (quote them);
- surprises;
- lessons from repeated failed attempts;
- user preferences (communication / working / coding style, project-related);
- hard-won details that took many tool calls to find.

## 🛠 Development

```sh
npm install
npm run build          # esbuild bundle → lib/index.js (self-contained)
npm run test           # 25 logic tests: tool, store, injection, reflection, recursion guard
```

The `@deepseek-ai/*` packages live in the dsh-meow pnpm workspace, not in this package's
`node_modules`. On Windows, `npm run link-workspace` (or `scripts/link-workspace.ps1`)
creates junction mirrors of the workspace packages so esbuild can resolve them;
`build.mjs` uses `nodePaths` to pick them up. The links are build-time only.

## 📄 License

MIT — see [LICENSE](LICENSE).
