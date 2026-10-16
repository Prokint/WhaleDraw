# WhaleDraw 修复方案（基于 v0.2.3 代码审查）

> 整合决策：本文件保留原审查方案供追踪；实际实现和验收以 `docs/content/docs/progress/pending-test.mdx` 为准。P0-3 的 localStorage 画布兜底未采用，继续使用 localforage，离页主动落盘不保证浏览器强制关闭前最后一次异步写入完成。画布读取失败的空库覆盖保护已在整合中补齐。

> 本文件是审查产出的修复方案，不属于文档站内容（文档站内容在 `docs/content/docs/`）。
> 每个条目都给出：现象 → 根因（含文件:行）→ 具体改法 → 验收方式 → 风险。
> 标注 **【需用户确认】** 的条目涉及超时、上限、保留策略、删代码等会改变实际行为的边界值，按 `AGENTS.md` 要求必须先向用户说明再动手。

---

## P0-1 独立模式下切换画布会把 A 的数据写进 B（静默数据损坏）

**现象**
独立运行（非 DSH 插件）时，从 `/canvas/A` 跳到 `/canvas/B`，画布组件不重新挂载，会把 A 的 `nodes/connections/chatSessions` 写进 B 项目，并随防抖持久化落盘。DSH 模式下被独占守卫掩盖，所以难以发现。

**根因**
- `web/src/pages/canvas/project.tsx:148-198`：`CanvasPage` 的"错误项目"守卫（`access?.projectId !== projectId → CanvasRefreshShell`）只在 `IS_DSH_PLUGIN` 时生效；独立模式下直接 `return <InfiniteCanvasPage />`。
- `web/src/router.tsx:34`：`/canvas/:id` 是同一个 route element，`projectId` 变化只触发重渲染，不触发重新挂载。
- `web/src/pages/canvas/project.tsx:477-513`：加载 effect 开头 `setProjectLoaded(false)` 是异步生效的；同一次提交中，后面 `project.tsx:556-558` 的保存 effect 读到的仍是本次渲染闭包里的 `projectLoaded === true`，于是用 A 的 `nodes/connections` 调 `updateProject(projectId /* = B */, ...)`。
- 触发路径真实存在：`project.tsx:1222` `createAndOpenProject`、`web/src/pages/canvas/index.tsx:37` 项目列表跳转。

**改法（两条一起做，第一条修 bug，第二条消除整类问题）**

1. 用"已加载的项目 id"取代布尔量做门禁：
   - 新增 `const [loadedProjectId, setLoadedProjectId] = useState("")`。
   - 加载 effect 中 `setProjectLoaded(true)` 处改为 `setLoadedProjectId(projectId)`；effect 开头改为 `setLoadedProjectId("")`。
   - 所有写回 effect 的门禁从 `if (!projectLoaded) return;` 改为 `if (loadedProjectId !== projectId) return;`，涉及：保存节点 effect（`project.tsx:556`）、viewport 保存 effect（`project.tsx:565`）、历史记录 effect（`project.tsx:522`）、视频任务恢复 effect（`project.tsx:515`）。
   - `projectLoaded` 保留给需要"已加载"语义的只读逻辑，或直接全部替换为 `loadedProjectId !== projectId` 判断，避免两份状态。
2. 给画布组件加 `key`，让切项目等于重挂载：把 `project.tsx:196` 的 `return <InfiniteCanvasPage />;` 改成 `return <InfiniteCanvasPage key={projectId} />;`。独立模式下守卫分支也统一为 `access?.projectId !== projectId` 形态（不再用 `IS_DSH_PLUGIN &&`）。

**验收**
- 独立模式：打开 A → 拖动/新增一个节点 → 立刻（不等 400ms）用"新建画布"或项目列表切到 B → 刷新页面，B 应为空画布，A 的修改仍在。
- 独立模式：A 平移缩放后立刻切项目，A 的 viewport 应保存为切换前状态。
- DSH 模式回归：原独占守卫行为不变（第二个页面仍提示占用）。

**风险**：加 `key` 会让切项目重挂载画布组件，切换瞬间重建状态，属预期行为，但会丢失"跨项目保留的 UI 状态"（若有），需要确认没有别处依赖跨项目保留。

---

## P0-2 viewport 防抖定时器被自己的 cleanup 取消，切换前的视口修改丢失

**根因**
`project.tsx:565-575`：effect 依赖数组含 `viewport`，而 cleanup 返回 `clearTimeout(viewportSaveTimerRef.current)`。每次平移/缩放都会重建 effect，把上一轮的待写入清掉而不是替换（新 effect 又起了一个新定时器，看似没问题，但切项目时最后一次 `viewport` 变更的定时器会被 cleanup 清掉且不再重建）。

**改法**
拆成两个 effect：
- 写入 effect：依赖 `[projectId, loadedProjectId, updateProject, viewport]`，函数体内只做"清旧定时器 + 起新定时器"，**不返回 cleanup**。
- 卸载清理 effect：依赖 `[projectId]`，返回 `() => clearTimeout(viewportSaveTimerRef.current)`。
这样"最后一次变更"总有机会被写入，而组件卸载/切项目时仍会清掉悬挂定时器。

**验收**：拖动视口后立即切项目，A 的 viewport 与操作前一致（即最后一次视口变更被保存）。

---

## P0-3 页面关闭时最多丢 400ms 编辑；刷新时可能被旧快照回写

**根因**
- 画布库写入被 400ms 防抖（`web/src/stores/canvas/use-canvas-store.ts:120`）。
- 全仓库没有 `beforeunload` / `pagehide` 处理，只有 DSH 释放路径才 `flushCanvasStorage()`（`project.tsx:180`）。
- IndexedDB 是异步的，`beforeunload` 里 `await` 不可靠。

**改法**
在 `use-canvas-store.ts` 增加同步日志兜底：
1. `flushCanvasStorage()` 写入成功后，除了更新 `knownRaw`，再 `localStorage.removeItem("infinite-canvas:canvas_store:journal")`。
2. 新增 `export function journalCanvasStorage()`：若 `pendingPersistValue` 存在，**先按"打开页面时的磁盘状态"（模块级 `loadedRaw`）算出本页真正改过的项目和删除标记**，只把这些写进 `localStorage` 的 `infinite-canvas:canvas_store:journal`。只存差异而不存整份画布库，是为了让含 base64 图片的大画布也不至于超出 localStorage 配额；没有任何改动时不写。
3. 挂载时（`web/src/main.tsx` 或 `AppProviders`）注册 `window.addEventListener("pagehide", journalCanvasStorage)` 与 `"visibilitychange"`（`document.visibilityState === "hidden"` 时）调用同一函数。
4. hydrate 时在 `canvasStorage.getItem` 里读 journal，按 id 覆盖磁盘上的同 id 项目、并集出磁盘上其它项目（其它页面新建的画布不被挤掉），删除标记同样并集；随后删除 journal 键，并把并回结果作为待写入值交给 `onRehydrateStorage` 立刻落盘。
5. journal 不依赖写入是否已经成功——差异按 `loadedRaw` 算，所以写入成功清掉 journal 后差异仍然算得出来。写入失败时置 `persistBlocked`，页面隐藏不再重复全量重试，等下一次 store 改动自然重试。

**验收**：编辑节点后 100ms 内直接关闭标签页，重新打开数据仍在；另一个标签页新建画布后关闭本页，重开后两个画布都在；删除一个项目后关闭页面，重开后该项目不复活。

**风险**：localStorage 只用于这一条临时恢复日志，符合 `AGENTS.md` 的小数据约定；只覆盖"打开本页之后"的改动，更早的历史改动仍以 IndexedDB 为准。

---

## P0-4 持久化静默降级：IndexedDB 失败（含配额）被误当"降级成功"，用户无感知

**根因**
`web/src/lib/localforage-storage.ts:20-28`：`setItem` / `getItem` / `removeItem` 对**任何** IndexedDB 异常都回退到 `window.localStorage`。
- 画布库含 base64 图片与对话，是单个大字符串，超出 localStorage 5MB 配额会抛 `QuotaExceededError`；调用点 `use-canvas-store.ts:120` 是 `void flushCanvasStorage()`，异常被吞掉。
- 读取回退同样危险：会读到与 IndexedDB 不同的快照，可能把旧数据当成当前数据。

**改法**
1. `localforage-storage.ts` 三个方法去掉 `localStorage` 回退，异常原样抛出。
2. `use-canvas-store.ts` 里 `flushCanvasStorage()` 捕获异常：设置 `useCanvasStore.setState({ storageError: message })`（新增字段，不持久化），并保证 `pendingPersistValue` 不被丢弃（恢复到待写入状态，等下次重试）。
3. 画布页面订阅 `storageError`，用 antd `message.error` 提示一次"本地存储写入失败，可能是空间不足，请导出画布备份"，并提供"立即导出"入口（复用 `exportCurrentProject`）。
4. 清除时机：下一次成功写入后置回 `null`。

**验收**：手动把 IndexedDB 配额压到很小或 mock `localforage.setItem` 抛错，编辑画布应看到错误提示且不出现"看起来保存成功"的假象。

**【需用户确认】** 这里改变的是失败行为（以前静默、现在报错），属于用户可感知变化。

---

## P0-5 canvas-proxy 是任意网站可用的内网转发器（SSRF）+ 通配 CORS

**现象**
任何网页都能 `fetch("http://127.0.0.1:23210/http://169.254.169.254/...")` 并读到响应；`--host 0.0.0.0` 时成为公开开放代理；它还删掉 `origin` 头，使下游 canvas-agent 的 origin 校验形同虚设。

**根因**（`canvas-proxy/index.js`）
- `:8-14` `access-control-allow-origin: *`、`allow-headers: *`、`allow-methods: *`。
- `:17` `SKIP_REQUEST_HEADERS` 含 `origin`/`referer`，主动剥离来源。
- `:78` `redirect: "follow"`，重定向可绕过任何基于初始 URL 的限制。
- `:26-33` `readBody` 无大小上限；`:86-88` `stream.pipe(res)` 没有 `stream.on("error")`，上游中途 RST 会抛未捕获异常。
- `:93-117` 无超时、无 AbortController。

**改法**
1. **来源门禁**：只允许画布页面来源。允许列表默认 `["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"]` 加 DSH WebView 的实际 origin（从 `req.headers.origin` 匹配失败即 403；允许 `Origin: null` 只在 `--allow-null-origin` 时）。列表可通过 `--allow-origin <origin>`（可重复）与环境变量覆盖，并在启动日志打印生效列表。
2. **不再剥离 `origin`**：从 `SKIP_REQUEST_HEADERS` 移除 `origin`（`referer` 可保留剥离）。同时给转发请求加 `x-canvas-proxy: 1` 标记，便于下游识别。
3. **禁止跟随重定向**：`redirect: "manual"`，把 3xx 状态原样返回给调用方。
4. **阻断云元数据与保留地址**：在解析目标后检查主机名/IP：
   - 拒绝 `169.254.169.254`、`metadata.google.internal`、`100.100.100.200` 等已知元数据端点；
   - 拒绝链路本地 `169.254.0.0/16`、CGNAT `100.64.0.0/10`（阿里云元数据段）、`0.0.0.0/8`、广播地址、`fe80::/10`、`::`；
   - **域名必须先解析再判断**，否则用自己的域名指向元数据地址即可绕过；
   - **不**全面禁止私网地址：本工具的用途之一就是代理局域网/本机服务（如本机生图 API），全面禁止会破坏功能。
   - 残留缺口：解析与连接之间的时间差（DNS rebinding）无法在这一层堵住，需要在 README 中写明。
5. **资源上限**【需用户确认】：请求体上限 32MB（与 canvas-agent 的 `express.json({ limit: "30mb" })` 对齐），上游响应不缓冲、只做流式转发；`--host` 非回环地址时必须显式加 `--allow-public` 才启动，否则退出并提示风险。
6. **稳定性**：`forward()` 加 120s 超时（`AbortSignal.timeout`）；`stream.on("error", ...)` 与 `res.on("error", ...)` 都接上，出错时 `res.destroy()` 并记日志。
7. 文档同步：`canvas-proxy/README.md` 写清默认只接受已知来源、如何加白名单、`--allow-public` 的风险。

**验收**
- 用一个不同 origin 的静态页（如 `python -m http.server 8080` 起的页面）发起对 `127.0.0.1:23210/http://example.com` 的请求 → 应 403（浏览器侧表现为 CORS 失败）。
- 从画布页面发起的本地生图接口代理请求 → 正常。
- `curl -i "http://127.0.0.1:23210/http://169.254.169.254/latest/meta-data/"` → 被拒绝，不回传内容。
- 上游中途断开（可用 `node -e` 起一个写一半就销毁连接的 server）→ 代理进程不退出。

**风险**：这是行为收紧，老用户的局域网地址若不在白名单会被拒，需要 README 明确迁移说明；`canvas-proxy` 是独立发布的包，要单独发版本。

---

## P1-1 canvas-agent 存储规则违约：损坏文件被覆盖、历史被全局裁剪

**根因**（`canvas-agent/src/agent/codex-event-history.ts`）
- `:87-97` `load()`：`value.version === 1` 不成立（未知版本）或 JSON `SyntaxError` 时，直接退回 `emptyHistory()`；下一次 `record()` 的 `save()` 就覆盖原文件。`codex-history.test.ts:286` 把这个行为固化成测试。
- `:35`、`:51`：`items.slice(-MAX_ITEMS)` / `turns.slice(-MAX_ITEMS)` 作用于**整个文件**，热门线程会把其它线程的历史挤出去。
- `AGENTS.md` 要求：存储升级先备份再迁移，遇到未知版本、损坏清单或冲突备份时拒绝覆盖原文件，不得静默裁剪历史元数据。

**改法**
1. `load()` 区分三种情况：
   - `ENOENT` → `emptyHistory()`（正常）。
   - JSON 解析失败、或 `version` 不是已知值 → **先把原文件改名备份**为 `${file}.corrupt-${YYYYMMDD-HHmmss}`（用 `fs.rename`，失败则抛错中止），记录 `logger.warn`（含备份路径），再返回 `emptyHistory()`。
   - 结构合法但字段异常（`items`/`turns` 不是数组）按"损坏"处理，同上。
   - 不再把 `value.version !== 1` 和 `SyntaxError` 混在同一个 `catch` 分支里判断，拆成显式分支。
2. 裁剪改为按线程：新增 `trimPerThread(list, key = "threadId", maxPerThread = 2000, maxThreads = 50)`，先按 `threadId` 分组各自保留最后 `maxPerThread` 条，再按最近出现顺序保留 `maxThreads` 个线程，被丢弃的线程数量写 `logger.warn` 一次（不做静默）。`record()` 与 `recordTurn()` 都改用它。
3. 更新 `codex-history.test.ts`：把"损坏即清空"的断言改成"损坏时生成备份文件且运行不中断"；新增"多线程各自保留、互不挤出"的断言。

**【需用户确认】** `maxPerThread = 2000` / `maxThreads = 50` 是新的边界值，需要用户确认后再写入。

**验收**：手工把 `~/.infinite-canvas/codex-event-history.json` 改成 `{"version": 99}`，启动 agent 后应生成 `.corrupt-*` 备份且不覆盖原文件；构造两个线程各 3000 条，确认两个线程都能读到 2000 条。

---

## P1-2 config 损坏即覆盖，token/工作空间/来源列表丢失；写入非原子

**根因**（`canvas-agent/src/config.ts`）
- `:16-25` `loadConfig()` 的 `catch` 不区分 `ENOENT` 与解析失败：JSON 损坏也会重新生成 token 并（`create=true` 时）`saveConfig` 覆盖，`workspace`、`activeThreadId`、`origins` 一起丢失。
- `:28-38` `writeConfigFile` 用 `fs.writeFileSync` 直接写目标文件，不是原子替换。
- `http.ts:19-22` 启动时 `saveConfig(config)`，与 MCP 子进程的 `loadConfig(true)` 可能互相覆盖（MCP 子进程在文件缺失时会各自生成不同 token），导致后续 `/api/tools` 401。

**改法**
1. `loadConfig(create)`：
   - `ENOENT` → 生成新配置（`create` 时落盘）。
   - 其他错误（解析失败/结构非法）→ 把原文件改名备份为 `${CONFIG_FILE}.corrupt-<ts>`，`logger.warn` 记录路径，**不覆盖原文件**；`create` 时在备份成功后才写新配置，备份失败则抛错。
2. 原子写入：`writeConfigFile` 改为写 `${file}.tmp-${process.pid}` → `fs.renameSync` → 再 `chmodSync`；失败时清理临时文件。
3. MCP 模式只读：`canvas-agent/src/server/mcp.ts` 的工具调用必须使用 `loadConfig(false)`；文件缺失时抛出明确错误（"请先启动 Canvas Agent 生成配置"），**任何情况下不在 MCP 进程写配置**。检查 `mcp.ts` 当前是否调用了 `loadConfig(true)`，是则改正。
4. `http.ts:19-22` 的启动写入改为"只在 `config.url` 与期望不一致时写"，并复用原子写入。
5. 单实例保护：启动前尝试对 `${CONFIG_DIR}/canvas-agent.lock` 加独占锁（或用 `net` 绑定端口失败判定），已有实例在跑时直接报错退出，避免两个进程写同一份配置。

**验收**：把 `canvas-agent.json` 改成非法 JSON → 启动应生成 `.corrupt-*` 备份、写入新配置、不报未捕获异常；同时启动两个 agent，第二个应明确报端口占用/已有实例。

---

## P1-3 消息元数据只按 turnId 匹配，违反 threadId+turnId+itemId 归属规则

**根因**
`canvas-agent/src/agent/message-metadata.ts:63-74`：`mergeThread` 只按 `turnId` 建索引（`:67`），忽略 `itemId`；`MessageMetadataRecord`（`:8`）也没有存 `itemId`。目前靠"每个 turn 只有一条用户消息"隐身成立。

**改法**
1. `MessageMetadataRecord` 增加 `itemId?: string`；`bindTurn` 增加可选 `itemId` 参数并写入记录。
2. `http.ts:369-382` 的 `onTurn` 回调里，`chat_message` 用的 `itemId` 是 `"synthetic:user"`，把该值透传给 `bindTurn`。
3. `mergeThread` 先按 `turnId` 分组，若该 turn 在 `messages` 中匹配到多条 `role === "user"`：优先用 `itemId` 精确匹配；记录没有 `itemId` 时只对第一条用户消息应用，并 `logger.warn` 一次。
4. 补测试：一个 turn 含两条用户消息、记录只带 turnId 与带 itemId 两种情况。

**验收**：构造同 turn 双用户消息的线程历史，元数据只落在正确的 itemId 上。

---

## P1-4 Codex 请求无超时 + JSON-RPC id 冲突，会永久持锁

**根因**（`canvas-agent/src/agent/codex-client.ts`）
- `:312-317` `request()` 与 `:246` 的 turn 完成 Promise 都没有超时；app-server 无响应时该 Promise 永远悬挂，而 `http.ts:403-412` 的 `codexMutation` 持锁，之后所有操作返回 `CONVERSATION_BUSY`。
- `:350-363` `handle()` 先判 `this.pending.has(id)`，再判 `message.method`。若 app-server 发来的请求（如审批）复用了 agent 正在等待的 id，会被当成响应消费掉，审批丢失。

**改法**
1. `handle()` 调整顺序：`if (typeof message.method === "string" && "id" in message) return this.answerServerRequest(message);` 放在 `pending.has(id)` 判断之前（注意 `message.error` 分支也要放在其后或改为同时检查 `method`）。
2. `request()` 增加超时：默认 60s（可 `CODEX_REQUEST_TIMEOUT_MS` 覆盖），超时 `reject(new CodexRequestError("Codex 请求超时: <method>"))` 并从 `pending` 删除，同时 `logger.warn`。
3. turn 等待超时：默认 30 分钟（可覆盖），超时后 reject、清理 `activeTurns`、把 `codexBusy` 置回 false，避免锁死；日志写明 threadId/turnId。
4. `http.ts` 的 `codexMutation` 之外再加一层兜底：`beginCodexMutation` 记录开始时间，超过阈值（如 turn 超时 + 5 分钟）时允许强制释放并广播 `CONVERSATION_BUSY` 解除事件，并提示用户。

**【需用户确认】** 60s / 30 分钟 / 强制释放阈值都是新的边界值，需要用户确认后再落地。

**验收**：mock app-server 不回包，调用 `/agent/codex/threads/new` 应在超时后返回明确错误，且随后 `beginCodexMutation` 能成功（锁已释放）。

---

## P1-5 会话断开时残留 pending 元数据与附件；SSE 写入无背压

**根因**
`http.ts:312-318`：`recordPending(...)` 之后才 `session.bindClient(clientId)`，而 `bindClient` 在页面已断开时会抛错；两者都在 `try` 之外，抛错后已写入的 `message-metadata/pending/*` 与 assets 不会被清理。`http.ts:534` 附近 SSE 写入忽略返回值，慢客户端会累积内存。

**改法**
1. 把 `recordPending` + `bindClient` 包进 `try`，`catch` 里 `await messageMetadataStore.remove(messageId)` 后重新抛出（`onFinish` 里已有同类清理逻辑，保持一致的日志）。
2. 启动时清扫：agent 启动后扫描 `message-metadata/pending/`，对 `createdAt` 早于本次启动时间的记录调用 `remove()`（或标记为可回收），避免崩溃残留永久堆积。
3. SSE：`res.write()` 返回 `false` 时记录一次背压告警，超过阈值（如单连接积压 8MB）时主动断开该连接并在 `logger.warn` 写明 clientId。

**验收**：在页面已关闭的情况下发起 turn，`~/.infinite-canvas/message-metadata/pending/` 不应留下文件。

---

## P1-6 DSH 插件：子进程无超时/孤儿进程/启动探测无身份校验/bridge-config 缺 Host 校验

**根因**（`plugins/dsh-infinite-canvas/src/index.mjs`）
- `:29-38`：等待子进程打印 `Local URL:` 没有超时，stderr 被 `ignore`（`:30`），失败无法诊断；`agentReady` 因此永远不清空，所有桥接与工具调用一起挂住。
- `:30` 每次 spawn 覆盖 `child`，`:51` 只 kill 最后一个 → 旧子进程变孤儿。
- `:25-26` 健康探测只要求 `ok: true`，随后把 token 发给该 URL（`canvas-launcher.mjs:72`）。
- `:63-72` `bridge-config` 只校验 `remoteAddress`，不校验 `Host`。

**改法**
1. `ensureAgent`：spawn 前若已有 `child` 且未退出，先 `child.kill()` 并等待 `exit`（带 3s 兜底超时）。
2. 启动等待加超时（默认 20s，可 `WHALEDRAW_AGENT_START_TIMEOUT_MS` 覆盖）：超时 kill 子进程并 reject，错误信息包含捕获到的 stdout/stderr 尾部。把 `stdio` 的 stderr 改为 `pipe` 并累积最近 4KB 用于报错。
3. 健康探测加身份校验：要求响应同时满足 `ok === true` 且返回的 `url` 能被解析、`app === "canvas-agent"`（需要在 `canvas-agent/src/server/http.ts` 的 `/health` 响应里加上 `app: "canvas-agent"` 与 `pid` 字段）。不匹配则视为"端口被其它服务占用"，报错而不是直接使用。
4. `bridge-config` 增加 Host 校验：`req.headers.host` 的主机名必须是 `127.0.0.1`/`localhost`/`[::1]`，否则 403；同时保留现有回环地址校验。
5. `dev: true`（`:52`）与 README 中"重启才能刷新静态文件"的矛盾：改为 `dev: process.env.NODE_ENV !== "production"`，README 同步说明实际行为。

**验收**：把端口 17371 先用别的服务占住，启动 DSH → 插件应报"端口被占用"而不是加载到错误服务；杀掉 agent 进程后再次调用工具 → 能自动重启且不残留旧进程；构建产物更新后静态文件是否需要重启与文档一致。

---

## P1-7 更新事务：护栏记录可能静默丢失；`applied` 之后仍可能回滚

**根因**（`plugins/dsh-infinite-canvas/src/verified-install.mjs`）
- `:232` `await saveJournal("rollback-incomplete").catch(() => {})`：这条记录写失败时，"存在未完成恢复记录就停止后续更新"的护栏（`:91-96`）失效，违反 `AGENTS.md` 的 DSH 更新不变式。
- `:203-213`：`operation(result)` 返回 `applied` 之后还有 `throwIfAborted()`（`:204`、`:211`）和 `saveJournal("installed")`（`:212`）。这里抛错会走 `:215-237` 的回滚，而 DSH 可能已经激活新 bundle，出现"文件回滚但宿主已生效"的不一致。
- `:242-247`：`installBundle` 之后才检查 `intercepted`。若 DSH 异步进入 `change`，原生安装会在无备份的情况下执行。测试里的 mock 是同步调用，覆盖不到。
- **契约不一致**：`canvas-launcher.mjs:107-111` 按"返回 number 即拒绝码"处理，`plugin-update.mjs:58-59` 按 `{ rejection }` 处理，两边测试 mock 也不同（`canvas-launcher.test.mjs:20` vs `plugin-update.test.mjs:82`）。二者不可能同时正确。

**改法**
1. `saveJournal` 失败处理：先重试一次；仍失败则退化为同步写（`fs.writeFileSync`）；再失败时设置模块级 `pendingGuardWriteFailed = true` 并在后续 `installVerifiedBundle` 入口直接抛错（"上次回滚未完成记录写入失败，已停止更新，请人工检查 <directory>"），同时在日志中打印需要人工创建的标记文件路径与内容。
2. 把 `saveJournal("installed")` 移到 `operation(result)` 成功之后、且不再 `throwIfAborted`：即 `applied`/`restart-required` 之后，只有文件复查失败才回滚；abort 信号在此时不再触发回滚（改为记录日志并正常返回 `application`）。
3. `installBundle` 包装：`manager.installBundle` 返回后先 `await Promise.resolve()` 让微任务跑完，再检查 `intercepted`；若仍未进入事务，抛错并**不**报告成功；同时把 `manager.change` 的还原放到 `finally`（现状已是）并记录 `logger.warn`。
4. **契约对齐（先验证再改）**：写一个最小探针脚本，在真实 DSH 里调用 `ctx.connection.admit(req)`，打印返回值的类型与形状（数字 / `{ rejection }` / `undefined` / 其它），以此为准；然后把 `canvas-launcher.mjs` 与 `plugin-update.mjs` 都改为调用同一个共享助手 `admitRequest(ctx, req, res)`，兼容 `number`、`{ rejection }`、`{ status }` 三种形态，任一形态表示拒绝时都写对应状态码并返回 `false`。补一个对两种返回形状都覆盖的测试。
5. 备份清理策略：目前 `previous-node_modules`、`dependencies-backup.tgz`、`source-backup.tgz` 永不清理（README 也写着"不自动清理"）。**保留策略属边界值，【需用户确认】**是否改为"保留最近 N 次（如 2 次）成功更新的备份，更早的自动清理"，确认前不要实现清理逻辑。

**验收**：mock `restoreFiles` 在写 `rollback-incomplete` 时抛错 → 后续 `installVerifiedBundle` 应被拒绝；mock `operation` 返回 `applied` 后触发 abort → 不回滚且返回 `applied`；`admit` 两种返回形状的测试都通过。

---

## P1-8 codex-agent 的本地文件与来源校验（安全面收口）

**根因**（`canvas-agent/src/server/http.ts`）
- `:521-535` `setCors` 反射任意 `Origin`（`Access-Control-Allow-Origin: origin || "*"`）；`:527` 让 `/health`、`/config` 在 origin 校验前就放行。
- `:123` `/health` 返回会话健康信息（含对话状态、MCP 状态），任何网页可读。
- `:529-532` 持有 token 的任意 origin 会被永久加入 `config.origins` 且数量无上限。
- `:157-171` `/agent/local-file/reveal`、`/agent/local-image`：持 token 可读任意绝对路径文件；Windows 下 UNC 路径（`\\host\share`）会让 `stat` 触发 SMB 请求。
- `:423-426` `/agent/claude/turn` 无锁、无并发上限、无超时；`web` 端从不调用它。

**改法**
1. `setCors`：只在 `origin` 命中 `config.origins` 或为 `null`（同源/非浏览器）时回显该 origin；否则不回 CORS 头并返回 403（现有 `:119` 已按布尔结果处理）。`/health`、`/config` 也纳入同一条 origin 规则，不再提前放行。
2. `/health` 精简：只返回 `{ ok, app: "canvas-agent", pid, protocolVersion }`，会话与 MCP 细节移到需要 token 的 `/agent/codex/workspace`。
3. `config.origins` 加上限（如 20 个）并在超出时 `logger.warn`；**【需用户确认】** 上限值。
4. 本地文件接口：
   - 两处都拒绝 `path.win32/posix` 非绝对路径之外的形态，且显式拒绝 UNC 与设备路径：`/^\\\\/`、`/^\/\/[^/]/`、`/^\\\\\?\\/`。
   - `/agent/local-image` 增加大小上限（如 64MB，与前端可承受的 canvas 节点一致）与真实图片类型校验（读 8 字节魔数而不是只看扩展名）。
   - `revealLocalFile` 改为 `spawn(command, args, { shell: false, ... })`（当前已是 `spawn` 数组参数，确认没有 `shell: true`）。
5. `/agent/claude/turn` 与 `canvas-agent/src/agent/claude.ts`：**建议直接删除**（web 端无调用点，属死代码 + 暴露面）。若需保留，则必须：`shell: false` + prompt 走 stdin + 加锁 + 超时 + 并发上限。**【需用户确认】** 删除或保留。
6. `http.ts:538-541` `validToken` 改用 `crypto.timingSafeEqual`（长度不同先比较长度）比较 token；token 从 query 迁移到 `x-canvas-agent-token` 头（前端 `dsh-canvas-bridge.tsx` 与 `use-agent-store` 的调用点同步改），query 形式保留一个过渡期并在日志中提示。

**验收**：从非白名单 origin 的页面请求 `/health` 与 `/agent/codex/models` → 403；`POST /agent/local-file/reveal` 传 `\\attacker\share\x.txt` → 400；`/health` 响应不再包含对话状态。

---

## P2-1 版本检查在 Windows 上恒失败且阻塞启动

**根因**：`canvas-agent/src/version-check.ts:229,238` 用 `execFile` 且无 `shell` 调 `codex` / `npm.cmd`，在 Windows 上抛 `EINVAL`，永远返回"未找到/无法检查"；同步调用还会阻塞启动最多 5s。

**改法**：win32 下解析真实可执行路径（`npm.cmd` 用 `process.env.ComSpec` 包裹，或改用 `spawn(..., { shell: true })` 仅限这两个固定命令）；把 `checkVersions()` 改为异步，`http.ts:436` 改为 `void checkVersions()`，并把结果通过 `/health` 或日志呈现。

**验收**：Windows 上启动后日志显示 codex/npm 版本或明确的"未安装"，启动不被阻塞。

---

## P2-2 前端 localStorage 越界与密钥泄漏路径

**根因**
- `web/src/stores/use-prompt-source-store.ts:31` 未指定 `storage` → 提示词来源列表（业务列表）落在 `localStorage`，违反 `AGENTS.md`。
- `web/src/stores/use-config-store.ts:216` 未指定 `storage` → 整份配置（含 API Key）落 `localStorage`；而 WebDAV 配置走 `app-sync.ts`，出现两套存储。
- `web/src/services/api/video.ts:260` 把 `key=${config.apiKey}` 拼进 Gemini 结果 URL；该 URL 会被写入节点 metadata/`content`，等于把密钥持久化进画布并可能随导出/WebDAV 外流。

**改法**
1. `use-prompt-source-store` 改用 `localForageStorage`（与画布库同一适配器）。
2. `use-config-store` 拆成两段：非敏感配置继续 `localStorage`；API Key 相关字段单独用 `localForageStorage` 持久化（保持 zustand 结构不变，用 `partialize` 分区）。若拆分成本高，最低限度是把整个 config 迁到 `localForageStorage`。
3. `video.ts:260`：不在 URL 上带 key。若上游只支持 query key，则在写入节点数据前用占位符替换真实 key（保存时 strip），并在读取/请求时注入；补一条断言：节点 `content`/`metadata` 中不允许出现 `key=` + 真实密钥。
4. 明确密钥展示策略：设置页密钥输入框保持掩码，导出画布与 WebDAV 同步时剥离密钥字段（检查 `app-sync.ts` 与导出逻辑）。

**验收**：导出画布 JSON 全文搜索 API Key 不应命中；提示词来源列表在 IndexedDB 中可见、`localStorage` 中不可见。

---

## P2-3 画布主题规范违反（硬编码颜色）

**根因**（`AGENTS.md`「画布 UI 规范」要求使用 `canvasThemes` / `useThemeStore` / antd token）

已确认的硬编码点：
- `web/src/components/canvas/canvas-node-hover-toolbar.tsx:188`（`bg-white`）、`:294-296`（`#242529`、`#f0f0f1`）
- `web/src/components/canvas/canvas-selection-toolbar.tsx:61,76,78`（同上）
- `web/src/components/canvas/canvas-project-card.tsx:36`（`bg-[#f1eee8]`）
- `web/src/components/canvas/asset-picker-modal.tsx:37-51`（`stone-*` 系列）
- `web/src/components/canvas/canvas-node-mask-edit-dialog.tsx:22,256,321`（`#2563eb`、`#fbbf24`、`#ef4444`）
- `web/src/components/canvas/canvas-side-panel.tsx:48-50`
- `web/src/components/canvas/canvas-plugin-manager-modal.tsx:113,219`

**改法**：把上述颜色替换为 `canvasThemes[theme]` 中的对应 token 或 antd `ConfigProvider` 的 `colorBgElevated` / `colorBorderSecondary` / `colorPrimary` 等；功能性语义色（掩码编辑的蓝/黄/红）统一进 `web/src/lib/canvas-theme.ts` 作为语义 token 再引用，不要在组件内写十六进制。

**验收**：浅色/深色主题下逐个截图比对工具栏、选择框、项目卡片、素材选择弹窗、掩码编辑弹窗的对比度与一致性。

---

## P2-4 死代码与超长文件（需先定去留，再谈拆分）

**事实**
- `web/src/components/agent/local-agent-panel.tsx`（1603 行）在 `web/src` 中**没有任何导入点**；`components/agent/*` 其余文件（约 5k 行）也只被它引用。`useAgentStore.connectAgent/disconnectAgent` 仅由它调用。
- `web/src/pages/canvas/project.tsx` 3510 行；`canvas-node.tsx` 997；`model-plugin.ts` 991。

**改法（先决策后动手）**
- **【需用户确认】** 独立模式的本地 agent 面板是要"重新挂上"（在 `user-layout` 或画布页按条件渲染）还是"删除"。若是删除，连同 `components/agent/*` 中仅被它引用的文件与 `useAgentStore` 中无用的 action 一起删；不要保留 `// removed` 注释或兼容导出。
- 决策之后再做 `project.tsx` 拆分：按"加载/保存与历史""生成任务""剪贴板与导入导出""agent 接线"切成同目录 hook 或子组件，保持组件只做编排。不要为了拆分引入新的全局状态。

**验收**：删除后跑通构建与现有 `web/tests`；拆分后 `project.tsx` 只保留渲染与编排逻辑。

---

## P2-5 工程与文档一致性

| 问题 | 位置 | 改法 |
| --- | --- | --- |
| 三个 lockfile 并存，无权威声明 | `web/bun.lock`、`web/package-lock.json`、`web/pnpm-lock.yaml`；`canvas-agent/` 同样两份 | 在 `web/package.json` 写 `"packageManager": "bun@<版本>"`，删除 `pnpm-lock.yaml`；统一 README、quick-start、插件 README 的安装命令；**【需用户确认】** 是否切到 bun（发布会涉及 `dsh-plugin-release.yml:37-39` 现有的 `npm install` 重建） |
| pnpm workspace 占位符未替换 | `web/pnpm-workspace.yaml:2`（`esbuild: set this to true or false`） | 删文件或写成合法布尔值 |
| 发版流程缺 GitHub Release 步骤 | `AGENTS.md` 发版流程 vs `dsh-plugin-release.yml:4-5`（`release: published`） | 在 `AGENTS.md` 发版流程补"合并后创建对应 tag 的 GitHub Release"，否则 `.tgz` 不会产出；同时把示例 tag `v0.0.5` 更新为当前形态 |
| compose 仍指向上游镜像 | `docker-compose.yml:3`、`docs/docker-compose.yml:3`（`ghcr.io/basketikun/...`） | 改为本仓库镜像地址（与 `docker-image.yml:13` 的硬编码名统一后一起确认命名） |
| docker 文档描述错误 | `docs/content/docs/overview/docker.mdx:8-14,40`（说用本仓库镜像、说容器跑 Next.js） | 按根 `Dockerfile:13` 实际是 nginx 静态镜像改写 |
| WebDAV 措辞与 AGENTS.md 冲突 | `AGENTS.md`「不要写成已支持云同步」vs `docs/index.md:44`、`features.mdx:68`（WebDAV 可选） | `AGENTS.md` 该条改为"内置云同步不支持；用户自建 WebDAV 同步是已实现功能"，避免后续误删文档 |
| 上游 CHANGELOG 链接 | `docs/src/app/[lang]/docs/progress/changelog/page.tsx:14` | 指向本仓库 `CHANGELOG.md` |
| CI 权限过宽 | `dsh-plugin-release.yml:13-14`（`contents: write`） | 收敛为 job 级最小权限 |
| 第三方 action 未锁 SHA | `docker-image.yml:23,55` 等 | 锁到 commit SHA（可选，按仓库策略） |

**验收**：`node scripts/sync-version.mjs` 后 `VERSION`、`web/package.json`、`plugins/dsh-infinite-canvas/package.json` 一致；文档站构建无死链；compose 拉起的镜像确为本仓库产物。

---

## 建议的执行顺序

1. **P0-1、P0-2**（数据损坏与丢失，前端独立模式，纯前端改动，风险最低）
2. **P0-5**（canvas-proxy 安全收紧，独立包，可单独发版）
3. **P1-1、P1-2**（存储备份与原子写入，直接对应 `AGENTS.md` 硬规则）
4. **P1-3、P1-4、P1-5**（归属与超时，需要先确认边界值）
5. **P1-6、P1-7**（插件生命周期与更新事务；其中 `admit` 契约必须先探针验证）
6. **P1-8、P2-***（安全收口、规范性修复、文档一致性）

每一项完成后的文档动作（按 `AGENTS.md`）：改动写入 `CHANGELOG.md` 的 `Unreleased`（`[修复]`/`[调整]` 前缀）；`docs/content/docs/progress/todo.mdx` 中对应条目移到 `pending-test.mdx`；用户确认测试通过后再更新 `docs/content/docs/overview/features.mdx`。
