# Infinite Canvas for DeepSeek Harness

这是基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 的独立分支，保留完整无限画布应用，并增加 DeepSeek Harness（DSH）桌面插件。原项目和本分支均采用 MIT 许可证；原作者署名与页面标识保留。

## 核心功能

- 无限画布、图片与视频创作、提示词库、素材管理。
- 在 DSH 侧栏打开完整画布页面，数据保存在对应浏览器或 DSH WebView 的本地存储中。
- 通过本地 Canvas Agent 和 MCP，让 DSH Agent 读取与操作当前打开的画布。

## 快速开始

需要 Node.js 22.19+、pnpm 和已安装的 DSH。先构建前端与插件：

```powershell
cd web
npm ci
cd ../plugins/dsh-infinite-canvas
pnpm install --frozen-lockfile --no-optional
node scripts/build.mjs
dsh plugin --profile desktop add "link:<本机插件目录的绝对路径>"
```

重新启动 DSH 后，在侧栏打开「无限画布」。要让 DSH Agent 操作画布，还需启动本地 Canvas Agent，并在画布的 Agent 连接设置中填入其 Local URL 和 Connect token。完整的安装、打包、数据说明见 [DSH 插件文档](plugins/dsh-infinite-canvas/README.md)。

独立运行原应用的方法和功能说明见 [项目文档索引](docs/index.md)。模型接口与 API Key 由浏览器前端配置并直接请求；本地画布数据不会自动与 DSH 会话或其他浏览器来源同步。

## 来源与许可

上游项目：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)。许可证见 [LICENSE](LICENSE)。
