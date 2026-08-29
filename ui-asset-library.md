# DSH Remote / DeepSeek UI 资产库

> 盘点日期：2026-08-30  
> 盘点范围：`app/src/main/assets/index.html`（Remote）、`app/src/main/assets/magic5-chat/`（DeepSeek API 壳）、`app/src/main/assets/magic5/`（旧兼容副本）。本文件只记录资产与引用规则，不替代页面功能说明。

## 1. 使用规则

### 1.1 唯一来源

- Remote 的公共图标唯一主库为 `app/src/main/assets/icons/`。
- `magic5-chat` 是嵌入式 API 壳。品牌专属素材（DeepSeek 字标、菜单按钮）可以放在 `magic5-chat/icons/`；公共图标统一引用 `../icons/`，不要再从 `magic5-chat/icons/` 复制一份。上下文剩余使用 CSS 实时圆环，不再维护静态图标副本。
- `magic5/` 是旧页面/兼容副本，不是新页面的设计来源。若仍需维护它，公共图标要与主库逐项同步；禁止从该目录反向引用。
- `icons/folder-dsh.svg` 与 `icons/folder2.svg` SHA-256 完全相同，视为同一资产；新代码只使用 `folder2.svg`，`folder-dsh.svg` 保留为兼容别名。

### 1.2 Remote 风格基线

Remote 现有菜单图标是低对比、黑色、扁平的 iOS/macOS 线性/几何图标：

- 普通前景使用 `#151719` 或 `#111111`，次要图标使用 `currentColor`，搜索图标使用 `#5c6268`。
- 16×16 图标通常采用 `viewBox="0 0 16 16"`，线宽约 `0.68–0.85`（按图标实际视觉粗细调整）；24×24 导航/设备图标使用圆角线端和圆角连接。
- 更多功能菜单统一：图标显示 20×20px，行高至少 46px，左右内边距 16px，图标与文字间距 16px，弹层圆角 22–25px，使用轻阴影。
- 项目列表使用统一文件夹素材，不因项目名称改变图标；项目图标底板约 56–58px、圆角 17–18px，底板 `#f1f1f1`。
- 图标必须有透明背景、无发光、无渐变、无文字。没有合规资源时才使用 Image 2 生成，并用用途命名、单独入库。

## 2. 活跃页面资产映射

### 2.1 设备、品牌与项目

| 语义 | 唯一素材 | 当前页面/引用 | 默认显示尺寸 | 规则与结论 |
| --- | --- | --- | ---: | --- |
| MagicBook / 电脑 / Remote | `icons/laptop-with-cursor.svg` | Remote 侧栏、首页设备行、设置设备卡、项目/聊天元信息；API 壳侧栏与设置 | 14–21px；设备卡等比放大 | 保留黑色屏幕、白色光标、黑色底座；不要用 `laptop.svg` 替代。 |
| 备用普通电脑 | `icons/laptop.svg` | 当前活跃页面未引用 | 20–22px | 仅作备用；新页面默认不用，避免和 MagicBook 图标混淆。 |
| Magic5 Pro / 手机 | `icons/iphone14-pro.svg` | API 壳设置页设备卡 | 54–74px 容器内等比 | 仅代表手机设备，不用于 Remote/项目。 |
| HONOR 品牌 | 页面文字 `HONOR`（不是图标） | Remote/API 设置视觉标题 | 按页面字号 | 不把电脑图标或 DeepSeek 字标冒充 HONOR 标志。 |
| 项目/文件夹 | `icons/folder2.svg` | Remote 项目列表、聊天胶囊项目、API 项目列表/项目详情/新建项目卡 | 列表 21–31px；底板内约 29px | 所有项目列表严格使用同一素材；`folder.svg`、旧副本不再作为新引用。 |
| 添加项目/新建项目 | `icons/add-folder.svg` | 项目页新建项目等项目入口；聊天更多菜单使用 `icons/menu-project.svg` | 20–27px | 项目列表与聊天动作分开；聊天动作使用紧凑实心风格，绝不能用于添加文件。 |
| 新建聊天/聊天 | `icons/new-chat.svg` | API 侧栏底部、Remote 首页、Remote 项目详情、API 项目详情 | 20–29px | 铅笔/新对话语义；`compose.png`、`compose-solid.png` 为旧 PNG，不用于新页面。API 侧栏按钮与设置按钮并排。 |
| 子代理 | `icons/bot.svg` | Remote 项目会话行 | 20–24px | 仅表示子代理身份，不替代普通聊天图标。 |

### 2.2 导航与通用操作

| 语义 | 唯一素材 | 当前显示尺寸 | 备注 |
| --- | --- | ---: | --- |
| 返回 | `icons/arrow-back.svg` | 21–26px | Remote/API 页面通用；API 壳可引用 `../icons/arrow-back.svg`。 |
| 更多 | `icons/more-vert.svg` | 20px | Remote 与 API 壳统一使用；API 壳本地同名副本与主库字节相同，应逐步改成主库引用。 |
| 侧栏菜单 | `magic5-chat/icons/menu.svg` | 22px | API 壳专属，主库目前没有完全相同的菜单素材；若扩展到 Remote，先补入主库再引用。 |
| 设置 | `icons/gear.svg` | 20–22px | API 壳本地副本与主库相同；公共入口统一走主库。 |
| 搜索/聊天中查找 | `icons/menu-search.svg`（菜单）/`icons/search.svg`（输入框） | 20–26px | 菜单使用紧凑粗线风格；输入框继续使用原搜索素材；不要用工具/文件图标代替。 |
| 检查更新 | `icons/settings-generated/update.png` | 17–20px | 用户选定的图二风格版本图标；仅版本更新按钮使用。 |
| 下载更新 | `icons/settings-generated/download.png` | 17–20px | 有新版本时替换检查更新图标；不与发送箭头混用。 |
| 当前版本 | `icons/settings-generated/version.png` | 28–34px | 版本信息卡使用的紧凑版本徽章图标。 |
| 删除 | `icons/menu-trash.svg`（聊天菜单）/`icons/trash.svg`（Remote） | 20–22px | 删除动作使用危险色/危险样式；Remote 原有素材保持不动。 |
| 归档 | `icons/menu-archive.svg`（聊天菜单）/`icons/archive-red.svg`（Remote） | 20–22px | 聊天菜单使用紧凑粗线危险色版本；Remote 原有素材保持不动。 |

### 2.3 聊天更多菜单

| 菜单文字 | 唯一素材 | 当前引用 | 说明 |
| --- | --- | --- | --- |
| 置顶 | `icons/menu-generated/pin.png` | API 壳 `magic5-chat/index.html` | 20px；用户选定的 Image 2 候选九号图组，紧凑黑色实心字形。 |
| 复制会话 ID | `icons/menu-generated/copy.png` | Remote / 兼容副本聊天菜单 | 20px；与图二同套粗线圆角复制字形。 |
| 重命名 | `icons/menu-generated/rename.png` | Remote / 兼容副本聊天菜单 | 20px；与图二同套粗线圆角铅笔字形。 |
| 添加到项目 | `icons/menu-generated/project.png` | API 壳更多菜单 | 20px；实心文件夹加号只用于项目动作，与添加文件明确区分。 |
| 已上传文件 | `icons/menu-generated/paperclip.png` | API 壳更多菜单 | 20px；粗线回形针语义，不使用 A4 折角或照片图标。 |
| 在聊天中查找 | `icons/menu-generated/search.png` | API 壳更多菜单 | 20px；加粗圆角搜索字形，避免缩小后变细。 |
| 归档 | `icons/menu-generated/archive.png` | API 壳更多菜单 | 20px；紧凑红色危险状态，不加 CSS 反色滤镜。 |
| 删除 | `icons/menu-generated/trash.png` | API 壳更多菜单 | 20px；紧凑红色实心危险状态，与归档共用同一视觉重量。 |

### 2.4 文件、图片与附件

| 语义 | 唯一素材 | 当前显示尺寸 | 结论 |
| --- | --- | ---: | --- |
| 添加文件 / 已上传文件 | `icons/menu-generated/paperclip.png` | 20px | 选定图组拆出的透明 PNG 回形针，按用户认可的 Remote 黑色紧凑图标显示。它的语义是附件文件，不是项目；当前 API 壳两处均指向它。 |
| 与 Remote SVG 的唯一映射 | `icons/file-earmark-diff.svg` | 20–22px | 这是主库中带“差异/加减”语义的文件图标，不能用于普通上传文件；普通文件统一使用 `file-document.svg`。 |
| 添加照片 / 上传照片 | `icons/picture-icons8.png` | 20–22px | 仅用于照片/图片选择。不得用于“添加文件”或“已上传文件”。这是用户认可的黑色紧凑实心风格锚点。 |
| 旧图片文件图标 | `icons/file-image.svg` | 未在活跃入口使用 | 文件名带 image，容易被误解为照片；不用于当前“添加文件”。 |
| 附件按钮（输入栏加号） | `magic5-chat/icons/chat-plus.png`（API 壳）/ `icons/chat-plus.svg`（Remote） | 28–31px | 表示展开附件/命令，不表示添加项目；两个页面保留各自交互，但不要交叉引用。 |
| 消息内图片缩略图 | 用户图片本身（运行时） | 56px 左右 | 这是内容缩略图，不是菜单图标；不要拿它作为附件动作图标。 |

### 2.5 上下文、费用与聊天状态

| 语义 | 唯一素材 | 当前页面/尺寸 | 说明 |
| --- | --- | --- | --- |
| 上下文剩余 | CSS 动态进度圆环 | API 壳上下文卡与顶部入口，20–21px | 根据“已用 token ÷ 上下文上限”实时绘制；30% 已用即显示 30% 环形进度。静态 `context-remaining.png` 只保留为已选风格参考，不再在页面中使用。 |
| 本对话 token | `icons/context-generated/conversation-tokens.png` | API 壳上下文卡，20px | 用户选定的图二风格独立透明图标；名称和用途一一对应。 |
| 本轮费用 | `icons/context-generated/conversation-cost.png` | API 壳上下文卡，20px | 用户选定的图二风格独立透明图标；不可复用总 token 或上下文图标。 |
| Remote 上下文：系统提示词 | `icons/maintenance-icons8.png` | Remote 上下文卡，20px | Remote 既有基线素材；保持原有语义。 |
| Remote 上下文：工具 | `icons/tools-icons8.png` | Remote 上下文卡/工具审批，20–22px | Remote 既有工具图标；不可挪给费用或 Token。 |
| Remote 上下文：对话信息 | `icons/no-chat-icons8.png` | Remote 上下文卡，20px | Remote 既有对话信息图标；API 三项统计不直接复制这三枚。 |
| 思考状态 | `icons/chat-think.png` | Remote 聊天事件，按 20–23px | 当前为旧栅格状态素材，和 Remote 菜单 SVG 不是一类；只用于消息状态。 |
| 搜索/读取/终端事件 | `icons/chat-grep.png` / `chat-read.png` / `chat-terminal.png` | Remote 聊天事件，约 20px | 旧事件状态素材，按事件语义使用，不放入更多菜单。 |
| 工具审批标题 | `icons/tools-icons8.png` | Remote 工具卡，22px | 已修正为实际存在的 Remote 工具素材；不再引用不存在的 `chat-tool.png`。 |

### 2.6 发送、停止与回复

| 语义 | 当前实现 | 风险/下一步 |
| --- | --- | --- |
| Remote 发送箭头 | `index.html` 内联 SVG | 视觉已符合 Remote，但不在资产库中；如要实现“所有图标可盘点”，下一轮可抽出为 `icons/send.svg`。 |
| Remote 正在回复 | `icons/dsh-reply-spinner.png` | 运行时状态动画/位图，不要当静态菜单图标。 |
| Remote 展开附件 | `icons/chat-plus.svg` | 仅表示展开附件/DSH 命令。 |
| API 壳发送 | 当前使用 `icons/arrow-back.svg` 旋转并反色 | 这是语义复用，容易再次造成“返回/发送混用”；建议下一轮生成独立 `icons/send.svg`（24×24、黑底按钮内白色上箭头），保留 `arrow-back.svg` 只作返回。 |
| API 壳回复状态 | 当前以发送按钮状态切换为主 | 若需要动画，继续使用 `dsh-reply-spinner.png`，不要拿 `chat-stop.png` 代替。 |

## 3. 已生成图标登记

这些 PNG 均为透明背景的高分辨率生成源，实际显示尺寸由 CSS 控制，不按 1254px 直接渲染。

| 文件 | 源尺寸 | 实际显示 | 用途 | 状态 |
| --- | ---: | ---: | --- | --- |
| `icons/menu-generated/{pin,project,paperclip,search,archive,trash}.png` | 128×128 透明 PNG | 26px 外框（可见轮廓约 16–20px） | API 聊天更多菜单六项动作 | 当前活跃资源；与 Remote 上下文三枚 20px 基线图标对齐实际可见尺寸，电脑、MagicBook、项目文件夹不变。 |
| `icons/menu-generated/{copy,rename}.png` | 128×128 透明 PNG | 26px 外框（可见轮廓约 16–20px） | Remote/兼容副本聊天菜单复制与重命名 | 当前活跃资源；与 API 菜单使用相同尺寸规范。 |
| `icons/context-generated/{conversation-tokens,conversation-cost}.png` | 128×128 透明 PNG | 20px | API 上下文卡两项统计 | 当前活跃资源；来自用户选定的图二风格候选。 |
| `icons/context-generated/context-remaining.png` | 128×128 透明 PNG | — | 上下文圆环的风格参考 | 静态页面引用已替换为实时 CSS 圆环。 |
| `icons/settings-generated/{update,download,version}.png` | 128×128 透明 PNG | 17–34px | Remote/API 设置版本信息 | 当前活跃资源；检查更新、有更新下载、当前版本三态图标。 |
| `icons/paperclip.svg` | 24×24 viewBox | — | 旧回形针兼容资源 | 已停用，不再作为菜单动作引用。 |
| `icons/paperclip-cropped.png` / `paperclip.png` | 767×767 / 1254×1254 | — | 回形针生成源 | 保留为参考源，页面不直接引用。 |
| `icons/search-menu.svg` / `archive-menu.svg` / `trash-menu.svg` | 24×24 viewBox | — | 旧聊天菜单动作资源 | 已停用；新菜单动作统一使用 `menu-*` 资源，Remote 页面原有电脑/文件夹/菜单逻辑不变。 |
| `icons/file-document.svg` | 24×24 viewBox | — | 旧文件图标 | 已停用，不再用于 API 壳文件动作。 |
| `magic5-chat/icons/context-remaining-generated.png` / `conversation-tokens-generated.png` / `conversation-cost-generated.png` | 1254×1254 | — | 旧上下文图标源 | 保留作兼容参考，页面不再引用。 |

生成资产审核标准：透明背景；单色 `#151719` 附近；无发光/渐变/阴影；缩小到 20px 后轮廓清楚；不得与另一语义仅靠 CSS 滤镜区分。

## 4. 资产缺口与禁止混用

### 4.1 当前缺口

- 主库没有独立 `send.svg`；API 壳目前旋转 `arrow-back.svg`，应作为下一轮独立补齐项。
- 设置页已有独立 `icons/settings-generated/download.png`；其他导出/下载场景仍需单独定义语义，不得临时拿 `arrow-repeat.svg`、`file-document.svg` 或 `new-chat.svg` 顶替。
- 当前没有独立“对话/新建对话”基础图标；新建聊天使用 `new-chat.svg`，聊天内容事件使用 `chat-*.png`。如果以后项目列表需要“聊天”图标，应新建用途明确的 `chat.svg`，不要复用上下文的 `no-chat-icons8.png`。
- `add-folder.svg` 是项目页新建项目的“文件夹+”素材；聊天更多菜单使用 `menu-project.svg`，不得扩展到文件或照片动作。

### 4.2 明确禁止

- 禁止用 `folder2.svg`、`add-folder.svg`、`folder.svg` 表示添加文件。
- 禁止用 `picture-icons8.png`、`file-image.svg` 表示普通文件或已上传文件。
- 禁止用 `tools-icons8.png` 表示费用、Token 或上下文剩余。
- 禁止把 `maintenance-icons8.png`、`tools-icons8.png`、`no-chat-icons8.png` 三枚 Remote 上下文图标原样复制到 API 三项统计中。
- 禁止把 `arrow-back.svg` 同时当作返回和发送的最终资产；API 当前旋转用法只是待替换兼容实现。
- 禁止在 `magic5-chat/icons/` 与 `icons/` 各放一份同名公共图标后再按页面随意选择。

## 5. 修改前后检查表

1. 先确认页面边界：Remote、API 普通聊天、API 项目、设置页不可互相借用交互资产。
2. 在本表按“语义”找唯一素材，不按文件名猜图标；找不到再走 Image 2 生成流程。
3. 检查 20px 缩小后的视觉重量、透明边界、颜色和线端；不要只检查原图大尺寸。
4. 检查添加文件/添加照片/添加项目三者是否一眼可区分。
5. 检查更多菜单的所有行是否统一 20px 图标、46px 行高、16px 间距和同一颜色规则。
6. 检查 Remote 的 MagicBook、HONOR、项目文件夹仍保留，Remote 最近列表的产品逻辑不因换图标被改动。
7. 修改后至少验证：普通 API 聊天、API 项目列表、API 项目聊天、Remote 首页、Remote 项目、Remote 聊天、设置页。
8. 如果新增资产，补充本文件的“已生成图标登记”和映射表，并在代码中只保留一个引用来源。
