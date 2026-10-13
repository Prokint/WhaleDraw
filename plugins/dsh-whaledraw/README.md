# WhaleDraw DSH 插件

WhaleDraw 基于 [Infinite Canvas](https://github.com/basketikun/infinite-canvas)，提供 DeepSeek Harness 的独立侧栏页面。画布、图片与视频创作、提示词库、素材管理和原有设置在插件页面中使用。

## 构建与安装

在本仓库中先安装前端依赖，然后构建插件：

```powershell
cd web
npm ci
cd ../plugins/dsh-whaledraw
pnpm install --frozen-lockfile --no-optional
node scripts/build.mjs
dsh plugin --profile desktop add "link:<插件目录的绝对路径>"
```

将安装命令中的路径替换为本机插件目录。浏览器版 DSH 使用自己的 profile，例如将 `desktop` 改为 `web`。重新加载 DSH 后，点击侧栏的“WhaleDraw”。

分发给其他机器时，完成上面的构建后，在本插件目录执行：

```powershell
node scripts/build.mjs
pnpm --config.ignore-scripts=true pack --pack-destination dist
```

构建会先从根目录 `VERSION` 同步包版本，再打包为 `dist/dsh-whaledraw-<版本号>.tgz`。应用与 DSH 安装包使用同一个版本号；第三方 Canvas Agent 依赖仍按自己的版本安装。也可以在完成构建后执行 `npm pack`，由 `prepack` 重新构建。接收方执行：

```powershell
dsh plugin --profile desktop add "file:<安装包的绝对路径>"
```

安装器会安装静态服务依赖 `sirv` 与 Canvas Agent 包。运行时由 DSH 的 `webServer` 提供插件自带的静态资源，无需 Vite 或额外前端端口。首次打开插件时会自动启动本地 Canvas Agent HTTP 进程；DSH 的 MCP 客户端另起一个工具进程。构建产物位于 `dist/app`，属于忽略文件；安装源码目录前必须完成构建。缺少产物时插件会明确报错。

## 使用与数据

### 旧插件改名迁移

自有标识改为 `dsh-whaledraw`、`whaledraw` MCP 服务、`whaledraw_open` 工具和 `/plugins/dsh-whaledraw/app` 路由；第三方 `@basketikun/canvas-agent`、其配置目录与上游扩展 SDK / 导入导出协议保持原名。不要手动重命名已安装目录。

旧 `dsh-infinite-canvas` 更新器固定匹配旧包名及旧仓库附件 URL，不能自动完成仓库与包名变更。首次改名需等待包含本次改动的正式 Release 发布：下载其中的 `dsh-whaledraw-<版本>.tgz`，在独立目录克隆本仓库源码（不要覆盖旧源码 link 目标），在 `plugins/dsh-whaledraw` 执行 `pnpm install --frozen-lockfile --ignore-scripts`，**先退出目标 DSH 和安装任务**，再用该 DSH 的 Node 运行迁移安装脚本：

```powershell
node --expose-internals scripts/migrate-install.mjs --profile "<目标profile绝对路径>" --runtime "<DSH CLI或desktop-host包目录>" --pnpm "<宿主pnpm.mjs绝对路径>" --package "<官方tgz绝对路径>" --version "<不带v的正式版本号>"
```

桌面端使用宿主 CLI 配置的 Electron 可执行文件代替 `node`，设置 `ELECTRON_RUN_AS_NODE=1`；`--runtime` 指向宿主的 `@deepseek-ai/dsh-desktop-host` 包目录。Web 版使用自己的 Node 与 `@deepseek-ai/dsh` 包目录。不要把测试 profile 与正式 profile 混用。

脚本校验新仓库的正式附件摘要，进入原生写锁，保留旧依赖和配置，在隔离旧目录后移除旧插件依赖及启用项，再安装新包并逐文件复查。失败恢复旧包、启用列表与配置；新旧包同时存在或恢复未完成时拒绝继续。安装后重新打开 DSH，使旧插件退出、新插件加载；脚本不会自动退出或重启宿主。

同一浏览器来源首次打开新版时，在业务 store 加载前将 `infinite-canvas` / `infinite-canvas-plugins` 数据库复制到 `whaledraw` / `whaledraw-plugins`，同步存储键、语言、主题及旧 localStorage 业务备份；逐条复查，保留旧数据库和 `whaledraw-rename-backup` 快照。需要 Web Locks 与数据库枚举 API，迁移期间关闭旧页面；出现冲突、空间不足或写入失败时停止加载，不覆盖已有不同内容。已有 WebDAV 目录配置按原值保留。DSH 会话绑定单独复制到 `dsh_whaledraw`，保留旧 domain 与 `dsh_whaledraw_rename_backup` 快照。

迁移会增加磁盘占用；同步归档期间服务可能暂停响应。不同端口、协议或浏览器属于不同来源，仍需导出、导入画布。当前已发布的 v0.1.4 不包含这次改名与迁移代码；源码改动未构建或验收，不能直接把旧包当作新包使用。

- 版本检查与在线更新日志读取公开的 `Prokint/WhaleDraw` 仓库；失败时保留安装包自带的日志，不显示为已确认最新。版本弹窗的「立即更新」仅在 DSH 内、存在新版本且 Release 安装包就绪时可点击；确认后插件先下载官方附件到当前 profile 的 `.plugin-manager/downloads/`，校验 Release 的 SHA-256，再交给 DSH 原生插件管理器从本地安装。安装器已尝试使用的包会保留，供 profile 后续重装依赖；未通过下载或校验的文件会清理。代码同步和冲突处理在本仓库完成，单独检查更新不会安装或替换代码。
- 插件升级安装成功后显示「已安装，待重启」，由用户手动重启 DSH 使新版本生效。更新在 DSH 原生配置写锁内保留整个旧 `node_modules` 和 profile 配置，再让 pnpm 在空目录安装；源码链接只随旧目录移动，源码目标不参与删除。安装后逐文件对照官方包的 SHA-256 和文件清单，检查旧依赖与源码完整性，失败则保留失败目录并恢复旧依赖与配置。源码链接也可以更新，不再通过禁用更新规避问题。安装包缺失、网络失败或宿主拒绝安装会显示原因；不会改用任意第三方地址、低版本或未发布版本。
- 更新备份保存在当前 profile 的 `.plugin-manager/downloads/<此次更新目录>/`，含 `previous-node_modules`、独立的 `dependencies-backup.tgz`、源码链接的 `source-backup.tgz`（存在外部源码时）、`recovery.json` 配置快照、归档 SHA-256 和状态。归档保留链接元数据，不跟随链接目标，并在安装前复查内容。备份不自动清理；安装期间其他插件文件可能暂时不可用，更新前结束使用它们的任务。进程被强制结束或回滚不完整时，后续更新会拒绝继续；需退出 DSH 和所有安装任务后，核对恢复记录与备份，人工恢复旧依赖和配置。程序不会覆盖并发修改的源码，也不能找回此前未备份且已删除的文件。

### v0.1.3 及更早版本首次升级

旧安装包仍运行旧更新代码，首次升级到修复版不会自动获得新事务保护；不能把新版本的回归结果当作旧安装器已修复。

- **正式包安装**：先备份当前 DSH profile 的 `node_modules`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 与已有 `cordis.patch.yml`，再手动安装已发布的修复版正式包并重启。修复版加载后，之后的页面更新才会执行备份、复查和回滚。
- **源码 `link:` 安装**：暂停使用旧版「立即更新」，也不要直接用 CLI 把链接替换为安装包。先在源码项目中取得修复代码，在插件目录执行 `pnpm install --frozen-lockfile` 补齐运行依赖，再重启 DSH 加载新版安装逻辑；需要刷新前端时按开发流程构建。确认源码已包含 `installVerifiedBundle` 安全事务后，才进行页面升级。仍使用独立副本验收。
- **已经丢失文件**：先停止安装操作，保留 profile、安装日志和剩余文件。Git 管理的源码从 Git 恢复，未提交或未跟踪文件只能从既有备份恢复；重新安装正式包只能恢复包内文件，不能恢复个人开发改动。此前仅在 Windows 桌面端运行时搭配 pnpm 11.7.0 hoisted 独立复现过目录清空，不能推断所有 v0.1.3 用户均已受影响。

## 其他使用说明
- 插件默认打开「我的画布」，原首页已移除。
- 普通页面与画布右上角的「打开 Agent」入口已移除，内置 Codex 对话面板不再挂载或自动弹出；与 DSH 的连接由独立桥接组件处理。
- 当前会话首次提到「画布」「生图」或提出生成、编辑图片的请求时，插件通过 DSH 原生提问界面询问：连接到已有画布、新开画布、不连接任何画布。如果侧边栏已经打开画布，还会显示「连接侧边栏画布：画布名称」。选择已有画布后，在右侧「我的画布」中点选项目；选择新开画布时创建空白项目；选择不连接时右侧直接打开「生图工作台」，不创建或修改画布。
- 每次新的生图请求都会读取当前可见侧边栏状态。侧边栏与会话默认位置一致时直接使用；不同时询问「当前侧边栏：画布名称（仅本次）」「默认绑定：画布名称」「选择其他画布（仅本次）」。选择其他画布时从列表点选项目。当前侧边栏为生图工作台时也会明确显示。隐藏标签页、关闭或收起的侧边栏不作为当前操作页面，没有当前页面时打开默认位置。
- 会话默认连接保存在 DSH 宿主本地存储，重启后继续沿用。本次临时位置只用于当前请求，不改默认绑定；下次请求重新判断。只有明确要求「更改连接画布」「重新选择画布连接」，或要求 Agent 调用 `whaledraw_open({reselect:true})` 时才保存新的默认位置。项目不存在、选择取消或连接失败时停止当前流程，不会自动改用最近项目或新建项目。
- 插件在模型开始处理相关请求及画布 MCP 工具执行前等待选择和连接就绪，生成工具执行前再次检查侧边栏。选画布时使用 `canvas_generate_image`；选生图工作台时使用 `workbench_image_get_config` / `workbench_image_generate`，插件会拦截不符合本次选择的生成工具。同一次请求内读取参数和执行生成沿用已确认的目标，侧边栏再次变化时重新询问。
- 自动打开请求只发给当前聊天所在的 DSH 界面；界面未打开或切换聊天时会返回错误。等待受 DSH 任务的取消信号控制，停止任务、界面断开或前端报错都会结束等待。
- 在 DSH 聊天右侧的「开始」页点击「WhaleDraw」，即可直接在右侧面板打开插件；也可以从左侧栏进入完整页面。
- 打开插件后，在 WhaleDraw 的设置中配置模型接口与 API Key。模型调用保持前端直连；不会自动读取或修改 DSH 的模型配置、凭据。
- 画布、素材和记录保存在浏览器或 DSH WebView 对应来源的 IndexedDB 中；配置保存在本地存储。会话关联只记录连接方式和画布 ID，画布库、素材及工作台记录仍共享，不按会话复制或隔离。
- 当前 `http://127.0.0.1:3000` 的数据不会自动迁移到 DSH；请在原页面导出画布，在插件内导入。清除 DSH 的站点数据也会清除这里保存的数据。
- 提示词更新、版本检查、远程插件下载和可选 WebDAV 同步沿用原项目行为，封装不等于完全离线。
- DSH 桌面版打开画布后会自动连接本地 Canvas Agent，画布左上角显示连接状态；点击状态会打开 DSH 对话，并把当前画布放到聊天右侧面板。保持右侧画布打开，即可在 DSH 对话中使用 `whaledraw` MCP 工具读取或修改画布。画布内不再显示 Codex 对话面板，右上角「返回 DSH 聊天」按钮已移除。
- 桌面版的画布服务与 MCP 使用 DSH 宿主自带的 Node 运行方式，无需先向 Agent 发送连接指令，也不依赖系统 PATH 中的 `node` 命令。
- 自动连接只支持 DSH 与浏览器同机访问的桌面场景；远程访问 DSH Web 版时，本机桥接接口会拒绝请求。画布模型接口和 API Key 仍在插件自己的设置中配置。

## 实现与验收

宿主入口 `src/index.mjs` 注册 `/plugins/dsh-whaledraw/app` 路由，提供打包后的公开资源及仅本机可读的桥接配置。客户端入口 `src/client.js` 使用 DSH 的 `main`、`sidebar.panellist` 和右侧面板插槽展示同源 iframe。`cordis.yml` 通过 DSH 官方 MCP 客户端注册画布工具；MCP 进程读取本机 Canvas Agent 的配置，不把 Connect token 写入 DSH 配置。React 19 和画布样式留在 iframe 内，插件入口使用 DSH 提供的 React。

插件卸载时通过 Cordis effect 和插槽作用域撤销注册，不删除已保存的画布。已完成生产构建、本机 desktop 配置安装和真实 DSH 宿主 HTTP 检查：首页、内部路由、脚本、样式、图标、配置文件与节点插件清单均返回 200；缺失资源返回 404，不支持的方法返回 405。桌面界面交互及模型调用仍需人工验收。

更新 link 安装的插件后，需要重新启动 DSH 桌面版，以便服务端重新读取前端静态资源；仅刷新画布页面无法更新缓存的文件列表。

请检查：安装与侧栏入口、所有页面导航和刷新、画布保存后重新打开、素材上传与下载、复制粘贴、模型调用、启用的节点插件，以及卸载后重新安装的数据保留情况。

保留上游作者 basketikun 的署名、页面标识及随包提供的 MIT LICENSE。
