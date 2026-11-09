# learning-space — 客户端/宿主契约 v1

> 内部实现约定，供维护者与协作代理使用。不是给 Harness 用户的文档。

## 包结构

```
learning-space/
├── package.json          # @local/learning-space，dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert 一行 id: learning-space
├── index.js              # Host 半：HTTP API + 课程存储 + LLM 生成
├── client.js             # Client 半：sidebar.panellist 图标 + main 面板页面
├── locale/{zh,en}.json   # Plugin Manager 展示元数据
├── icon.svg              # 插件图标
└── README.md
```

## Host HTTP API（由 index.js 注册，浏览器 fetch 调用）

- 基础路径：`/learning-space/api`（exact route，`POST`，请求体 JSON）
- 健康检查：`GET /learning-space/health` → `text/plain` `ok`
- 静态资源：`GET /learning-space/vendor/<path>` → 插件包 `vendor/` 目录下的文件（KaTeX：`vendor/katex/katex.min.js`、`vendor/katex/katex.min.css`、`vendor/katex/fonts/*.woff2`）
- 响应统一：`{ ok: true, ... }` 或 `{ ok: false, error: { code, message } }`
- 成功时 HTTP 200；业务错误时 HTTP 200 + ok:false（HTTP 层失败才非 200）
- 请求体上限 256 KiB，长请求（chapter/graph）超时 300s

### action: `state`
请求：`{ "action": "state" }`
响应：
```jsonc
{
  "ok": true,
  "dataDir": "/Users/x/Documents/学习空间",
  "courses": [
    { "id": "c-20261107-1a2b", "title": "扩散模型入门", "topic": "扩散模型", "domain": "technical",
      "level": "beginner", "chapterCount": 6, "generatedCount": 2, "status": "planned",
      "doneCount": 1, "quizCount": 1, "reviewDue": 0, "hasGraph": true,
      "createdAt": 1762..., "updatedAt": 1762..., "progressUpdatedAt": 1762... }
  ]
}
```

### action: `course`
请求：`{ "action": "course", "id": "<courseId>" }`
响应：
```jsonc
{
  "ok": true,
  "course": {
    "id": "...", "title": "...", "topic": "...", "domain": "technical",
    "level": "beginner", "chapterCount": 6, "status": "planned",
    "createdAt": 0, "updatedAt": 0, "progressUpdatedAt": 0,
    "outline": [ { "title": "...", "summary": "...", "durationMinutes": 20, "concepts": ["a","b"] } ],
    "chapters": [ { "index": 0, "number": 1, "title": "...", "markdown": "...", "quiz": { "questions": [] } }, null ],
    "progress": { "done": [0], "quiz": { "0": { "score": 2, "total": 3, "answers": [1,0,2], "at": 0 } },
                  "review": { "0": { "due": 0, "intervalDays": 1, "reps": 0, "lastScore": 67, "lastAt": 0 } },
                  "updatedAt": 0 },
    "graph": { "nodes": [], "edges": [], "chapters": [], "source": "llm", "generatedAt": 0 }  // 未生成时 null
  }
}
```

### action: `progress`
- 服务端会按 quiz 的 answerIndex 与作答计算每题对错，累计到 `progress.concepts`（概念累计正确率），并重算 curriculum 解锁；返回 `{progress, curriculum, mastery, newlyUnlocked}`。
- 客户端应以响应里的 `progress/curriculum/mastery` 为准，`newlyUnlocked` 用于提示新解锁章节。
请求：
```json
{ "action": "progress", "id": "<courseId>",
  "progress": { "done": [0,2],
                "quiz": { "0": { "score": 2, "total": 3, "answers": [1,0,2], "at": 1762 } },
                "review": { "0": { "due": 1762, "intervalDays": 1, "reps": 1, "lastScore": 80, "lastAt": 1762 } } } }
```
- 服务端会归一化/裁剪：`done` 去重升序；`quiz` / `review` 的 key 限定 0..99；分数/天数收敛到合理范围。
- 响应：`{ ok: true, progress: <归一化后> }`，同时写回 `course.json`（`progress` + `progressUpdatedAt`）。
- 不修改 `updatedAt`（避免答题把课程顶到列表最前）。

### action: `feedback`
请求：`{ "action": "feedback", "id": "<courseId>", "chapterIndex": 0, "conceptName": "概念名", "assessment": "understood|unsure|lost" }`
- 写入 `progress.concepts[conceptName].selfAssessment`（`unsure` 掌握度上限 60，`lost` 上限 30），并立即重算 curriculum/mastery/doubts。
- 响应：`{ progress, curriculum, mastery, doubts }`

### action: `interact`
请求：`{ "action": "interact", "id": "<courseId>", "chapterIndex": 0, "kind": "explain|compare|figure",
        "selection": "选中的原文", "conceptName": "可选概念名", "question": "可选追问" }`
- `explain`：解释选中文本（结合本章上下文，≤600 字 Markdown）
- `compare`：辨析相关概念（对比表格 + 一句话区别 + 常见误区）
- `figure`：针对概念/选中文本生成内联 SVG 示意图（校验后返回 `interaction.svg`）
- 响应：`{ interaction: { id, courseId, chapterIndex, kind, selection, conceptName, question, answer, svg, createdAt } }`
- 互动历史追加到 `interactions.json`（最多保留 200 条）。

### action: `interactions`
请求：`{ "action": "interactions", "id": "<courseId>", "chapterIndex": 0 }`（chapterIndex 可选）→ `{ items: [...] }`

### action: `plan-add`
请求：`{ "action": "plan-add", "id": "<courseId>", "title": "复习第 2 章", "detail": "", "dueAt": 0, "chapterIndex": 1 }`
→ `{ studyPlan: [...] }`；写入 `course.json.studyPlan`。

### action: `plan-update`
请求：`{ "action": "plan-update", "id": "<courseId>", "itemId": "pl-...", "status": "done|pending", "dueAt": 0, "title": "", "detail": "" }` → `{ studyPlan }`。

### action: `plan-delete`
请求：`{ "action": "plan-delete", "id": "<courseId>", "itemId": "pl-..." }` → `{ studyPlan }`。

### action: `retrain-question`
请求：`{ "action": "retrain-question", "id": "<courseId>", "chapterIndex": 1, "questionIndex": 0, "variant": false }`
- `variant=false` 返回原错题；`variant=true` 以原题绑定概念生成同知识点变式题并缓存到 `retrain-variants.json`。
- 响应：`{ question: { question, options, concepts }, variant, generatedAt? }`（不下发 answerIndex）。

### action: `retrain-answer`
请求：`{ "action": "retrain-answer", "id": "<courseId>", "chapterIndex": 1, "questionIndex": 0, "variant": false, "answer": 2 }`
- 判分后累计 `progress.retrain["chapter:question"]`、按概念累计 `progress.concepts`；答对标记 `resolved`。
- 响应：`{ correct, correctIndex, explanation, resolved, retrain, progress, curriculum, mastery }`。

### action: `assessment`
请求：`{ "action": "assessment", "id": "<courseId>", "stageIndex": 0, "force": false }`
- 阶段内章节全部解锁后才可生成；按阶段概念生成 5 道综合测评题并缓存到 `assessments.json`。
- 响应：`{ assessment: { stageIndex, title, questions, generatedAt, cached } }`

### action: `submit-assessment`
请求：`{ "action": "submit-assessment", "id": "<courseId>", "stageIndex": 0, "answers": [0,2,1,3,0] }`
- 评分、把每题绑定概念计入 `progress.concepts`、写入 `progress.assessments[stageIndex]`，重算解锁并返回 `{ progress, curriculum, mastery, result: { score, total, percent, passed }, newlyUnlocked }`。

### action: `annotations`
请求：`{ "action": "annotations", "id": "<courseId>", "chapterIndex": 0 }`（chapterIndex 可选）→ `{ items: [...] }`
- 标出结构：`{ id, courseId, chapterIndex, quote, occurrence, color: "yellow|green|blue|pink|purple", style: "highlight|underline", note, createdAt, updatedAt }`
- `occurrence` 是该 quote 在章节正文（渲染后纯文本）中的第几次出现（0-based），用于锚定。

### action: `annotate`
请求：`{ "action": "annotate", "id": "<courseId>", "chapterIndex": 0, "quote": "选中的原文", "occurrence": 0, "color": "yellow", "style": "highlight", "note": "" }`
→ `{ annotation }`；写入 `annotations.json`。

### action: `update-annotation`
请求：`{ "action": "update-annotation", "id": "<courseId>", "annotationId": "an-...", "note": "新备注", "color": "green", "style": "underline" }`（字段均可选）→ `{ annotation }`

### action: `delete-annotation`
请求：`{ "action": "delete-annotation", "id": "<courseId>", "annotationId": "an-..." }` → `{ deleted }`

### action: `graph`
请求：`{ "action": "graph", "id": "<courseId>", "force": false }`
- 基于各章 `concepts.json`（没有则用大纲 concepts）重建 Node-Link 图谱：节点带 `chapterIndex/chapterTitle/definition/difficulty/locked/chapterGenerated`；边包含概念先修关系、保留原图 related/contrast 关系、以及同章链/跨章前置兜底。
- 每次章节保存与进度写回都会自动重建（更新 locked 标记）；`force:true` 时不合并旧图。
- 写 `graph.json` 并置 `course.json.hasGraph: true`。
响应：
```jsonc
{ "ok": true, "graph": {
  "nodes": [ { "id": "n1", "label": "前向过程", "chapterIndex": 0, "chapterTitle": "...", "kind": "concept" } ],
  "edges": [ { "source": "n1", "target": "n2", "relation": "prerequisite" } ],
  "chapters": [ { "index": 0, "title": "..." } ],
  "source": "llm",           // 模型失败时回退派生边，source = "derived"
  "model": { "provider": "...", "model": "..." },
  "generatedAt": 0
} }
```
- `relation` ∈ `prerequisite | related | contrast`。
- 节点来自大纲 `concepts`（去重，缺 concepts 的章用章标题）；模型只负责连边，无法映射的边会被丢弃；模型失败时用「同章顺序链 + 跨章前置」派生边兜底。

### action: `delete`

### action: `outline`
请求：
```json
{ "action": "outline", "topic": "扩散模型", "domain": "technical",
  "level": "beginner", "chapterCount": 6, "notes": "可选补充要求",
  "initialUnlocked": 2, "masteryThreshold": 70,
  "stageSize": 3, "stageThreshold": 70 }
```
- `initialUnlocked`：初始解锁章节数（1..chapterCount，默认 min(2, chapterCount)）
- `masteryThreshold`：解锁/掌握度门槛（30..100，默认 70）
- `stageSize`：每阶段章节数（2..12，默认 3）；`stageThreshold`：阶段测评通过线（默认同 masteryThreshold）
- 创建的课程会写入 `curriculum: {initialUnlocked, masteryThreshold, unlockStep:1, unlocked:[...]}`；老课程没有该字段时按 legacy 全部解锁。
- `domain` ∈ `general | technical | engineering | humanities`
- `level` ∈ `beginner | intermediate | advanced`
- `chapterCount` 3..12（整数）
响应：`{ ok: true, course: <同上 course 结构，chapters 全为 null> }`
副作用：在 `~/Documents/学习空间/<courseId>/course.json` 落盘课程元数据与大纲。

### action: `chapter`
请求：`{ "action": "chapter", "id": "<courseId>", "index": 0, "force": false }`（index 0-based）
- 已生成且非 force：直接返回 `{chapter}`（含 concepts）
- 否则创建异步任务，返回 `{job: JobSnapshot}`；客户端轮询 `job` action
- 锁定章节（`curriculum.unlocked` 不含该 index）返回 `LOCKED` 错误，details 带 `nextUnlock`
- `JobSnapshot`：`{id, courseId, index, status: queued|running|succeeded|failed|cancelled, currentStep, steps:[{key,label,status,detail}], warnings, error, result:{chapter}|null}`；步骤 key 依次为 plan/write/concepts/quiz/validate/repair/save
- 取消：`{action:'cancel', jobId}`；查询：`{action:'job', jobId}`
副作用：写 `<courseId>/chapters/01.md`、`<courseId>/chapters/01.quiz.json`，并更新 `course.json` 的 `generated`。
错误码（`error.code`）：
- `BAD_REQUEST` 参数非法
- `NO_MODEL` 未找到默认模型
- `MODEL_FAILED` LLM 调用失败（消息里带原因）
- `PARSE_FAILED` 模型输出不是期望 JSON
- `NOT_FOUND` 课程/章节不存在
- `INTERNAL` 其它异常

### action: `delete`
请求：`{ "action": "delete", "id": "<courseId>" }` → `{ ok: true }`

### action: `debug`
请求：`{ "action": "debug" }` → 返回一次极小 LLM 调用观察到的 chunk 结构（用于排查 chunk 形状/模型可用性）。

## 课程数据格式

`course.json`：
```jsonc
{
  "id": "c-...", "title": "...", "topic": "...", "domain": "technical",
  "level": "beginner", "chapterCount": 6, "status": "planned",
  "createdAt": 1762..., "updatedAt": 1762...,
  "model": { "provider": "deepseek-account", "model": "deepseek-flash" },
  "outline": [
    { "title": "...", "summary": "...", "durationMinutes": 20, "concepts": ["..."] }
  ],
  "generated": [0, 1]
}
```

`chapters/NN.md`：纯 Markdown 章节正文。
`chapters/NN.quiz.json`：
```jsonc
{ "questions": [
  { "question": "...", "options": ["A","B","C","D"], "answerIndex": 0, "explanation": "..." }
] }
```

## Client 目标

- `sidebar.panellist` 注册 id=`learning-space`、order=30、label=`学习空间` 的图标组件（owner props `{size, active}`）
- `main` keyed slot 注册 key=`learning-space` 的整页组件
- 页面结构：顶部标题 + 「新建课程」+ 刷新；左侧课程列表；右侧课程详情（三个子视图：章节 / 知识图谱 / 复习）+ 章节阅读器
- 新建流程：表单（主题、领域、难度、章节数）→ `outline` → 展示大纲 → 逐章调用 `chapter`（显示进度/失败重试）
- 进度：以 `course.progress` 为权威数据，任何变更（标记完成、测验提交、复习排期）都通过 `progress` action 写回 `course.json`；localStorage 仅作离线缓存与首次迁移
- 知识图谱：`course.graph` 为空时按需调用 `graph` action 生成；用 d3 v7（懒加载 `/learning-space/vendor/d3/d3.v7.min.js`）做力导向 Node-Link 图：d3-force 布局、d3-zoom 缩放平移、d3-drag 拖节点，节点按章节配色/度数定大小、标签截断+tooltip、三种关系样式带箭头/虚线、hover 高亮邻居、点击选中看概念详情与章节跳转；工具条含适应画布/重新布局/重新生成；d3 失败回退圆形静态布局
- 复习：按 `progress.review` 的间隔重复排期（1/3/7/14/30 天，低分重置），到期列表 + 章末测验复做，提交后更新排期
- 数学公式：从 `/learning-space/vendor/katex/` 加载 KaTeX（CSS + JS），Markdown 渲染器支持 `$$...$$`、`\[...\]`、`\(...\)` 与行内 `$...$`
- 代码高亮：从 `/learning-space/vendor/prism/prism-bundle.min.js` 加载 Prism（`data-manual`），代码块带语言 chip/行号/复制/>16 行折叠/滚动阴影；不支持的语法降级纯文本
- Mermaid：仅当正文出现 ```mermaid 时懒加载 `/learning-space/vendor/mermaid/mermaid.min.js`，`securityLevel:'strict'`、`startOnLoad:false`，只调用 `mermaid.render`；跟随明暗主题重渲染，失败降级为代码块
- 内联 SVG：正文裸 `<svg viewBox>` 块与 ```svg 围栏渲染为浅底卡片图；客户端 DOMParser 清洗后注入（禁止 script/style/foreignObject/iframe/image/a、on* 事件、javascript:、外链 href）
- 深色主题：所有自绘表面（代码/token/callout/表格/公式/测验/复习/图谱/SVG/Mermaid）提供 `body[data-ds-dark-theme]` 覆盖
- 只用 React（`require('react')`）、宿主主题 token（`--dsw-alias-*`）、无第三方依赖
- 页面顶部留 `var(--dsh-frame-top-clearance)` 的 padding
- 中文 UI 文案；不写 `document.body`、不操作宿主 DOM（KaTeX 的 link/script 资源在 `apply` 里用 `ctx.effect` 注册并清理）
