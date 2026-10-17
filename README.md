# opencode-diff-review

给 **OpenCode v2** 用的「AI 改了什么」逐文件查看与撤回插件。

AI 每写一次文件，插件就会在写入前保存一份原始内容快照。于是你可以随时：

| 需求 | 做法 |
| --- | --- |
| **快速查看** | `ctrl+shift+r` 或 `/diff-review` 打开 IDEA 风格双栏页，按改动块浏览，可打字过滤文件 |
| **同意 / 不同意** | 每块中间列有两个可点的箭头：`✓ 同意`（保留并前移基线）/ `✗ 不同意`（还原这块）；顶部工具条同样有块级、文件级、全部级的同意/不同意 |
| **逐行处理** | 块上按 `⋮`，或页面内 `ctrl+shift+j/k` 选块后操作；不同意时也可以只挑其中某几行 |
| **单文件撤回** | 左侧文件树每行末尾的 `↺`，把文件恢复到 AI 第一次改它之前 |
| **全部撤回** | 工具条 `✗不同意全部`，一条命令把所有被 AI 改过的文件还原 |
| **查看 diff** | 左栏是 AI 修改前，右栏是当前，行号左右对齐，删除行与新增行按改动块配对显示 |

> 只依赖 OpenCode 自身，不需要 git 仓库，也不会动你的 `git index`。

> **第一次安装？看 [教程.md](教程.md)**（10 分钟：装 → 验收 → 第一次实战）。
> **想了解每个界面细节？看 [使用文档.md](使用文档.md)**（面板操作、配置、排错、卸载）。
> 本文件面向开发与安装方式说明。

---

## 1. 它是怎么工作的

```
AI 调用 write/edit/patch
        │
        ├─ execute.before ──► 快照文件当前内容（每个文件只存第一次）
        │
        └─ execute.after  ──► 读回新内容，和快照比对
                              相同 → 忽略（读文件之类的工具不会污染列表）
                              不同 → 进入待撤回列表
```

撤回时：

- 修改过 → 把**首次快照**写回文件（所以改 10 次也只还原到动手前的状态）
- AI 新建的文件 → 直接删除
- AI 删掉的文件 → 把快照写回

只撤其中一块或一行时，不是靠快照覆盖，而是**反向应用选中的 diff 行**：
`add` 行删除、`del` 行恢复、未选中的行原样保留，然后整份文件按原换行风格写回。
选中的行覆盖了全部改动时，退化为整文件还原，直接写回首次快照。

快照写到 OpenCode 数据目录下的自有仓库，**不进项目工作区**：

```
~/.local/share/opencode/opencode-diff-plugin/v1/<project hash>/<path hash>.json
```

每个文件一条独立记录，服务端只负责采集写入，面板进程直接读同一份数据。

---

## 2. 安装

**最省事的一条命令**（OpenCode v2 自带的能力，装完 `opencode2 plugin list` 能看到 `opencode.diff.tracker`）：

```powershell
opencode2 plugin add git@github.com:wuwei-apc/opencode-diff-review.git
```

它会拉取仓库、装进 OpenCode 缓存目录，并在全局 `opencode.json` 里加一条 git 地址；
升级 `opencode2 plugin update`，卸载 `opencode2 plugin remove git@github.com:wuwei-apc/opencode-diff-review.git`。
这种方式只能用默认选项——要改快捷键、上限等，用下面的配置引用方式。

完整的安装/验收教程见 [教程.md](教程.md)。

插件由两个入口组成，必须放在同一个目录里：

- `index.ts` — 服务端插件，负责采集（`tool.hook`）
- `tui.ts` — 终端面板，负责界面与快捷键

两者通过**磁盘上的共享仓库**交换数据，不依赖插件 RPC，所以**缺一不可**。

### 方式 A：放进插件目录（零配置）

OpenCode 会自动发现 `~/.config/opencode/plugins/<任意目录名>/`（项目级则是 `.opencode/plugins/`）：

```powershell
# 解压发布包（见第 8 节）到全局插件目录
Expand-Archive .\opencode-diff-review-2.0.0.zip -DestinationPath $env:USERPROFILE\.config\opencode\plugins\
```

```bash
# 或者直接 clone
git clone git@github.com:wuwei-apc/opencode-diff-review.git ~/.config/opencode/plugins/opencode-diff-review
```

最终结构：

```
~/.config/opencode/plugins/opencode-diff-review/
├── index.ts        ← 服务端入口（必须有）
├── tui.ts          ← TUI 入口（必须有）
├── package.json
└── src/
```

只要目录里同时有 `index.ts` 和 `tui.ts`，服务端与面板会被一起加载，选项取默认值。

### 方式 B：显式写进配置

把仓库放在任意位置，然后在 `opencode.json` 里显式引用（这样还能配选项）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "D:/tools/opencode-diff-review",
      "options": {
        "keybind": "ctrl+shift+r",
        "slash": "diff-review"
      }
    }
  ]
}
```

配置里出现一次的插件，如果同时带有 TUI 组件，CLI 会自动加载它，不需要在别处重复声明。

### 关于依赖

本地插件目录**不会**自动安装依赖，但 `@opencode/plugin`、`@opencode/plugin/tui`、`solid-js`、`@opentui/solid` 都由 OpenCode 运行时自带并解析，正常情况下你什么都不用装。

只有要自己跑类型检查 / 测试时才需要：

```bash
npm install        # 或 bun install，装 devDependencies
```

---

## 3. 使用

| 入口 | 说明 |
| --- | --- |
| `ctrl+shift+r` | 默认快捷键 |
| `/diff-review` | 斜杠命令（可改名，见配置） |
| 命令面板搜索「查看 / 撤回 AI 文件变更」 | 同上 |

### 页面结构

```
 ┌ ▲ ▼ 块 1/3  ✓同意块  ✗不同意块 │ ✓同意全部  ✗不同意全部 │ ⟳刷新  ⏻退出(Esc) ┐
 │ 文件 3           │          AI 修改前            │ → │        当前          │
 │ M  src/app.ts ↺✓ │  - 12  const x = old()       │ ✓ │ + 12  const x = next() │
 │ A  src/util.ts ↺✓│  - 40  return data           │ ✗ │ + 40  return rows      │
 │ …                │  …                           │   │  …                     │
 └ 共 932 行 · 块 1/3 · > 同意 · < 不同意 · 滚轮 / ctrl+shift+u d 滚动 · Esc 退出 ┘
```

中间那一列既是分隔线也是操作面：每个改动块的前两行分别是 `✓`（同意这块）和 `✗`（不同意这块），鼠标可点。
左栏文件树每行末尾是 `↺`（撤回整个文件）和 `✓`（保留整个文件 = 停止追踪）。

### 快捷键（页面内）

| 键 | 作用 |
| --- | --- |
| `ctrl+shift+j` / `ctrl+shift+k` | 下一块 / 上一块 |
| `ctrl+shift+f` / `ctrl+shift+v` | 同意这块 / 不同意这块（逐行模式下只作用于选中行） |
| `ctrl+shift+o` / `ctrl+shift+p` | 下一个文件 / 上一个文件 |
| `ctrl+shift+w` / `ctrl+shift+x` | 同意整个文件 / 不同意整个文件 |
| `ctrl+shift+u` / `ctrl+shift+d` | 向上 / 向下滚动（鼠标滚轮也可以） |
| `ctrl+shift+q`、`Esc` | 退出页面回到对话 |

状态前缀：`M` 修改、`A` 新增、`D` 删除、`?` 基线缺失（不可撤回）。

### 没有 `ui.router` 的构建

老一些的 v2 构建不能内嵌页面，这时同一个入口会自动退化成 `dialog.select` 列表（文件 → 改动块 → 行），
同意/不同意、撤回整个文件、撤回全部都在里面，功能不丢，只是没有双栏视图。

---

## 4. 配置项

服务端选项（和 TUI 选项写在同一个 `options` 对象里）：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `maxFileBytes` | `2097152`（2 MiB） | 单文件快照上限；超过的文件会显示在列表但**不可撤回** |
| `contextLines` | `3` | diff 上下文行数 |
| `maxLines` | `600` | diff 文本最多渲染多少行 |
| `trackTools` | `[]`（全部） | 只跟踪这些工具名，例如 `["write", "edit", "patch"]` |
| `pendingTTLMs` | `600000` | 单次工具调用的待配对快照保留时长 |

TUI 选项：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `keybind` | `"ctrl+shift+r"` | 快捷键；不想用就设成 `""`，只留 `/diff-review` |
| `slash` | `"diff-review"` | 斜杠命令名 |
| `confirmRevert` | `true` | 撤回前二次确认 |
| `viewLines` | `400` | diff 视图一次最多展示多少行 |

---

## 5. 覆盖范围与已知限制

- **只跟踪文件类工具的写入**（`write` / `edit` / `patch` / `apply_patch` 及其变体）。通过 `bash` 里的重定向、`sed -i`、代码生成脚本产生的改动无法归因到具体文件，因此**不在本插件范围内**。
- **每个文件默认 2 MiB 上限**。超限的文件仍会出现在列表里，但会标记「无法撤回」，撤销时**绝不会**去删或写它。
- **二进制文件可以撤回**，但 diff 视图只提示「二进制文件」。
- **状态在磁盘上**：快照写到 OpenCode 数据目录（见第 1 节），因此重启 opencode 后列表仍在；
  记录超过 7 天未被触碰会自动清理。
- 忽略 `node_modules`、`.git`、`.hg`、`.svn` 下的路径。
- 所有路径都会被限制在会话目录内，越界路径直接丢弃。

### 和内置 `/undo` 的关系

两者互补，不冲突：

| | 内置 snapshots / `/undo` | 本插件 |
| --- | --- | --- |
| 粒度 | 整个对话边界 | 单个文件 |
| 依赖 | 需要 git worktree | 不依赖 git |
| 持久化 | 跨重启（git 对象库） | 跨重启（自有数据目录） |
| 适合 | 「把刚才那轮全部退回去」 | 「只撤掉这个文件」 |

---

## 6. 排错

**列表一直是空的**
先确认服务端在采集：

1. `opencode2 plugin list` 能列出 `opencode.diff.tracker`；
2. `%TEMP%\opencode-diff-plugin\diag.json` 里 `stage` 为 `ready`、`hooksRegistered` 为 `true`、`selfTest.ok` 为 `true`；
3. 数据目录里有条目：`~/.local/share/opencode/opencode-diff-plugin/v1/<hash>/`。

> `opencode2 api get /api/plugin` 在 2.0.32 上对本插件恒返回空数组，**不要**用它判断是否加载成功。

**安装命令报 `Invalid global configuration`**
`opencode.json` 写坏了（多余逗号、BOM、编码不是 UTF-8）。先 `opencode2 debug config` 确认能解析，再重试。

**Plugins 面板里 `TUI` 是 failed（`react` 或 `@opentui/solid` 找不到）**
≤ 1.0.1 的打包安装才会这样：`src/diffview.tsx` 的 JSX 被按 React 编译。Bun 只从**当前工作目录**读
`tsconfig.json`，插件自己目录里的那份不会被采用，所以从 1.0.2 起改用逐文件 `/** @jsxImportSource @opentui/solid */`。
升级：`opencode2 plugin update`。

**快捷键按了没反应**
和本机已有的 keybind 冲突，换个键（例如 `"keybind": "ctrl+shift+y"`），或者直接用 `/diff-review`。

**列表是空的，但文件确实被改过**
那次写入多半不是通过文件工具完成的（例如 shell 命令），或者文件超过了 `maxFileBytes`。

**某个文件没有「撤回此文件」**
该项是灰的，说明没保存到修改前的基线（超限或被跳过）。可以选择「停止追踪」把它从列表里去掉。

**安装的 OpenCode 用的是 `@opencode-ai/plugin/v2` 入口而不是 `@opencode/plugin`**
两套入口在 v2 beta 期间并存过。如果你的版本只认前者，把这两个 import 换掉即可
（数据通路已经不走 RPC，所以没有第三个 import 要改）：

| 文件 | 改成 |
| --- | --- |
| `src/server.ts` | `import { Plugin } from "@opencode-ai/plugin/v2"` |
| `src/tui.ts` | `import { Plugin } from "@opencode-ai/plugin/v2/tui"` |

---

## 7. 开发

```bash
bun test               # 单元测试（diff / paths / tracker / layout / tree）
bun run smoke          # 入口冒烟：真实加载 index.ts + tui.ts，跑一遍采集→diff→撤回
bunx tsc --noEmit      # 类型检查
npm run check          # 上面三件事一起跑
```

`bun test` 用的是 `node:test` + `node:assert/strict`，所以 `bun test` 和 `node --test` 都能跑；
如果你的 Bun 版本对 `node:test` 支持不完整，把测试文件顶部两行换成 `bun:test` 即可。
它不需要安装 `@opencode/plugin`：只有两个入口文件 import 它，单元测试不碰。
`bun run smoke` 才会真的加载两个入口，所以要先 `npm install`（装 devDependencies 里的
`solid-js` / `@opentui/solid` 供 JSX 与类型使用）。

代码结构：

```
index.ts              服务端入口（转导出 src/server.ts）
tui.ts                TUI 入口（转导出 src/tui.ts）
src/contracts.ts      我们实际用到的 v2 插件 API 结构 + 单点类型断言
src/options.ts        两端共享的选项解析（保证快照上限一致）
src/store.ts          磁盘仓库：每条变更一个 JSON，原子写入
src/paths.ts          工具参数 → 路径，路径越界防护
src/snapshot.ts       快照读写、二进制识别
src/diff.ts           LCS 行级 diff、unified hunk 渲染（有复杂度上限）
src/tracker.ts        变更追踪 + 撤回语义（无状态，读写仓库）
src/server.ts         tool hooks：采集前/后镜像
src/tui.ts            面板命令、快捷键、页面控制器
src/diffview.tsx      IDEA 风格双栏页（Solid JSX，走 ui.router）
src/layout.ts         页面栅格宽度、中间操作面的单元格
src/tree.ts           文件树标签截断与图标列
src/rpc.ts            旧 RPC 契约的兼容再导出（当前数据通路是磁盘）
src/types.ts          面板与追踪器共享的载荷类型
src/selftest.ts       启动自检：真实跑一遍采集→diff→按块/按行撤回
src/diagnostics.ts    启动自检落盘（排错用）
scripts/smoke.ts      入口冒烟脚本（bun run smoke）
test/                 bun test 单元测试
```

设计上有意为之的几点：

- **钩子里全部用同步 I/O**，不依赖宿主是否 await 异步钩子，避免读到写了一半的文件。
- **捕获失败宁可不记**：读不到当前状态时直接跳过，绝不用「文件不存在」去猜，否则撤回可能误删文件。
- **进程间不共享内存，也不依赖 RPC**：状态放在磁盘仓库里，两个进程各读各写，
  契约只是文件系统。v2 的 `client.rpc()` 在 CLI 侧会拒绝定义对象（`RPC is unavailable`），
  这条路已经放弃。
- **v2 插件 API 仍是 beta**：`src/contracts.ts` 把依赖面收窄成一个小接口，其他文件不直接碰 SDK 类型，升级时只改一处。
- **页面是可选能力**：拿不到 `ui.router` 时自动退化成 `dialog.select` 列表，面板不会因此失效。

---

## 8. 发布包

```bash
bun run package        # npm pack → dist/opencode-diff-review-2.0.0.tgz
```

`npm pack` 会按 `package.json` 的 `files` 打包：`index.ts`、`tui.ts`、`src/`、`README.md`、
`使用文档.md`、`教程.md`、`LICENSE`。解包后即可作为插件目录使用（`tar -xzf …` → `~/.config/opencode/plugins/`）。

GitHub Release 里同时提供同名 `.zip`，内容相同，适合直接解压后丢进 `plugins/` 目录。

## License

MIT

