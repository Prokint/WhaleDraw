# DSH 无限画布插件

将 [Infinite Canvas](https://github.com/basketikun/infinite-canvas) 封装为 DeepSeek Harness 的独立侧栏页面。画布、图片与视频创作、提示词库、素材管理和原有设置在插件页面中使用。

## 构建与安装

在本仓库中先安装前端依赖，然后构建插件：

```powershell
cd web
npm ci
cd ../plugins/dsh-infinite-canvas
pnpm install --frozen-lockfile --no-optional
node scripts/build.mjs
dsh plugin --profile desktop add "link:<插件目录的绝对路径>"
```

将安装命令中的路径替换为本机插件目录。浏览器版 DSH 使用自己的 profile，例如将 `desktop` 改为 `web`。重新加载 DSH 后，点击侧栏的“无限画布”。

分发给其他机器时，完成上面的构建后，在本插件目录执行：

```powershell
pnpm --config.ignore-scripts=true pack --out dist/dsh-infinite-canvas-0.1.0.tgz
```

该命令将现有构建产物打成安装包。也可以在仓库中的本插件目录执行 `npm pack`，由 `prepack` 自动重新构建。接收方执行：

```powershell
dsh plugin --profile desktop add "file:<安装包的绝对路径>"
```

安装器会安装静态服务依赖 `sirv` 与 Canvas Agent 包。运行时由 DSH 的 `webServer` 提供插件自带的静态资源，无需 Vite、额外前端端口或单独的画布进程。DSH Agent 操作画布时仍需启动本地 Canvas Agent。构建产物位于 `dist/app`，属于忽略文件；安装源码目录前必须完成构建。缺少产物时插件会明确报错。

## 使用与数据

- 打开插件后，在无限画布的设置中配置模型接口与 API Key。模型调用保持前端直连；不会自动读取或修改 DSH 的模型配置、凭据。
- 画布、素材和记录保存在浏览器或 DSH WebView 对应来源的 IndexedDB 中；配置保存在本地存储。数据不按 DSH 会话或项目自动隔离。
- 当前 `http://127.0.0.1:3000` 的数据不会自动迁移到 DSH；请在原页面导出画布，在插件内导入。清除 DSH 的站点数据也会清除这里保存的数据。
- 提示词更新、版本检查、远程插件下载和可选 WebDAV 同步沿用原项目行为，封装不等于完全离线。
- DSH Agent 通过本插件注册的 `infinite-canvas` MCP 工具读写画布。先在插件目录运行 `node node_modules/@basketikun/canvas-agent/dist/index.js`，再在画布的 Agent 连接设置中填入该命令输出的 Local URL 与 Connect token 并点击“连接”。保持画布页面和本地 Canvas Agent 运行，在 DSH 对话中即可要求 Agent 读取或修改当前画布。

## 实现与验收

宿主入口 `src/index.mjs` 注册 `/plugins/dsh-infinite-canvas/app` 路由，仅服务打包后的公开资源。客户端入口 `src/client.js` 使用 DSH 的 `main` 与 `sidebar.panellist` 插槽展示同源 iframe。`cordis.yml` 通过 DSH 官方 MCP 客户端注册画布工具；MCP 进程读取本机 Canvas Agent 的配置，不把 Connect token 写入 DSH 配置。React 19 和画布样式留在 iframe 内，插件入口使用 DSH 提供的 React。

插件卸载时通过 Cordis effect 和插槽作用域撤销注册，不删除已保存的画布。已完成生产构建、本机 desktop 配置安装和真实 DSH 宿主 HTTP 检查：首页、内部路由、脚本、样式、图标、配置文件与节点插件清单均返回 200；缺失资源返回 404，不支持的方法返回 405。桌面界面交互及模型调用仍需人工验收。

更新 link 安装的插件后，需要重新启动 DSH 桌面版，以便服务端重新读取前端静态资源；仅刷新画布页面无法更新缓存的文件列表。

请检查：安装与侧栏入口、所有页面导航和刷新、画布保存后重新打开、素材上传与下载、复制粘贴、模型调用、启用的节点插件，以及卸载后重新安装的数据保留情况。

保留上游作者 basketikun 的署名、页面标识及随包提供的 MIT LICENSE。
