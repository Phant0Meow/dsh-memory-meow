# meow-memory 🐱📝

<p align="center"><strong><a href="README.zh-CN.md">中文</a> · <a href="README.md">README</a> · <a href="LICENSE">MIT license</a></strong></p>

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话记忆插件。
源自 "meow" 分支——因此得名——但可在任意 DSH profile 上使用。

**核心理念**：每个工作区维护一份结构化记忆数据库（`.dsh-meow/memory.db`，基于 `node:sqlite`）。
静态工具手册（六层结构 + 每个 `memory_*` 工具的用法）以固定 section 的形式放在 **system prompt** 里——
文本恒定，因此不会破坏 LLM provider 的 KV/上下文缓存。动态内容（soul/user 全量、记忆索引、
关键词命中的 fact/lesson）作为**第一条用户消息的前缀**注入。模型按需用 `memory_search` /
`memory_find_similar` 深入检索。每个窗口由自己的主 agent 在夜间（"dream"）整理记忆，
且只整理自己的记忆——以窗口最后一次对话时间戳冻结其知识。

## ✨ 功能特性

- **六层记忆**（`soul` = AI 自身 / `user` = 用户基本信息与偏好 / `project` = 项目信息，
  含 `subcategory`（overview/structure/decisions/quotes/ops/todo）/ `fact` = 原子事实 /
  `lesson` = 教训与纠正 / `topic` = 进行中的讨论话题，带目标句）。每层一张 SQLite 表，
  UUID 带时间前缀，id 顺序即创建顺序。
- **缓存友好设计**：静态 `meow-memory:guide` section（order 130，紧随各 `tool:*` 说明之后）
  在 system prompt 中注册一次——文本恒定，KV 缓存友好。动态快照（`soul`/`user` 全量 +
  记忆索引 + 关键词命中的短 fact/lesson）作为第一条用户消息的前缀注入；system prompt 本身
  不随会话变化，快照在整场会话中冻结。已见记忆（`injected` + `searched`）按会话记录，
  绝不重复注入或重复检索。
- **工具集**：`memory_remember`（写入，自动去重合并）/ `memory_search`（BM25 × 近期权重，
  支持 level/project/status/days 过滤，按记忆时间戳排序）/ `memory_find_similar`（查重与
  冲突检测）/ `memory_read` / `memory_update`（含 status active/archived/stale、importance、
  goal）/ `memory_dream`（手动触发）。
- **记忆时间戳**（`dream_at`）：每个窗口 dream 时以整理前的最后对话时间戳封存其条目——
  后续窗口据此判断哪条更新。搜索结果按它重排，并带"冲突 → 最新为准"提示。
- **按窗口 dream**：夜间（按 `timeZone` 计算，默认 00:00–07:00，空闲时）每个最后发言
  晚于上次 dream 的窗口由自己的主 agent 整理——每个项目一组、一轮一组——使用其完整
  会话上下文。无 live agent 且超过 24h 的旧窗口、以及已归档的会话，均不处理。
- **反思**：连续 ≥7 轮工具调用后，插件询问模型自上次整理以来是否有值得记忆的内容。
  被取消的轮次绝不触发。
- **零运行时依赖**：`node:sqlite`（Node ≥22.5 内置）+ 自包含 esbuild 产物（`lib/index.js`）。
  无原生模块。

## 📦 安装

### 通过 npm（已发布包）

```sh
# 1. 安装到 profile 的 node_modules（loader 在那里解析插件）
cd $DSH_HOME/profiles/web          # 默认 home: ~/.dsh/profiles/web
npm install meow-memory

# 2. 在 profile 的 cordis.patch.yml 中注册：
#    - insert:
#        - id: meow-memory
#          name: 'meow-memory'
#          config:
#            enabled: true

# 3. 重启 dsh web。新会话自动加载插件。
```

### 手动安装（任意 DSH 安装，无需 npm）

1. 把本包复制（或软链）到 profile 的 `node_modules`：
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```
   （Windows：`New-Item -ItemType Junction ...` —— NTFS junction，无需管理员权限。）
2. 在 profile 的 `cordis.patch.yml` 中注册（同样的 insert 块）。
3. 重启 `dsh web`。新会话自动加载插件。

## ⚙️ 配置

所有字段均可选（profile patch 或 `cordis.patch.yml`）：

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # 总开关
    projectDir: '.dsh-meow' # 记忆目录（相对工作区）
    hitTopK: 3             # 首条消息注入的关键词命中 fact/lesson 条数
    reflect: true          # 连续 ≥reflectTurns 轮工具调用后自动反思
    reflectTurns: 7        # 触发反思所需的连续工具轮数
    dream:
      enabled: true
      windowStart: 0       # 夜间窗口小时数，按下方 timeZone 计算
      windowEnd: 7
      idleMinutes: 30      # 多长时间无会话事件后允许 dream
      checkMinutes: 15
      timeZone: 'Asia/Shanghai'  # 用户机器时钟为美区时间；夜间窗口必须
                                 # 按此固定时区计算
```

## 🧠 工作原理

```
第一条用户消息                memory 工具                    夜间
┌──────────────────┐          ┌──────────────────┐            ┌──────────────────────┐
│ [soul 核心]       │          │ remember/search/  │            │ 按窗口 dream：        │
│ [user 偏好]       │          │ find_similar/     │            │ 自己的记忆，按项目分组 │
│ [记忆导引]        │          │ read/update       │            │ 一轮一组，dream_at     │
│ [相关记忆 命中]    │          └──────────────────┘            │ 以 T 封存             │
│ ─────────────    │          已见 id 按会话记录               └──────────────────────┘
│ [user text]      │          (json)
└──────────────────┘
   每会话只注入一次，
   绝不重复
```

## 🛠 开发

```sh
npm install
npm run build          # esbuild 打包 → lib/index.js（自包含）
npm run test           # 86 项逻辑测试：db / bm25 / migrate / inject / reflect / dream / tools
```

`@deepseek-ai/*` 包位于 dsh-meow pnpm workspace 中，不在本包的 `node_modules` 里。
在 Windows 上，`npm run link-workspace`（或 `scripts/link-workspace.ps1`）创建 workspace
包的 junction 镜像，使 esbuild 能解析它们；`build.mjs` 通过 `nodePaths` 引用。
这些链接仅构建期需要。

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。
