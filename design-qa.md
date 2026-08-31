# Design QA — attachment and command panel width

- Source visual truth: `C:\Users\CHJ19\Documents\ChatGPT\dsh插件\.codex-remote-attachments\01a02ad3-78c6-7703-9bb8-66725af3a172\6873f4fe-4522-4482-bcc9-b7fdcb593653\1-Photo-1.jpg`
- Implementation screenshot: `C:\Users\CHJ19\Documents\ChatGPT\dsAPP\liquid-glass-ai-chat-android\qa-attachment-card-narrow.png`
- Combined comparison: `C:\Users\CHJ19\Documents\ChatGPT\dsAPP\liquid-glass-ai-chat-android\qa-attachment-card-width-comparison.png`
- Viewport: 375 × 814 CSS px, device scale factor 1.
- Source pixels: 590 × 1280, normalized to 375 × 814 for comparison.
- Implementation pixels: 375 × 814.
- State: chat open, attachment/DSH command panel open.

## Findings

- No actionable P0/P1/P2 mismatch remains for the requested width change.
- The panel changed from the previous near-full width (347 CSS px) to 232 CSS px, approximately two thirds of the original width.
- The left edge remains aligned at 14 CSS px with the composer controls; the right side now leaves clear page space instead of spanning the screen.
- The upload row, divider, three command rows, scrolling, rounded corners, and elevation remain intact.
- Long command descriptions continue to truncate/marquee inside the reduced text column rather than expanding the card.

## Fidelity surfaces

- Fonts and typography: existing HONOR Sans stack, weights, sizes, and row hierarchy were preserved.
- Spacing and layout rhythm: only horizontal card sizing changed; vertical rhythm, row height, padding, radius, and bottom anchoring were preserved.
- Colors and visual tokens: no color, shadow, border, or state-token changes.
- Image quality and asset fidelity: existing supplied raster/icon assets remain unchanged and sharp at the narrower width.
- Copy and content: upload and DSH command labels/descriptions are unchanged.

## Interaction checks

- Opened a recent conversation and opened the plus menu.
- Measured the rendered panel at x=14, y=497, width=232, height=247 CSS px.
- Confirmed the panel is visible inside the 375 × 814 viewport with no horizontal overflow.
- No page errors were recorded during the interaction pass.

## Focused comparison

- A separate crop was not needed because the attachment card remains fully readable at 1:1 scale in the combined 750 × 814 comparison image.

## Comparison history

- Initial source evidence showed the 347 CSS px near-full-width card identified by the user as too wide.
- Fix: replaced the right anchor with a fixed responsive width of 232 CSS px while preserving the 14 CSS px left anchor.
- Post-fix evidence: `qa-attachment-card-width-comparison.png` shows the requested one-third reduction without a height or content regression.

final result: passed

## Settings page visual pass (2026-08-28)

- Formal Android settings assets were updated in `app/src/main/assets/index.html` and `app/src/main/assets/styles.css` to match the supplied HONOR reference proportions without changing the page structure or interaction logic.
- The browser preview was checked at 412 × 892 CSS px after the final pass. The captured implementation shows matching card edges, airy device-card spacing, aligned device columns, lighter shadows, a thinner connection line with equal dots, and the restored `</>` icon.
- Update-check feedback and the settings back action were exercised; the settings view still returns to the home view.
- Release build verification: `assembleRelease` succeeded after a clean rebuild. The APK includes `assets/styles.css`, `assets/index.html`, and `assets/icons/code-square.svg`.
- Release version correction: the previously published baseline was 185; this historical settings pass was published as `versionCode 186` / `versionName 1.10.88`.

Latest settings result: passed (browser visual pass; real-device screenshot still requires a connected phone).

## API/Remote separation and typography pass (2026-08-29)

- API 项目现在由 `magic5-chat` 自己管理：侧栏“项目”打开 API 项目列表，新建项目后进入独立的 API 项目会话页；不会再跳转到 Remote iframe。
- API 项目聊天只从项目页进入，普通 API 聊天仍保留在最近聊天；项目聊天不会出现在最近聊天。
- API 上下文卡片已改为 Remote 同款的单列行式布局，只保留“上下文剩余 / 本对话 token / 本轮费用”三项；模型和思考等级弹层已按按钮分别显示。
- 新增三个独立的 Image 2 透明 PNG 图标：`magic5-chat/icons/context-remaining-generated.png`、`conversation-tokens-generated.png`、`conversation-cost-generated.png`，不与 Remote 工具图标混用。
- Remote 首页仅移除“最近”列表和项目标题右侧进入箭头，HONOR、MagicBook、电脑图标已恢复；Remote 项目/设备逻辑未改动。
- 字体与图标规则已固化到 `remote-ui-typography-standard.md`，后续 UI 修改先按该规范校对。
- 浏览器验证：API 项目页与 Remote 首页分别可达；API 项目页无 MagicBook/Remote 设备副标题；上下文三项为纵向单列；模型/思考等级内容互不串台；Remote 首页保留 HONOR、MagicBook 和项目列表且不显示最近会话。
- Remote 首页复核后恢复了 HONOR、MagicBook 与电脑图标；“最近”列表与项目标题右侧进入箭头均已移除。
- Release build verification for that pass: `publishRelease` succeeded; the package was `versionCode 203` / `versionName 1.11.5`.

Latest API/Remote result: passed (browser visual and interaction pass; real-device screenshot still requires a connected phone).

## Icon consistency and gap-closure pass (2026-08-30)

- Remote icon audit established the shared rule: 16/24 viewBox line glyphs, `#151719`, round caps/joins, 20px menu glyphs, 46px menu rows, 25px popover radius, and low white-surface shadow.
- API feature rows now use the same menu geometry and weights as Remote; project action uses `add-folder.svg`, project lists use `folder2.svg`, archive uses the shared red `archive-red.svg`, and both file actions use the Image 2 document glyph instead of a photo/file-image glyph.
- The three API context metrics were regenerated as a matched Image 2 set with transparent backgrounds and equal 20px presentation size.
- API project search/new-chat controls now reference the root shared `search.svg` and `new-chat.svg`; no missing `magic5-chat/icons` references remain in the project pages.
- Remote Home's removed Recent block is now removed from the render/listener path as well as the HTML, preventing accidental reintroduction; the fallback device label is MagicBook so the restored device row remains stable without a bridge snapshot.
- Modern Remote/API typography weights were normalized to 400/500/600/700 (decorative plus glyphs remain intentionally light), matching `remote-ui-typography-standard.md`.
- A long-term software UI requirements document was added at `software-ui-requirements.md`; it is now the execution checklist for page boundaries, typography, interaction and asset usage.
- The API sidebar now exposes a blue “新建对话” button immediately to the left of the settings button, using the shared `new-chat.svg` asset and creating an ordinary (non-project) API conversation.
- `node --check` passes for both app entry scripts; `publishRelease` succeeded for versionCode 208 / versionName 1.12.0 after the document/project icon and new-chat entry correction.

## Remote return and project-list alignment pass (2026-08-30)

- Independent UI review (fresh subagent, screenshot-driven) confirmed that a project opened from Remote Home must return to that same Home surface, while the dedicated project catalog keeps its own return target. The root Remote view now records `projectOrigin` and routes the project back button/system back to the correct destination; the embedded shell remains a single Remote iframe.
- Remote and API project rows now share the same rhythm: 78px minimum row height, 58px folder tile, 31px folder glyph, 20px title, 18px date line, and 400/600 weights. This removes the vertical baseline drift between the project title and folder rows.
- API feature-menu glyphs are optically normalized to a 22px line-icon box; document/search use 23px and delete uses 24px while retaining the same 46px row hit area, 16px inset and 16px text gap. File, project and photo semantics remain separate.
- Browser regression: Remote Home → first project → project chat → back returns to Home (`homeView` visible, `projectsView` and `projectView` hidden); shell still contains exactly one `remoteView`.
- Release target for this pass: versionCode 211 / versionName 1.12.3. Real Magic5 Pro installation remains pending a connected device.

## File/search glyph refinement (2026-08-30)

- Screenshot review found the previous bitmap document glyph had too much transparent padding, making “已上传文件” look lighter and smaller than the neighboring menu actions.
- Replaced both API file references with the new resource-library SVG `icons/file-document.svg` (24px viewBox, 1.9px rounded dark stroke). The search glyph was redrawn in the same line system with a 2.1px rounded stroke in the shared `icons/search.svg` asset.
- The menu keeps the same 46px row hit area and 16px text gap; file/search render at 23px and delete remains the slightly larger 24px danger glyph. No Image 2 asset was needed because the repository’s native vector asset system can preserve exact geometry at every device density.

## API action icon family refresh (2026-08-30)

- The folded A4/document glyph and the previous thin mixed-style action set were rejected. The API attachment and feature actions now use the selected Image 2 candidate's six transparent PNGs in `icons/menu-generated/` at 20px: pin, project, paperclip, search, archive and trash.
- The user's approved Remote icon group (compact black solid/strong-line computer, tool and conversation glyphs) is the visual reference. Archive and delete keep the existing red danger state while matching the same optical weight.
- MagicBook/computer and project-list folder assets are untouched. APK packaging remains deferred until the user reviews the browser preview.

## Selected settings and conversation icon sets (2026-08-30)

- The user selected the second update/download/version candidate and the first copy/rename/context/token/cost candidate. They are cropped to transparent 128×128 PNGs under `app/src/main/assets/icons/settings-generated/`, `menu-generated/`, and `context-generated/`.
- Remote and the compatibility copy now use the shared generated copy/rename/pin/archive assets; the API context card uses the shared token/cost assets plus a live CSS context ring. Existing MagicBook, phone, folder, project, paperclip and photo assets remain unchanged.
- The settings update control swaps from `settings-generated/update.png` to `settings-generated/download.png` when the Bridge reports `update-available`; the current-version card uses `settings-generated/version.png`.
- Browser verification passed: Remote chat menu icons loaded at 20px; API context metrics loaded at 20px; settings update/version assets loaded at 128px source resolution and scaled by CSS. APK publication remains deferred until the user completes visual review.
- API 壳“上下文用量”顶部入口和卡片首行现共用实时圆环：按已用 token ÷ 上下文上限绘制，圆环与进度条同步更新；展开卡片不会再把圆环重置为固定 12%。
- Remote/API 聊天更多菜单的生成 PNG 统一按 26px 外框呈现，以补偿透明边距后与 Remote 上下文图标的实际可见尺寸一致；API 侧栏的“项目 / Remote”收至 17px 文字与 23px 图标，Remote 首页的设备、项目及会话层级相应微调。
- 设置中的检查更新／下载更新按钮在检查、开始下载和下载进度状态中会旋转并禁用，完成、发现新版本或报错后自动停止并恢复可点击状态；该状态同时同步给 API 壳设置页。

## 群聊设置接入视觉复核（2026-08-30）

- Source visual truth: `C:\Users\CHJ19\AppData\Local\Temp\codex-clipboard-07052dd8-c802-434f-9b64-fdd557c49f74.png`
- Normalized source: `C:\Users\CHJ19\Documents\ChatGPT\dsAPP\liquid-glass-ai-chat-android\qa-group-settings-source-normalized.png` (375 × 814)
- Implementation evidence: `C:\Users\CHJ19\Documents\ChatGPT\dsAPP\liquid-glass-ai-chat-android\qa-group-settings-implementation-final.png`
- Combined comparison: `C:\Users\CHJ19\Documents\ChatGPT\dsAPP\liquid-glass-ai-chat-android\qa-group-settings-comparison-final.png`
- Viewport: 375 × 814 CSS px target; browser iframe measured 374 × 814 CSS px after the native scrollbar gutter.
- State: “项目讨论群” → 更多功能 → 群聊设置。

## Findings

- The group menu now exposes 群聊设置 only for group conversations; ordinary API/Remote chats do not receive the entry.
- The page is a full-screen white surface with centered title, circular back/more controls, rounded AI 成员 card, two member sections, row dividers, and a black 保存 action matching the supplied reference.
- Final layout measurement after fonts settled: card bottom 709.06px, 保存 top 742.71px, 保存 bottom 790.23px; this matches the normalized reference spacing and leaves the same lower safe-area breathing room.
- No actionable P0/P1/P2 visual mismatch remains.

## Interaction checks

- Opened the sidebar, selected “项目讨论群”, opened 更多功能, and entered 群聊设置.
- Tapped a member’s 模型 row; the editor bottom sheet opened with model choices and cancel/save actions.
- Selected `deepseek-reasoner`, saved the editor, and confirmed the page-level 保存 returns to the group chat with the “群聊设置已保存” status.
- Back button, Escape/system back handling, model/思考程度/提示词 rows, and the hidden editor overlay were wired and exercised.
- `node --check app/src/main/assets/magic5-chat/app.js` and `git diff --check` pass.

## Fidelity surfaces

- Fonts and hierarchy use the existing HONOR Sans stack and the supplied black/gray typography rhythm.
- Model, thinking, and prompt icons are transparent raster crops from the supplied reference, presented in one shared 27px optical box.
- Header controls, separators, rounded card, bottom blank space, and black save button preserve the existing Magic5/API/Remote surface language.

## Console note

- The preview console reported one `MutationObserver.observe` TypeError from the outer preview wrapper. No `MutationObserver` call exists in the repository’s `magic5-chat` code; the app page remained interactive and the error did not block the verified flow.

## Comparison history

- Initial pass used generic cube/brain/pencil assets and a tighter card-to-save gap.
- Post-fix pass extracted the supplied reference glyphs, normalized their transparent bounds, and tuned the card’s lower whitespace/save spacing. The final DOM measurements above were rechecked after the adjustment.

final result: passed

## Selected group-settings model/thinking icon pair (2026-08-30)

- Source visual truth: `C:\Users\CHJ19\AppData\Local\Temp\codex-clipboard-a45082a5-a719-47e9-bef7-ea8d06ed005b.png`
- The selected pair was isolated from the supplied transparent sheet and written to `app/src/main/assets/icons/group-settings-generated/model.png` and `thinking.png` at 64 × 64 source resolution.
- The prompt/pencil asset was intentionally left unchanged; only the two icons the user selected were replaced.
- The page references now use `?v=group-settings-v2` for the model/thinking assets, preserving the existing 27px rendered optical box.
- Browser verification: the group menu reaches 群聊设置, both new assets load at 64 × 64 natural size and 26.99px rendered size, and the model/thinking rows remain interactive.
- No backend code was changed in this selection pass.

final result: passed
