# Changelog

## v0.12.0 (2026-08-19)

### memory_search 结果构成改版（用户拍板）
- **5+5 分段**：默认 top 10 = 前 5 条按相关度**无脑取**（不排除任何记忆，包括已注入/已检索/本 session 建立的）+ 后 5 条从排名第 6 名起逐个往下、**绕开已见**（injected+searched）的记忆补齐——保证最相关的不被"已在上下文里"排除，同时保留新信息。
- 旧规则「已注入/已检索过的不检索」「不检索本 session 建立的记忆」从 `memory_search` 移除（命中注入链路不变，仍去重）；k<5 时全部盲取，k>10 时前 5 盲取、其余绕开已见补齐。
- 工具描述 / MEMORY_GUIDE / README 双语同步。
- 顺带修：检索命中"未标记（project=null）"条目时输出校验报 `project must be a string` → 输出改 `''`（与 memory_read 一致，`projectLabel('')`=未标记）。

### memory_project 必填文案强化（用户反馈 AI 常漏传 project）
- MEMORY_GUIDE 该段改为「你要看哪个项目的信息？必须提供项目名称作为参数。」；工具 description 加必填行；首轮导引加「记得带上项目名，不能空参」；README 双语同步。

### 会话列表"已 dream"小月牙图标（用户拍板）
- 左侧会话列表中，dream 整理过记忆且之后无新对话新信息的会话行最左侧显示 10px 静态小月牙（与 dsh 状态点同尺寸/同配色体系，无动画）。**dsh 本体零改动**。
- 数据**事件驱动无轮询**：host 新增 `/meow-memory/dream-events` SSE 长连接（dream 完成推 `dreamed:true`、会话有新活动推 `dreamed:false`）+ `/meow-memory/dreamed-sessions` 全量快照（client 挂载/断线重连时对账一次）；dream 完成判定 = windows 表 `last_dream_time` 非空且之后无活动。
- 行定位读 React 18 fiber（`__reactFiber$` 内部属性，DevTools 同款机制）拿行渲染 key = session id——精确匹配，不依赖标题；找不到 fiber 静默降级。
- 双实例限制：SSE 只在当前实例广播，跨实例的 dream 完成靠断线重连/挂载对账补齐。
- 测试：`collectDreamStates`（test.mjs，dreamed/dreaming 双态）+ `readSessionId`/`applyDreamIcons`（新 tests/client-dream-icon.mjs，14 断言）。
- 三态与视觉定稿（用户反馈迭代）：①图标改**淡黄色**，dream 进行中显示**白→金呼吸灯动画**（替换 dsh 运行中蓝色动画，避免混淆），完成后停留淡黄；②图标放进 dsh 会话行的**状态槽位**（替换槽内内容，标题零位移）；③SSE 协议扩展为 `state: dreaming/dreamed/active`，快照返回 `{ sessionIds, dreamingIds }`（活跃租约 = dream 进行中）；④路由注册挂 `ctx.effect`（热重载自动注销）+ apply 错误落盘日志。
- **webServer 启动竞态修复**（3080 重启后实测）：fiber 并发启动时 webServer 服务可能晚于插件就绪 → 路由未注册、SPA fallback 接管（工具正常但数据路由缺失）。路由注册改为立即尝试 + 每 1s 重试（最多 20 次），dispose 清理定时器。

## v0.11.0 (2026-08-19)

### dream 两轮制改版
- dream 由「按 project 逐轮」改为**固定两轮**：第 1 轮 = 原子记忆（project/fact/lesson/rules/soul/user），第 2 轮 = topic 记忆；所有 project 混排、`【project：xxx】` 小标题分段、无项目段收尾；空轮跳过。
- 记忆范围 = **本窗口建立的 ∪ 本窗口提取过的**（sessions 文件 injected+searched），不再只整理本窗口自己的。
- 条目展示绝对时间戳（最后更新时间）+ **关键词行**（AI 核查/重写关键词用）。
- 原子轮判断清单 1-12（过时 / 完成 / 琐碎 / bug 修复后 lesson 失效 / 矛盾 / importance / 拆分 / 关键词 / project 标签 / 抽象泛化 / 首轮注入核查 / 项目全景范围）；topic 轮介绍段 + 更新指导 1-9（拆分 / 合并 / 交叉重写）。

### 显示面定稿
- 全链路展示**完整 id**（36 位）；`memory_search` = 检索元数据视图（归属 + 完整 id + 相对时间 + 「关于：关键词」）；命中注入 / `memory_project` = 原文视图（归属 + 完整 id + 绝对/相对时间 + 全文）。
- **project 归属约定**：全局信息填 `"全局"`（与留空=未标记区分）；多项目用英文逗号分隔；检索/命中按「包含当前项目名 或 全局」判定；项目列表自动展开。
- `memory_search` 的 project/status 支持逗号多选（OR 语义）；importance 不设硬上限（软引导 1-4）。

### 反思与记忆手册
- 反思 prompt 终稿：【一】新记忆（project 列表 / 纠正 / 偏好）、【二】更新判断（过时 / 错误 / 完成 / 关键词不准反推）、【三】通用要求；topic 归 dream 轮处理。
- `MEMORY_GUIDE`（system prompt）重写：记忆数据总览 + 工具用法 + 写作准则（content / keywords / importance / status / project）。

### 工具行为
- `memory_remember` **四必填**（content/project/keywords/importance），缺失逐个报错并引导重填；title 参数从工具 schema 移除（db 列保留，后续删除）。
- `memory_update`：project 传空字符串 = 清空归属（未标记）；keywords 空数组 = 不更新（防误清空）；importance 不设上限。
- 修 bug：`RankedHit` 缺 `updated_at` 字段 → search 按记忆时间戳重排从未生效。

## v0.10.0 (2026-08-18)
- dream 租约（owner/progress/advance/recover）；prompt 状态语义定稿（stale=done，archived=delete）。

## v0.9.0 (2026-08-16)
- 注入折叠 UI；dream 防重复闭环（check 门/原子抢占/中断自愈/孤儿收尾）；windowIndex 持久化；fork 会话注入修复；bundles 装配。

## v0.8.x (2026-08-16)
- v0.8.0：记忆关键词改 LLM 提取；命中打分公式（交集 × idf × 覆盖率 × 艾宾浩斯 × importance × title 加成）。
- v0.8.1：发布流程规范化（Release + tgz 附件）+ README 双语同步。

## v0.7.0 (2026-08-16)
- `dream_at` 改名 `updated_at`（记忆时间戳 = 最后更新时间，列合并迁移）。

## v0.6.x (2026-08-16)
- v0.6.0：rules 层（设计原则/行为准则）；当前 project 锚定；每消息关键词命中。
- v0.6.1：project 锚定（sessions 文件 currentProject）。
- v0.6.2：每消息命中链路（非首轮专属）。
- v0.6.3：命中改 keywords 制（匹配条目关键词而非全文）。
- v0.6.4：首轮注入新格式 + dream idle 持久化判定。
- v0.6.5：命中条目时间信息。

## v0.5.x (2026-08-16)
- v0.5.0：导引 topic 带归属；反思/dream 规则带 project 参数。
- v0.5.1：压缩信号释放 seen（允许压缩后再次命中）。

## v0.4.x (2026-08-16)
- v0.4.0：`memory_project` 工具（项目全景段落）。
- v0.4.1：导引动态项目列表（`listProjectNames`）。

## v0.3.x (2026-08-16)
- v0.3.0：反思/dream 轮 UI 折叠（纯 client 插件）。
- v0.3.1：折叠改向下展开大卡片。

## v0.2.0 (2026-08-16)
- 记忆手册进 system prompt（order 130，KV 缓存友好）；README 双语。

## v0.1.0 (2026-08-15)
- 首版发布：七层 SQLite 记忆、首轮注入、夜间 dream。
