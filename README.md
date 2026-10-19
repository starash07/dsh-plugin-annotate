# dsh-quote-reply · 划词引用回复

给 DeepSeek Harness **桌面客户端**（Electron）加一个 Codex 风格的“划词引用”：在助手回复里选中一段文字，右键「❝ 在此回答」，写下你的注释；发送消息时注释会跟着一起发出去，并在气泡里以「胶囊 + 小字注释 + 细线 + 正文」的形式呈现。

> 本项目基于 [mar1259/dsh-plugin-codex-annotate](https://github.com/mar1259/dsh-plugin-codex-annotate)（MIT）修改而来。原作者的引用定位、菜单与消息格式设计是基础；下面的改动都围绕 **DSH 桌面端**的兼容性与交互体验。

## 与原版的差异

1. **换了包名/模块 id**（`dsh-plugin-codex-annotate` → `dsh-quote-reply`）。
   原包名在桌面 profile 里客户端模块始终不注册（宿主已启用，但插槽为空），换名后同样的代码即可正常加载。
2. **发送时自动带上注释**。
   原版需要点胶囊面板里的「发送」才会拼入引用；现在拦截输入框的 **Enter** 和**主发送按钮**，先拼入引用再走宿主自己的提交，所以正常发送即可。
3. **引用块置于消息最前**。
   引用在前、对话正文在后，气泡里胶囊就在顶部。
4. **气泡内分栏显示**。
   发送后的用户气泡渲染为：`[❝ N 条注释]` 胶囊（点击展开引用原文）+ 小号斜体注释文字 + 一条细线 + 对话正文。
   注释与正文之间用一个不可见分隔符（U+2063）切分；消息内容本身保持普通文本，模型看到的是正常排版。
5. **移除了 `dsh.client.inject` / `immediately` 声明**。
   桌面端加载更稳（排查过程中发现这两个字段并非必需）。

## 安装

要求：DeepSeek Harness 桌面客户端（或 `dsh web`，但本插件主要针对桌面端验证）。

```bash
dsh plugin --profile desktop add github:starash07/dsh-quote-reply
```

安装后重启桌面客户端。卸载：

```bash
dsh plugin --profile desktop remove dsh-quote-reply
```

## 使用

1. 在助手回复里选中一段文字
2. 右键 →「❝ 在此回答」
3. 写下你的注释，回车确认（弹窗内的回车是确认，不会发送消息）
4. 输入框旁出现 `📎 N 条注释` 胶囊；继续划词可以累积多条
5. 正常打字，按 **Enter** 或点**发送按钮** —— 注释会随消息一起发出

点胶囊可以展开当时引用的原文（含消息 id、轮次、段落与字符区间）。

## 已知限制

- 插件依赖客户端内部结构（`data-chat-flow-kind`、`data-composer-card`、主发送按钮的 DOM 特征、气泡文本节点）。DSH 升级后可能需要适配。
- 气泡里的分栏是**显示层**的 DOM 后处理，消息文本本身仍是普通引用块；模型看到的是文本，不是胶囊。
- 逐条删除没有原版的列表方便：注释文字已经是消息的一部分。
- 仅验证于 DSH 0.2.1-rc.2 桌面端（Electron 44）。
- **包清单请保持最小**：`exports` 只保留 `"."`、`"./client"`（和 `"./package.json"`）。额外声明（例如 `"./locale/*.json"`、`"./icon"`）会导致桌面端客户端加载器**不注册该模块**——宿主显示已启用，但插槽里没有注册。

## 许可与致谢

- 原项目：[mar1259/dsh-plugin-codex-annotate](https://github.com/mar1259/dsh-plugin-codex-annotate)，MIT，作者 mar1259。
- 本仓库的修改由 starash07 完成，同样以 MIT 发布；`LICENSE` 保留原作者版权声明。
