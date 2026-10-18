---
title: "Agent Skills 为什么不能只是“长提示词”：SKILL.md、按需加载和权限边界"
shortTitle: "Agent Skills 实践"
date: 2026-10-06
category:
  - Agent
tag:
  - AI Agent
  - Agent Skills
  - SKILL.md
order: 2
---


> 实验环境：Windows 11、Oracle JDK 17.0.12、Python 3、PowerShell  
> 规范依据：Agent Skills Specification 与官方 Skill Creation 文档  
> 说明：文中的 Java 探针用于验证目录发现、字段校验和按需加载，不代表某个具体客户端拥有完全相同的加载与授权行为。

**目录**

- 为什么“多写一段提示词”解决不了 Skill 的加载问题
- SKILL.md 的契约比正文更重要
- 渐进加载到底省掉了什么
- 一个最小 Skill 长什么样
- 校验失败比加载失败更早暴露问题
- 脚本、资源和权限要分开看
- 能加载、能复用、能授权执行是三种状态
- 怎样评测一个 Skill 是否可靠
- 接进 Java 项目时的落地清单
- 结论与参考资料

很多人第一次接触 Agent Skills，会把它理解成“把系统提示词拆成一个 Markdown 文件”。这个理解不算错，但只看到了最小的一端。真正落地时，客户端还要知道有哪些 Skill、每个 Skill 用于什么场景、什么时候读取完整说明、什么时候加载参考资料，以及脚本能不能执行。只把一大段指令塞进文件，解决不了这些问题。

我这次把关注点放在四个阶段：目录只读元数据、校验 `SKILL.md`、根据用户请求选中 Skill、按需读取资源。用 JDK 17 写了一个本地探针，再用一个“生成版本发布说明”的 Skill 验证流程。结论很清楚：Skill 的工程价值来自一套可发现、可校验、可渐进加载的约定。权限属于另一层，Host 不会因为读到 `SKILL.md`，就自动允许里面的脚本和工具执行。

## 为什么“多写一段提示词”解决不了 Skill 的加载问题

单个长提示词最直接的问题是边界模糊。它把所有规则、步骤、参考格式和工具说明放进同一个上下文。用户只是想生成一条发布说明，客户端却可能已经把数据库操作、文件写入和另一套业务规则一起送进模型。

长提示词还会让维护变得困难。一次规则调整可能影响所有任务；不同领域的指令互相污染；文件越来越长以后，真正需要执行的步骤被埋在大量背景说明里。更麻烦的是，客户端没有结构化的元数据可以判断“这个能力现在是否相关”。

Skill 把这些信息拆成不同层级：

| 层级 | 保存内容 | 何时加载 |
| --- | --- | --- |
| 目录元数据 | `name`、`description` 等基本信息 | 客户端发现 Skill 时 |
| `SKILL.md` 正文 | 工作流、约束、输出要求 | Skill 被选中后 |
| `references/` | 详细格式、规范、长文档 | 确实需要参考时 |
| `scripts/` | 可执行脚本 | 工作流要求执行时 |
| `assets/` | 模板、图片、固定数据 | 产物需要使用时 |

这张表也解释了 Skill 和长提示词的根本差异。长提示词只有一份文本；Skill 有目录、有元数据、有资源，也有了“加载什么”和“何时加载”的决策点。

## SKILL.md 的契约比正文更重要

Agent Skills 规范把最小结构定义为一个目录和其中的 `SKILL.md`。文件包含 YAML frontmatter 和 Markdown 正文，最基础的字段包括 `name` 和 `description`。

`name` 的约束比较具体：

- 长度为 1 到 64 个字符。
- 只能是小写字母、数字和单连字符。
- 连字符不能出现在开头、结尾，也不能连续出现。
- 必须与 Skill 所在父目录同名。

`description` 的长度是 1 到 1024 个字符。官方文档强调它要同时回答“这个 Skill 做什么”和“什么时候使用”。这句话看起来简单，实际非常关键。客户端通常先看目录元数据，再决定是否激活完整 Skill。描述写得太短，触发条件不清楚；写得太泛，多个 Skill 又会互相抢选择结果。

`compatibility` 最长 500 个字符，用来补充环境或依赖要求。`allowed-tools` 在规范里仍标为实验性能力，不该被当作跨客户端统一的权限开关。还有一些常见的可选字段，例如 `license` 和 `metadata`。它们能帮助分发和版本管理，但不会改变工作流本身。

这里有个容易写错的习惯：把完整操作手册都塞进 `description`。目录阶段只需要足够的路由信息，具体步骤应该留在 Markdown 正文里。元数据负责“选不选”，正文负责“怎么做”。

官方 [Agent Skills Specification](https://agentskills.io/specification.md) 对这些字段给出了约束。规范中明确了一点：目录名和 `name` 必须一致。很多加载失败并不是 Markdown 有问题，而是元数据在进入正文之前就已经不合法。

## 渐进加载到底省掉了什么

Skill 的加载通常分三步：

1. 启动时扫描所有 Skill，只读取 `name`、`description` 等元数据。
2. 用户请求匹配某个 Skill 后，读取完整的 `SKILL.md`。
3. 工作流需要脚本或模板时，再加载对应文件。

官方文档给出的建议是，启动阶段只加载每个 Skill 的少量元数据，总体大致控制在约 100 tokens。激活 Skill 后，完整 `SKILL.md` 推荐低于 5000 tokens。`references/`、`scripts/` 和 `assets/` 仍然按需读取。

这组数字经常被误解成“5000 tokens 以内就一定好”。它真正的意思是控制激活后的上下文预算。如果 `SKILL.md` 已经过长，客户端可能还没加载资源文件，上下文就被说明文字占满了。官方最佳实践还建议把 `SKILL.md` 控制在 500 行以内，资源引用保持一层深度，减少文件之间的跳转。

我写了一个本地 Java 探针，按这个流程读取两个 Skill。一个样例故意把 `name` 写成 `Release-Notes`，另一个使用合法的 `release-notes`。运行命令如下：

```powershell
javac -encoding UTF-8 SkillCatalogDemo.java
java '-Dfile.encoding=UTF-8' SkillCatalogDemo
```

输出保留了目录、校验和按需加载三个阶段：

```text
Catalog stage (frontmatter only)
catalog entry: dir=broken-skill, name=Release-Notes, descriptionChars=68
catalog entry: dir=release-notes, name=release-notes, descriptionChars=151

Validation stage
invalid: broken-skill -> name must use lowercase letters, digits, and single hyphens; name must match parent directory
valid: release-notes

Query stage: "create release notes for version 1.4.0"
selected=release-notes, loaded=SKILL.md, skillChars=708
resource=references\format.md, loaded=true, referenceChars=372
catalogChars=164, progressiveLoadChars=1080
```

这里的 `catalogChars` 和 `skillChars` 都是字符数，不是 token 数。探针也没有模拟真实的语义选路，只用了一个简单的名称匹配。它能验证的是加载分层和字段校验，不能替代某个客户端的完整加载器。

从输出还能看到一个实际收益：目录阶段只读到两个 Skill 的元数据。选中 `release-notes` 后，才读取 708 个字符的完整说明；格式参考文件只有真正需要时才加载。长文档和脚本没有进入第一次目录扫描。

一个前端如果一次加载全部 Skill 正文，短会话可能感觉不到问题。Skill 数量增加以后，启动时间、上下文占用和命中噪音都会一起上涨。渐进加载不是省了一次磁盘读取，它是在减少模型每一轮真正看到的内容。

## 一个最小 Skill 长什么样

实验里的 `release-notes` 目录保持得很小：

```text
release-notes/
├─ SKILL.md
├─ references/
│  └─ format.md
└─ scripts/
   └─ render_release_note.py
```

`SKILL.md` 的 frontmatter 只保留目录阶段需要的字段，正文负责工作流：

```markdown
---
name: release-notes
description: Draft a concise release note from a version and change summary.
  Use when the user asks for a release summary, changelog entry,
  or version announcement.
license: MIT
metadata:
  author: student-blog-lab
  version: "1.0"
---

# Release notes workflow

1. Confirm the version and the user-visible change.
2. Run `scripts/render_release_note.py` with the version and change text.
3. Read `references/format.md` only when the output needs to match the project template.
4. Keep internal issue numbers and unpublished plans out of the result.
```

这个文件没有把所有细节写死。脚本只负责根据参数渲染固定格式，格式差异放进 `references/format.md`，正文负责告诉 Agent 何时调用脚本、何时读取格式文件，以及什么内容不能输出。

描述里的触发条件也值得注意。它没有写成“帮助处理文档”这种泛化描述，而是列出了 release summary、changelog entry 和 version announcement。用户在说“给 1.4.0 写一条发布说明”时，路由器更容易把它和别的文档类 Skill 区分开。

正文中的步骤使用了明确的脚本路径，没有写成“调用发布脚本”这种模糊指令。脚本参数也在正文和脚本自身的帮助信息里同时约束。Skill 名称、目录名、文件路径和参数名保持一致，后续改动时的搜索和替换也会简单很多。

## 校验失败比加载失败更早暴露问题

实验里最直观的结果是，无效 Skill 在元数据阶段就被拦住了。`broken-skill` 的 frontmatter 是：

```yaml
name: Release-Notes
description: This deliberately invalid skill demonstrates frontmatter validation.
```

它触发了两个问题：名称包含大写字母，目录名也不匹配。校验片段可以压缩成下面几行：

```java
private static final Pattern VALID_NAME =
        Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");

if (!VALID_NAME.matcher(name).matches()) {
    problems.add("name must use lowercase letters, digits, and single hyphens");
}
if (!name.equals(directory.getFileName().toString())) {
    problems.add("name must match parent directory");
}
```

这段代码只检查名称格式和目录一致性。生产环境还要处理 frontmatter 解析失败、重复字段、非法 YAML、文件过大、符号链接和路径穿越等输入。

为什么要把校验放在加载正文之前？因为 `SKILL.md` 可能来自第三方包，也可能由不同工具生成。先校验元数据，可以在文件进入上下文之前拒绝明显错误的 Skill。解析器如果遇到不完整的 frontmatter，应该给出明确错误，不要静默跳过，更不要把未闭合的 YAML 当成 Markdown 正文继续读取。

还有一种错误容易漏掉：磁盘上的目录名合法，但打包后的目录层级发生了变化。Skill 压缩包解压后如果多套了一层版本目录，原本的 `name` 就可能不再匹配父目录。发布前用脚本检查一次目录结构，比等到客户端启动后再排查便宜得多。

## 脚本、资源和权限要分开看

Skill 目录可以包含脚本，这不等于脚本可以不受约束地执行。Host 至少要先决定：

- 当前用户是否同意运行这个脚本。
- 脚本能读取哪些路径，能不能访问网络。
- 参数是否来自不可信输入。
- 是否有超时、并发量和输出大小限制。
- 失败时怎样返回退出码，怎样避免留下半成品。

官方脚本指南给出的方向很实用。脚本应该明确输入参数，避免依赖隐藏的交互式输入；会修改文件或远程状态的脚本应提供 dry-run 或预览；成功和失败要通过清晰的退出码表达；默认值要偏安全；输出要能控制大小，防止把大量日志重新灌回模型上下文。

实验脚本只做了一件事：接收版本号和一条变更说明，然后输出 Markdown。它不访问网络，不读取其他文件，也不执行删除操作。调用方式是：

```powershell
python .\.agents\skills\release-notes\scripts\render_release_note.py `
  --version 1.4.0 `
  --change "Retry a failed terminal event once."
```

本机输出：

```text
# Release 1.4.0

Changes:
- Retry a failed terminal event once.
```

脚本可以运行，说明工具链没有问题。它不能说明这个 Skill 应该获得什么系统权限。`allowed-tools` 目前还是实验性字段，具体客户端是否解析、是否执行、是否与自己的工具权限模型兼容，都需要单独核对。

资源文件也有类似的边界。`references/` 里可能保存第三方文档、历史记录或外部片段。Agent 读取它们以后，应该把内容当成参考资料，不要让其中的文本覆盖上层系统指令。把参考资料当可信指令执行，容易让 Skill 成为提示注入和权限扩散的入口。

一个实用的设计原则是：脚本负责确定性转换，模型负责选择和解释，Host 负责授权。三者混在一起，排查问题时会很难判断到底是哪一层出了错。

## 能加载、能复用、能授权执行是三种状态

很多关于 Skill 的讨论把“成功加载”当成终点。工程上至少要分开下面三种状态：

| 状态 | 需要满足的条件 | 风险点 |
| --- | --- | --- |
| 能加载 | 目录可读、元数据合法、正文可解析 | 格式兼容、编码和路径问题 |
| 能复用 | 触发描述稳定、步骤可执行、资源按需可用 | 触发冲突、版本漂移、依赖缺失 |
| 能授权执行 | Host 明确允许脚本、工具、文件和网络访问 | 越权、数据外泄、副作用和供应链风险 |

“能加载”只说明解析器接受文件。“能复用”要求它在不同请求下都能稳定完成同一类任务。“能授权执行”涉及真实系统权限，必须由调用方、运行时和策略层共同决定。

同一个 Skill 可能在前两项都通过，第三项仍然需要审核。一个只读的格式整理脚本，和一个会删除目录、调用外部 API 的脚本，不能因为都叫 Skill 就使用同一套权限。Host 应该按 Skill、脚本、参数和目标资源分别判断，而不是给整个能力目录一次性放权。

还需要考虑供应链。第三方 Skill 可能引用远程包、下载二进制或调用某家公司维护的 CLI。安装前至少要检查文件清单、脚本内容、依赖版本和网络访问范围。对可执行文件做固定版本和哈希校验，比只信任一个会变化的 `latest` 标签更稳。

## 怎样评测一个 Skill 是否可靠

只测“能生成一段看起来合理的文本”远远不够。官方评测建议强调触发精度、负向用例和结果可判断性。下面这几类测试可以直接放进 Skill 的发布流程：

| 测试类型 | 输入 | 期望结果 |
| --- | --- | --- |
| 正向触发 | 用户明确要求生成发布说明 | 选中 `release-notes` |
| 近义触发 | 用户说“写一条版本公告” | 仍能选中 Skill |
| 负向触发 | 用户要求查询天气 | 不选中发布说明 Skill |
| 资源选择 | 要求按项目模板输出 | 只加载格式参考 |
| 缺参处理 | 没有版本号 | 先追问，不编造版本 |
| 依赖失败 | Python 或模板不存在 | 返回明确错误，不继续生成 |
| 权限拒绝 | 脚本尝试写未授权路径 | 在执行前被阻止 |
| 回归对比 | 固定输入与上次版本 | 输出差异可解释 |

测试结果不要只记录最终回答。更要记录选中了哪个 Skill、加载了哪些文件、调用了什么工具、是否发生降级和何时停止。这样才能区分是路由错误、正文步骤错误，还是资源文件过期。

版本也要进入评测。Skill 目录名保持稳定，元数据中记录版本或来源，固定测试集在升级后重新运行。对于会调用脚本或外部服务的 Skill，还要记录依赖版本和输出格式变化。只修改 `description` 也可能改变路由结果，所以元数据不能绕过回归测试。

## 接进 Java 项目时的落地清单

如果把 Skill 能力接进 Spring Boot 或普通 Java 服务，可以按下面的顺序做第一版：

| 检查项 | 需要落到的实现 |
| --- | --- |
| 目录边界 | Skill 根目录固定，解析结果不能跳出根目录 |
| 元数据校验 | 名称、描述、目录匹配和 YAML 错误都有明确返回 |
| 目录缓存 | 元数据只在启动或版本变化时重建，不重复扫描大文件 |
| 触发路由 | 记录候选 Skill、匹配依据和最终选择结果 |
| 按需加载 | 正文、参考资料和脚本分别控制读取时机 |
| 脚本执行 | 参数白名单、工作目录、超时、环境变量和输出上限 |
| 权限策略 | 文件、网络、工具和副作用分别判断，不能只看 Skill 名称 |
| 审计日志 | 记录 Skill 版本、文件哈希、调用参数摘要和执行结果 |
| 失败恢复 | 依赖缺失、脚本非零退出和输出解析失败都有兜底 |
| 评测回归 | 正向、近向、负向和权限拒绝用例进入自动化测试 |

Java 服务里最容易忽略的是路径和进程边界。解析 `SKILL.md` 时要把名字当数据，不要用未校验字符串直接拼到文件路径。执行脚本时明确工作目录，使用参数列表调用进程，不通过 shell 拼接用户输入，并设置超时和最大输出量。对外部 Skill 包先解压到隔离目录，检查链接和压缩包路径，避免目录穿越。

日志也有取舍。记录完整参数可能把密钥、用户数据或私有内容写进日志；只记录“执行成功”又无法排查。至少要对参数做长度限制、字段分类和脱敏，同时保留 Skill 版本、文件哈希和决策原因。Skill 更新后出现行为变化时，这些记录能帮助你定位问题。

## 结论与参考资料

Agent Skills 值得单独设计，是因为它承担了能力发现、元数据路由、按需加载和工作流复用的工程职责。它比长提示词更容易维护，也更容易评测，但“能加载”只说明结构合法，无法证明脚本安全、工具可用或权限已经被授予。

我会把 Skill 看成三层数据：目录元数据负责被发现，`SKILL.md` 负责组织流程，脚本和资源负责具体执行。Host 层面再单独维护权限、超时、审计和供应链检查。这样拆开以后，Skill 数量增加时仍然能控制上下文和执行风险。

下一步可以拿现有项目里的一个固定流程做实验：只让它处理只读输入，给脚本加 dry-run、超时和输出上限，再补一组正向与负向触发用例。比直接给 Agent 一个能做所有事情的技能目录更稳。

参考资料：

- [Agent Skills Specification](https://agentskills.io/specification.md)
- [Agent Skills Quickstart](https://agentskills.io/skill-creation/quickstart.md)
- [Agent Skills Best Practices](https://agentskills.io/skill-creation/best-practices.md)
- [Using Scripts in Skills](https://agentskills.io/skill-creation/using-scripts.md)
- [Evaluating Skills](https://agentskills.io/skill-creation/evaluating-skills.md)
- [Anthropic Skills Repository](https://github.com/anthropics/skills)
