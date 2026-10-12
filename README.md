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

重新启动 DSH 后，插件默认进入「我的画布」。生图前会检查会话默认绑定与侧边栏画布，支持选择默认画布、临时使用当前侧边栏或其他画布；首次连接还可新开画布或不连接并进入「生图工作台」。完整的安装、打包、数据说明见 [DSH 插件文档](plugins/dsh-infinite-canvas/README.md)。

独立运行原应用的方法和功能说明见 [项目文档索引](docs/index.md)。模型接口与 API Key 由浏览器前端配置并直接请求；本地画布数据不会自动与 DSH 会话或其他浏览器来源同步。

应用和 DSH 安装包统一以根目录 `VERSION` 管理版本；版本检查读取本仓库的 `VERSION` 和 `CHANGELOG.md`。由我们独立发版，上游更新通过同步分支审查、处理冲突后合并；流程见 [本分支更新与上游同步](docs/content/docs/development/upstream-sync.mdx)。

## 来源与许可

上游项目：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)。许可证见 [LICENSE](LICENSE)。
