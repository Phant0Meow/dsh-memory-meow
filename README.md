# meow-memory 🐱📝

| [中文](README.md) | [English](README.en.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: |

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话记忆插件。


**核心理念**：每个工作区维护一份结构化记忆数据库（`.dsh-meow/memory.db`，基于 `node:sqlite`）。
静态工具手册（七层结构 + 每个 `memory_*` 工具的用法）以固定 section 的形式放在 **system prompt** 里——
文本恒定，因此不会破坏 LLM provider 的 KV/上下文缓存。动态内容（soul/user 全量、设计原则、
记忆导引）作为**第一条用户消息的前缀**注入，且首轮只注入长期记忆、不做关键词命中；
从第二轮起每条用户消息做关键词命中（top-2）。模型按需用 `memory_search` /
`memory_project` 深入检索。每个窗口由自己的主 agent 在夜间（"dream"）整理记忆，
且只整理自己的记忆——以窗口最后一次对话时间戳冻结其知识。

## ✨ 功能特性

- **七层记忆**（`soul` = AI 自身 / `user` = 用户基本信息与偏好 / `project` = 项目信息，
  含 `subcategory`（overview/structure/decisions/quotes/ops/todo）/ `fact` = 原子事实 /
  `lesson` = 教训与纠正 / `topic` = 进行中的讨论话题，带目标句 / `rules` = 设计原则与行为准则）。
  每层一张 SQLite 表，UUID 带时间前缀，id 顺序即创建顺序。
- **首轮注入（长期记忆块）**：第一条用户消息前注入固定格式
  `===== 长期记忆 =====` → `【关于你】`（soul 全量）→ `【关于user】`（user 全量）→
  `【设计原则】`（全局 rules 且 importance≥2，少而精的命令式准则）→ `【记忆导引】`
  （用法说明 + 「用户的所有 project」动态列表，供 `memory_project` 选用）→
  `===== 长期记忆结束 =====` + `本轮用户prompt：`。**首轮不跑关键词命中**（命中从第二轮起）。
  即使首条用户消息与插件通知消息同批到达（如 approval policy 变更通知），快照仍注入到
  真实用户消息上、命中绝不提前。
- **每消息关键词命中**：从第二条用户消息起，每条真实用户消息都检索
  fact/lesson/rules/topic（范围 = 全局 + 当前 project 锚定），top-2 命中以
  「可能相关的记忆，仅供参考：」前缀注入。命中基于**条目关键词**（LLM 提取或自动
  bigram）而非全文——全文匹配噪音大。打分 = 交集分 × idf × 覆盖率 × 艾宾浩斯衰减
  （按记忆时间戳）× importance 权重 × title 加成。
- **当前 project 锚定**：`memory_remember/search/update/project` 带 project 参数即锚定
  该会话的当前项目；未锚定时命中只搜全局（用户闲聊不误伤）。
- **缓存友好设计**：静态 `meow-memory:guide` section（order 130，紧随各 `tool:*` 说明之后）
  在 system prompt 中注册一次——文本恒定，KV 缓存友好。已见记忆（`injected` + `searched`）
  按会话记录（`.dsh-meow/sessions/<id>.json`），绝不重复注入或重复检索；收到会话压缩
  信号（`compaction/*`）时释放已见记录，允许压缩后被再次命中提取。
- **工具集**：`memory_remember`（写入，自动去重合并，返回读回确认：关键词/项目归属；
  支持 keywords 参数——反思/dream 轮由 LLM 总结 5-10 个内容词，不传则自动 bigram 提取）/
  `memory_search`（BM25 × 近期权重，支持 level/project/status/days 过滤，按记忆时间戳排序）/
  `memory_project`（项目全景注入段落：按子标签分组、未过时条目全给、todo 输出
  「已完成：」最近 5 条 +「To do list：」，末尾附记忆库与会话历史定位说明）/
  `memory_find_similar`（查重与冲突检测）/ `memory_read` / `memory_update`（含 status
  active/archived/stale、importance、goal、keywords 手动修正）/ `memory_dream`（手动触发）。
- **记忆时间戳**（`updated_at` = 最后更新时间）：dream 封存或 `memory_update` 刷新时更新。
  搜索结果按它重排，命中/注入带相对时间（如「2 天前」），并带"冲突 → 最新为准"提示。
- **按窗口 dream**：夜间（按 `timeZone` 计算，默认 00:00–07:00，空闲时）每个最后发言
  晚于上次 dream 的窗口由自己的主 agent 整理——每个项目一组、一轮一组——使用其完整
  会话上下文。无 live agent 且超过 24h 的旧窗口、以及已归档的会话，均不处理。
- **反思**：单次任务内连续 ≥7 个工具 step 后，插件询问模型自上次整理以来是否有值得记忆的内容。
  最后工具是 `memory_*` 视为已主动记忆、不重复反思；被取消的轮次绝不触发。
- **注入折叠 UI（client 端）**：首轮长期记忆 / 每消息关键词命中的注入文本在前端
  折叠成「▸ 已注入记忆（长期记忆/关键词命中）」横条（与用户气泡同宽），点开可查看
  注入全文；用户 prompt 以气泡形式直接显示，消息流干净不被注入刷屏。纯文本消息才折叠
  （带附件的保持原样）。
- **反思轮折叠 UI（client 端）**：记忆反思/dream 轮的 prompt 与后续 think/tool call/汇报
  折叠成一条横条（默认折叠，显示「新增记忆 N 条」/「记忆梦境任务」），点击向下展开成
  卡片查看完整记录——卡片内 Think / tool call / 上下文注入均可点开查看细节。
- **dream 防重复**：check 门（DB 原子 60s 检查节流）+ start 幂等抢占（`dream_pending`）+
  中断自愈（未收尾的 dream 自动补收尾）+ 孤儿收尾（跨实例/热重载后 turn 结束也能收尾）；
  插件注入轮的事件不刷新窗口活跃度——已 dream 的窗口不会反复被 dream。
- **零运行时依赖**：`node:sqlite`（Node ≥22.13 默认可用；22.5–22.12 需 `--experimental-sqlite`）+ 自包含 esbuild 产物（`lib/index.js`）。
  无原生模块。

## 📦 安装

### 通过 npm（已发布包）

```sh
# 1. 安装到 profile 的 node_modules（loader 在那里解析插件）
cd $DSH_HOME/profiles/web          # 默认 home: ~/.dsh/profiles/web
npm install meow-memory

# 2. 在 profile 的 package.json 中把包加进装配 bundles（推荐，v0.9.0 起）：
#    "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "meow-memory"] } }
#    （插件自带 dsh.bundle.patch，bundle 机制自动装配；profile patch 的 insert
#     按 id 寻址、找不到已有条目会报 not found——新增插件请走 bundles 数组。）

# 3. 重启 dsh web。新会话自动加载插件。
```

### 手动安装（任意 DSH 安装，无需 npm）

1. 把本包复制（或软链）到 profile 的 `node_modules`：
   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s /path/to/meow-memory ~/.dsh/profiles/web/node_modules/meow-memory
   ```
   （Windows：`New-Item -ItemType Junction ...` —— NTFS junction，无需管理员权限。）
2. 把 `meow-memory` 加进 profile `package.json` 的 `dsh.profile.bundles`（同上）。
3. 重启 `dsh web`。新会话自动加载插件。

## ⚙️ 配置

所有字段均可选（profile patch 或 `cordis.patch.yml`）：

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true          # 总开关
    projectDir: '.dsh-meow' # 记忆目录（相对工作区）
    hitTopK: 2             # 每条用户消息关键词命中的条目数上限（fact/lesson/rules/topic）
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
第一条用户消息（首轮）         第二条起的每条消息                夜间
┌────────────────────┐        ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │        │ 可能相关的记忆，仅供  │        │ 按窗口 dream：        │
│ 【关于你】(soul)     │        │ 参考：keywords 命中   │        │ 自己的记忆，按项目分组 │
│ 【关于user】         │        │ top-2（全局+当前     │        │ 一轮一组，updated_at   │
│ 【设计原则】(rules)   │        │ project 锚定）      │        │ 以 T 封存             │
│ 【记忆导引】          │        └────────────────────┘        └──────────────────────┘
│ ─────────────      │        已见 id 按会话记录
│ 本轮用户prompt：     │        (sessions/<id>.json)
│ [user text]        │        压缩信号 → 释放已见
└────────────────────┘
 每会话只注入一次，
 首轮不做命中
```

## 🛠 开发

```sh
npm install
npm run build          # esbuild 打包 → lib/index.js（自包含）
npm run test           # 144 项逻辑测试：db / bm25 / migrate / inject / reflect / dream / tools / apply
```

`@deepseek-ai/*` 包位于 dsh-meow pnpm workspace 中，不在本包的 `node_modules` 里。
在 Windows 上，`npm run link-workspace`（或 `scripts/link-workspace.ps1`）创建 workspace
包的 junction 镜像，使 esbuild 能解析它们；`build.mjs` 通过 `nodePaths` 引用。
这些链接仅构建期需要。

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。
