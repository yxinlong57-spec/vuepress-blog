---
title: "上下文工程实战：给 Agent 做上下文预算、压缩与分层，把长会话的成本和跑偏一起治住"
shortTitle: "上下文工程"
date: 2026-10-19
description: "长会话越聊越贵、越聊越跑偏，问题常出在上下文没管好。本文用纯 JDK 写上下文管理器，实测 token 预算、摘要压缩、工具结果裁剪与按需注入，给出可落地阈值。"
category:
  - Agent
tag:
  - AI Agent
  - 上下文工程
  - Token 预算
  - 长上下文
order: 14
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK 单文件，无第三方依赖
> 说明：本文第三、四节的 Java 代码全部真实运行，命令与输出都贴在本机结果里；第一节引用的 Anthropic、Chroma 结论来自官方文章和技术报告，属于「官方文档结论，未在本机验证」，来源链接在文末给出。

**目录**

- 一、长会话为什么越聊越贵、越聊越跑偏
- 二、四个能落地的上下文机制
- 三、手写一个上下文管理器：token 估算、分层、压缩、裁剪
- 四、四个场景的实测输出
- 五、常见坑与边界
- 六、面试官视角：上下文工程会怎么问
- 小结
- 参考资料

## 一、长会话为什么越聊越贵、越聊越跑偏

多轮 Agent 会话跑到二十几轮之后，通常会出现两个同时发生的现象：账单在涨，答案在飘。成本上涨很好理解，每一轮都要把此前所有历史重新作为输入送进模型，输入 token 随轮数近似线性累积；假设每轮净增 300 token 历史，第 30 轮的输入大约是 9000 token，其中绝大部分是前面 29 轮内容的重复。

「答案在飘」的原因就没那么直观了。很多人的第一反应是「上下文窗口不够大，换个长上下文模型就行」，但真正的问题往往相反——不是窗口太小装不下，而是窗口里的东西太多太杂，模型用不过来。

Anthropic 在《Effective context engineering for AI agents》里把这件事说得很直接：上下文是一种有限资源，模型在解析大段上下文时消耗的是一种「注意力预算」（attention budget），每一个新 token 都会消耗掉一部分，回报是递减的；而且这种衰减来自 Transformer 架构本身——n 个 token 之间存在 n² 对两两关系，上下文越长，这种两两关系越被摊薄（官方文档结论，未在本机验证）。

另一份更能量化的证据来自 Chroma Research 的《Context Rot》：他们用 18 个前沿模型跑了 194480 次调用，发现在基础检索、文本复制这类简单任务上，随着输入变长，模型准确率会系统性下降，而且早在窗口塞满之前就开始了；信息放在哪里、怎么排列，比「在不在里面」更重要（官方报告结论，未在本机验证）。

把这两条合起来看，长会话的症状、表层归因和真实机制大致是这样：

| 症状 | 常见表层归因 | 真实机制 |
| --- | --- | --- |
| 账单随轮数线性上涨 | 模型太贵，换个便宜的 | 每轮重传全部历史，输入 token 重复计费 |
| 二十轮后开始答非所问 | 模型不行，换个更强的 | 上下文腐化，注意力被无关历史稀释 |
| 明明在上下文里的信息模型却用不到 | 提示词写得不好 | 中间位置信息易被忽略，长度增加后召回精度下降 |
| 微调提示词见效甚微 | 继续调提示词 | 问题在「放什么进上下文」，不在「怎么说」 |

所以我的结论是：治成本和治跑偏在长会话里其实是同一件事——把送进模型的 token，从「全部历史」换成「分层、按需、可压缩的最小高信号集合」。Anthropic 给的原则是「找到能让期望结果出现概率最大的最小高信号 token 集合」（官方文档结论，未在本机验证）。这篇文章就沿着这个原则，用一个纯 JDK 写的上下文管理器把四个机制跑一遍，看每个机制到底省了多少、代价是什么。

## 二、四个能落地的上下文机制

### 机制一：压缩（compaction）

压缩的做法是：当会话逼近窗口上限时，把已有内容总结成一段高保真摘要，用摘要开启一个新的、更短的上下文。它在概念上对应 Anthropic 提到的 compaction，通常也是上下文工程里第一个该上的杠杆（官方文档结论，未在本机验证）。

关键在于「什么时候触发」和「压缩后保多少原文」。我的实现是：估算 token 超过预算的 70% 就触发，把所有历史折叠成摘要层，只保留最近若干条原文。摘要层只由「近期要点」组成，并且自身也有条数上限——否则摘要会变成新的膨胀源，这一点在第五节展开。

### 机制二：结构化分层

不分层的上下文就是一条 messages 数组，所有东西平铺在一起，谁都不能被单独压缩。分层之后，每一层有不同的生命周期和不同的压缩策略：

```text
┌──────────────────────────────────────────────────┐
│ 1 系统提示层：永驻，不参与压缩，尽量精炼            │
│ 2 工具描述层：永驻，但必须瘦身                     │
│ 3 背景/记忆层：按需注入，同一份只进一次             │
│ 4 历史摘要层：压缩产物，自身有条数上限              │
│ 5 最近原文层：滑动窗口，保留精确细节                │
└──────────────────────────────────────────────────┘
```

Anthropic 建议系统提示要保持在「合适的高度」：一端是把复杂逻辑硬编码进提示词的脆弱写法，另一端是过度笼统、默认模型共享了你的背景；并且推荐用明显的分节标记（Markdown 标题、XML 标签）把背景、指令、工具说明、输出格式隔开（官方文档结论，未在本机验证）。

分层最大的收益是「可分别治理」：系统提示不压缩、工具描述只瘦身、背景去重、摘要封顶、原文滑动窗口。如果你把它们平铺在一起，压缩只能整段整段地丢，很容易把不该丢的指令一起丢掉。

### 机制三：按需检索注入

Anthropic 描述的「just in time」做法是：不预先加载所有相关资料，而是让 Agent 持有轻量标识（文件路径、查询语句、链接），在运行时按需把数据加载进上下文；Claude Code 用这种方式处理大仓库和大数据库，模型写定向查询、用 head / tail 这类命令看片段，而不把整个对象读进来（官方文档结论，未在本机验证）。

落到工程上就是两步：上下文里常驻一份「引用索引」（文档 id + 标题），命中的正文才注入，未命中的只留引用。这样窗口里放的是「可能有用」的目录，而不是「全部内容」。代价是命中前多一次检索往返的延迟，第五节会展开。

### 机制四：工具描述与工具结果瘦身

工具这个位置有两个不同的东西要瘦：

- **工具描述**：工具定义会进入每一轮上下文，是常驻成本。Anthropic 明确指出工具集臃肿、功能重叠、让人都分不清该用哪个工具，是最常见的失败模式之一；如果人类工程师都无法确定该用哪个工具，不能指望模型做得更好（官方文档结论，未在本机验证）。
- **工具结果**：工具返回的原文往往是上下文膨胀最快的地方。一次 `query_orders` 返回三千多字符的 JSON 很常见，但里面真正被后续推理用到的往往只有几条记录。对超长结果做「保留首尾 + 裁剪标记」的瘦身，是最省事的一层。

四个机制的分工整理如下：

| 机制 | 治的是什么 | 触发时机 | 主要代价 |
| --- | --- | --- | --- |
| 压缩 | 历史累积的重复 token | 超预算阈值 | 摘要有损、不可逆 |
| 分层 | 不同内容被一视同仁地丢 | 设计期确定 | 结构复杂度上升 |
| 按需检索注入 | 无关资料常驻窗口 | 每次组装上下文 | 多一次检索延迟 |
| 工具瘦身 | 工具定义与结果膨胀 | 定义期 + 返回时 | 可能裁掉关键记录 |

## 三、手写一个上下文管理器：token 估算、分层、压缩、裁剪

下面这版实现放在 `D:\temp\context-engineering\ContextBudgetDemo.java`，单文件、纯 JDK，`javac` 加 `java` 就能跑。它不接真实模型，只负责「决定送什么进上下文」，因此四层机制、阈值、统计都能看得清清楚楚。

### 先解决 token 估算

Java 侧没有官方开箱的离线分词器，BPE 分词结果又绑死具体模型（同一个字符串在 Claude、GPT、国产模型下 token 数并不相同）。所以我用「字符近似」估算，并把这个近似的偏差说清楚：

```java
static int estimateTokens(String text) {
    if (text == null || text.isEmpty()) {
        return 0;
    }
    int cjk = 0;
    int other = 0;
    for (int i = 0; i < text.length(); i++) {
        char c = text.charAt(i);
        if (c >= 0x2E80 && c <= 0x9FFF) {   // 中日韩字符区间（近似）
            cjk++;
        } else {
            other++;
        }
    }
    // 中日韩字符按 1 字 ≈ 1 token；其余按 4 字符 ≈ 1 token，向上取整
    return cjk + (other + 3) / 4;
}
```

自检输出（本机真实运行）：

```text
token 估算自检: 中文 8 字 -> 8 t; 英文 43 字符 -> 11 t; 混合 9 字符 -> 4 t
```

中文按 1 字 1 token、英文按 4 字符 1 token，是个粗但有方向的估计。它的偏差是：中文往往被低估（不少分词器里一个汉字会到 1 至 2 个 token），英文夹杂符号、数字、代码时也会偏。所以它的用途是「判断预算水位和触发阈值」，不是「对账算钱」——真要计费，必须用对应模型的真实 tokenizer 复核，这一点在第五节会反复强调。

### 分层状态与阈值配置

管理器对外只有三个入口：`add`（普通消息）、`addToolResult`（工具结果，进入前自动瘦身）、`injectBackground`（背景文档，重复的自动跳过）。分层不是三个数组，而是三段状态加上一个不可压缩的系统提示：

```java
static final class ContextManager {
    final String systemPrompt;   // 系统提示层：永驻
    final int budget;            // 上下文窗口预算（token）
    final int compactAt;         // 超过该阈值触发摘要压缩
    final int keepRecent;        // 压缩后保留的最近消息条数
    final int maxToolTokens;     // 单条工具结果的 token 上限
    final int maxKeypoints;      // 摘要里保留的要点条数上限

    final List<Msg> recent = new ArrayList<>();     // 最近原文层
    final List<String> keypoints = new ArrayList<>(); // 历史摘要层
    final Set<String> injectedDocs = new LinkedHashSet<>(); // 背景去重

    int totalTokens() {
        return systemTokens() + summaryTokens() + recentTokens();
    }
}
```

下面表格给出我在实验里用的阈值，以及每个数字为什么这么定：

| 参数 | 取值 | 依据 |
| --- | --- | --- |
| budget | 1000 t（小规模演示） | 真实场景填模型窗口的六七成，留出输出和工具的空间 |
| compactAt | 预算的 70% | 留出压缩本身的消耗，避免「压完还是超」 |
| keepRecent | 6 条 | 保留最近几轮原始细节，摘要不承担精确推理 |
| maxToolTokens | 200 t | 经验值，超过就属于单条结果挤占其他内容 |
| maxKeypoints | 3 条 | 摘要自身封顶，防止摘要变成新的膨胀源 |

### 压缩：超阈值折叠最早的消息

```java
void compactIfNeeded() {
    if (totalTokens() <= compactAt) {
        return; // 预算未超阈值，暂不压缩
    }
    int fold = recent.size() - keepRecent;   // 只折叠最早的那一段
    if (fold <= 0) {
        return;
    }
    List<Msg> folded = new ArrayList<>(recent.subList(0, fold));
    recent.subList(0, fold).clear();
    foldInto(folded);   // 用户消息抽成要点，工具结果只留计数
    compactCount++;
}

void addKeypoint(String kp) {
    keypoints.add(kp);
    while (keypoints.size() > maxKeypoints) {
        keypoints.remove(0);   // 摘要自身也要有上限，否则它会变成新的膨胀源
    }
}
```

两处设计说明一下。第一，压缩只折叠「最早的」一段，最近 `keepRecent` 条原文永远保留——精确推理（比对数字、引用刚才的工具输出）依赖原文，不能让摘要层承担。第二，`foldInto` 只把用户消息压成一句话要点，工具结果只保留条数，因为工具原文本身是可重新拉取的，没有长期保存的价值。

### 工具结果裁剪：保留首尾 + 裁剪标记

```java
String trimToolResult(String json) {
    int raw = estimateTokens(json);
    int headChars = Math.min(json.length(), 160);
    int tailChars = Math.min(json.length(), 60);
    String head = json.substring(0, headChars);
    String tail = tailChars == 0 ? "" : json.substring(json.length() - tailChars);
    int kept = estimateTokens(head) + estimateTokens(tail);
    String marker = "\n...[已裁剪: 原始 " + raw + " tokens, 保留 " + kept + " tokens]...\n";
    return head + marker + tail;
}
```

保留首尾而不是只保留头部，是因为模型经常靠结尾来判断「结果是否完整、有没有报错」。中间留一个带数字的裁剪标记，既是给人的可观测性，也是给模型的信号——让它可以据此决定要不要重新拉一次。

### 背景去重：同一份只进一次

```java
void injectBackground(String docKey, String text) {
    if (!injectedDocs.add(docKey)) {   // LinkedHashSet：同一份背景只进一次
        duplicateSkippedCount++;
        return;
    }
    recent.add(new Msg("context:" + docKey, text));
    compactIfNeeded();
}
```

真实系统里背景文档经常在每轮被重新拼一次提示词，如果不去重，同一份规范会重复进入上下文——模型不会因此更听话，只会更贵。

## 四、四个场景的实测输出

运行命令（本机执行）：

```bash
javac -encoding UTF-8 -d D:\temp\context-engineering D:\temp\context-engineering\ContextBudgetDemo.java
java '-Dfile.encoding=UTF-8' -cp D:\temp\context-engineering ContextBudgetDemo > D:\temp\context-engineering\out.txt 2>&1
```

> 说明：在 Windows PowerShell 下直接运行中文输出容易乱码，所以把输出重定向到 `out.txt` 再读取；`-Dfile.encoding=UTF-8` 要加引号，否则 PowerShell 会把 `-Dfile.encoding=UTF-8` 拆坏。

### 场景 A：30 轮长会话逼近上限，观察锯齿式压缩

预算是 1000 token，阈值 70%。每轮注入一问一答，观察窗口里头的变化。

```text
turn  1 | recent= 2 条 | summary=  0 t | total= 107 t | 压缩=0 次
turn  2 | recent= 4 条 | summary=  0 t | total= 184 t | 压缩=0 次
turn  3 | recent= 6 条 | summary=  0 t | total= 261 t | 压缩=0 次
turn  4 | recent= 8 条 | summary=  0 t | total= 338 t | 压缩=0 次
turn  5 | recent=10 条 | summary=  0 t | total= 415 t | 压缩=0 次
turn  6 | recent=12 条 | summary=  0 t | total= 492 t | 压缩=0 次
turn  7 | recent=14 条 | summary=  0 t | total= 569 t | 压缩=0 次
turn  8 | recent=16 条 | summary=  0 t | total= 646 t | 压缩=0 次
turn  9 | recent= 6 条 | summary= 86 t | total= 347 t | 压缩=1 次
turn 10 | recent= 8 条 | summary= 86 t | total= 424 t | 压缩=1 次
turn 11 | recent=10 条 | summary= 86 t | total= 501 t | 压缩=1 次
turn 12 | recent=12 条 | summary= 86 t | total= 578 t | 压缩=1 次
turn 13 | recent=14 条 | summary= 86 t | total= 655 t | 压缩=1 次
turn 14 | recent= 7 条 | summary= 85 t | total= 370 t | 压缩=2 次
turn 15 | recent= 9 条 | summary= 85 t | total= 447 t | 压缩=2 次
turn 16 | recent=11 条 | summary= 85 t | total= 524 t | 压缩=2 次
turn 17 | recent=13 条 | summary= 85 t | total= 601 t | 压缩=2 次
turn 18 | recent=15 条 | summary= 85 t | total= 678 t | 压缩=2 次
turn 19 | recent= 7 条 | summary= 84 t | total= 369 t | 压缩=3 次
turn 20 | recent= 9 条 | summary= 84 t | total= 446 t | 压缩=3 次
turn 21 | recent=11 条 | summary= 84 t | total= 523 t | 压缩=3 次
turn 22 | recent=13 条 | summary= 84 t | total= 600 t | 压缩=3 次
turn 23 | recent=15 条 | summary= 84 t | total= 677 t | 压缩=3 次
turn 24 | recent= 7 条 | summary= 84 t | total= 369 t | 压缩=4 次
turn 25 | recent= 9 条 | summary= 84 t | total= 446 t | 压缩=4 次
turn 26 | recent=11 条 | summary= 84 t | total= 523 t | 压缩=4 次
turn 27 | recent=13 条 | summary= 84 t | total= 600 t | 压缩=4 次
turn 28 | recent=15 条 | summary= 84 t | total= 677 t | 压缩=4 次
turn 29 | recent= 7 条 | summary= 84 t | total= 369 t | 压缩=5 次
turn 30 | recent= 9 条 | summary= 84 t | total= 446 t | 压缩=5 次
```

最终预算报告：

```text
-- 最终预算报告 --
  分层预算: system=30 t, summary=84 t, recent=332 t, total=446 t / budget=1000 t (占用 45%)
  压缩次数=5, 累计折叠消息=51 条, 工具结果裁剪=0 次, 重复背景跳过=0 次
  摘要层内容: 【历史摘要】累计折叠 51 条消息；近期要点：第24轮：订单服务最近超时率高，请你结合指标继续… | 第25轮：订单服务最近超时率高，请你结合指标继续… | 第26轮：订单服务最近超时率高，请你结合指标继续…
```

这段输出里有两件事值得看。

第一是锯齿：`total` 一路涨到 646 触发压缩，落回 347，再涨再落，五轮压缩后仍稳定在阈值附近。**如果没有压缩，30 轮结束时窗口里会是 60 条消息、约 2340 token，也就是预算的两倍多**——这就是长会话成本失控的具体形状。

第二是摘要层的表现：累计折叠了 51 条消息，摘要层却一直停在 84 到 86 token。原因有两层，一是 `maxKeypoints=3` 让摘要封顶；二是摘要只抽了用户消息的要点，工具结果只留计数。**换来的代价是信息损失：51 条原始消息里被保留下来的只有三句开头截断的要点**，如果第 5 轮的某个精确参数后面还要用，摘要里根本找不到它。这就是我在第五节要重点讲的「摘要不可逆」。

### 场景 B：工具返回超长 JSON

一次 `query_orders` 返回 40 条记录，三千多字符：

```text
工具 query_orders 原始返回: 3121 字符, 约 781 tokens, 上限 200 tokens
注入上下文后的形态（首段 + 裁剪标记 + 尾段）：
  | [{"orderId":10001,"status":"TIMEOUT","amount":200,"ts":"2026-10-19T10:00:01Z"},{"orderId":10002,"status":"TIMEOUT","amount":201,"ts":"2026-10-19T10:00:01Z"},{"o
  | ...[已裁剪: 原始 781 tokens, 保留 55 tokens]...
  | status":"TIMEOUT","amount":239,"ts":"2026-10-19T10:00:01Z"}]
裁剪结果: 上下文内实际 71 tokens（原始 781 tokens，压掉约 91%）
-- 预算报告 --
  分层预算: system=11 t, summary=0 t, recent=76 t, total=87 t / budget=4000 t (占用 2%)
  压缩次数=0, 累计折叠消息=0 条, 工具结果裁剪=1 次, 重复背景跳过=0 次
  摘要层内容: (空)
```

单条工具结果从 781 token 压到 71 token，压掉约 91%。这个数字看着很漂亮，但它是有代价的：中间那 30 多条记录的字段全没了。**如果模型下一步要统计 `amount` 总和，被裁掉的这部分就是硬损失**。所以裁剪工具结果必须配一个「可重新拉取」的引用（比如把完整结果存到外部，上下文里只留 id 和裁剪标记），让模型在需要细节时有第二次机会。

### 场景 C：同一段背景被重复注入 5 次

```text
第 1 次注入 order-timeout-spec | recent=1 条 | total=61 t | 跳过=0 次
第 2 次注入 order-timeout-spec | recent=1 条 | total=61 t | 跳过=1 次
第 3 次注入 order-timeout-spec | recent=1 条 | total=61 t | 跳过=2 次
第 4 次注入 order-timeout-spec | recent=1 条 | total=61 t | 跳过=3 次
第 5 次注入 order-timeout-spec | recent=1 条 | total=61 t | 跳过=4 次
去重后该文档占用 50 tokens；若不去重则为 250 tokens，省下 200 tokens
-- 预算报告 --
  分层预算: system=11 t, summary=0 t, recent=102 t, total=113 t / budget=4000 t (占用 3%)
  压缩次数=0, 累计折叠消息=0 条, 工具结果裁剪=0 次, 重复背景跳过=4 次
  摘要层内容: (空)
```

注意 `recent` 一直是 1 条，`total` 一直是 61 token——重复的 4 次既没进上下文，也没留下任何痕迹，只是把计数器加上了。省下的 200 token 在单次请求里不起眼，但这是每一轮都在重复的成本，乘以轮数就不一样了。另外两份不同的背景文档（`order-retry-policy`、`gateway-sla`）正常进入，最终 `total` 是 113 token。

### 场景 D：按需检索注入 vs 全量注入

知识库 8 篇文档，查询是「订单服务 超时 排查」。按关键词重叠粗排，只注入命中前 2 篇，其余篇目在上下文里只留一个「id + 标题」的引用：

```text
知识库共 8 篇文档，全量注入 = 552 tokens
按需检索命中文档：[doc-01, doc-02]
  << doc-01 正文 97 tokens
  << doc-02 正文 84 tokens
未命中文档只注入引用：doc-03(支付网关接入规范) doc-04(库存扣减一致性说明) doc-05(日志采集规范) doc-06(容量评估方法) doc-07(灰度发布流程) doc-08(值班手册) 
按需注入 = 命中文档 181 tokens + 引用索引 125 tokens = 306 tokens
相对全量注入省下 246 tokens（约 45%）
注意：这里省下的是 token 成本，代价是命中前多了一次检索往返的延迟。
```

八篇全量注入要 552 token，按需注入只要 306 token，省 45%。这里有个容易忽略的点：**引用索引本身也要 125 token，它不是免费的**。如果知识库只有两三篇、每篇又很短，索引可能比正文还贵，按需注入就不划算了。这个机制划算的前提是「文档多、单篇长、命中率低」——正好是真实知识库的形态。

## 五、常见坑与边界

四个机制跑通以后，坑比机制本身更值得记。

**坑一：摘要是有损的，而且不可逆。** 场景 A 里 51 条消息被压成 3 句要点，这是设计使然，但风险在于压缩时你并不知道哪条信息后面会用上。我的处理是两条：一是摘要只保留最近若干要点并封顶；二是保留最近 `keepRecent` 条完整原文，让精确推理始终有原文可用。**在需要精确数字、ID、参数的任务里，压缩阈值应该调高、`keepRecent` 应该调大**，宁可多花一点 token，也不要让模型在摘要上做算术。

**坑二：摘要层自己也会膨胀。** 这是我实现时特意加的一层保护。如果你每次都把「上一版摘要 + 新折叠的消息」拼起来，摘要会越滚越长，最终变成一个不能压缩的庞然大物——压缩本身成了膨胀源。所以摘要必须有条数上限（我用 `maxKeypoints=3`）。同理，系统提示层和工具描述层永驻，更要有硬性长度约束。

**坑三：token 计数不准，估算和真实值会有系统性偏差。** 字符近似在中文场景往往是低估的，用估算值当计费依据会算错钱，用估算值当阈值依据则可能「以为没超、其实超了」。工程上的稳妥做法是：**阈值用估算（便宜、每轮都能算），关键决策点用真实 tokenizer 复核一次**（贵、但有依据），两者差一个安全系数，比如把阈值从 70% 调到 65%。

**坑四：按需检索要付延迟的账。** 场景 D 省的是 token，多的是「检索往返 + 排序」的时间。如果这步是同步阻塞在主链路里的，用户会直接感受到首 token 延迟上升。常见做法是把检索放进 Agent 循环的一次工具调用里（模型自己决定要不要拉某篇文档），而不是在组装上下文时同步等结果。

**坑五：去重不能只按「内容相同」判。** 我的实现按 `docKey` 去重，这在小实验里没问题，但真实系统里同一份文档会有版本：规范 v2 和 v3 内容不同、key 却可能一样。**去重键必须带上版本或内容哈希**，否则你会把「新版本」误当重复丢掉，模型拿着过期规范继续推理。同理，把「重复 = 丢弃」用在用户新指令上也是灾难——用户重复说一件事，往往是因为上次没做好。

**坑六：位置偏见和压缩方向要一起考虑。** 长上下文里中间位置的信息更容易被忽略，把关键指令和当前任务放开头、最近一轮的结论放结尾，比均匀铺开的召回率高。压缩时也有同样的取舍：把「还可能需要精确使用」的内容留在最近层，把「已经消化完」的内容折叠进摘要。

**坑七：压缩和缓存可能互相打架（我的判断，未验证）。** 如果服务端开了 prompt 缓存，缓存命中通常要求前缀稳定；而压缩会改写历史前缀，很可能让缓存失效。这样「省下的输入 token」和「丢掉的缓存折扣」谁更大，需要实测。我没有在 Anthropic 官方文档里找到关于压缩与缓存交互的量化结论，也没有在本机验证，这里只作为一个必须在生产环境实测的点提出来，不作为结论。

## 六、面试官视角：上下文工程会怎么问

这块内容没什么 JDK 源码可挖，但它是 Agent 岗位的高频考点。我把自己会怎么答整理成三组。

**第一组：概念边界。「上下文工程和提示词工程有什么区别？」** 一句话：提示词工程关心「怎么把话说清楚」，上下文工程关心「每一个进窗口的 token 值不值得进」。前者是写好一段静态文本，后者是每一轮都要动态决定送什么、留什么、丢什么。Anthropic 的原话是，上下文工程是提示词工程的「自然延续」，但关注的是「提示词之外的所有信息」（官方文档结论，未在本机验证）。

**第二组：工程机制。「长会话你会怎么处理？」** 按「分层 → 预算 → 机制 → 度量」四步答：先分层（系统提示、工具描述、背景、摘要、原文），再给每层定预算和阈值，再选机制（压缩、裁剪、去重、按需注入），最后埋点度量（每层 token 占比、压缩触发次数、缓存命中率）。能说出「摘要层自身也要封顶」这种细节，通常比只背概念更有区分度。

**第三组：追问。「摘要是会丢信息的，你怎么保证不出错？」** 这题没有标准答案，我会分三档答：任务对精确度不敏感（闲聊、探索）时，可以激进压缩；任务涉及精确数字、ID、参数时，用「摘要 + 保留原文窗口」的组合；对可重新拉取的资料，用「裁剪 + 引用 + 需要时重取」代替压缩。核心是承认摘要不可逆，并把「哪类信息可以用摘要替代」当成显式设计决策，而不是默认行为。

## 小结

- 长会话的成本和跑偏是同一个问题的两面：上下文是有限资源，不是可以无限塞的工作区；治法是把它换成分层、按需、可压缩的最小高信号集合。
- 四个机制各有分工：压缩治历史累积，分层让不同内容可以分别治理，按需检索注入治无关资料常驻，工具瘦身治定义和结果的膨胀。
- 手写的上下文管理器在四个场景里的实测效果：30 轮会话靠压缩把峰值压在阈值附近（不做压缩会到预算的两倍多）；单条工具结果压掉约 91%；重复背景省下 200 token；按需检索注入省 45%。
- 比机制更重要的是边界：摘要不可逆、摘要自身会膨胀、token 估算有偏差、按需检索有延迟、去重要带版本、压缩可能破坏缓存。设计这些机制时，先决定「哪类信息允许被丢失」，再决定阈值。
- 如果让我在项目里做选择，我会先把 token 预算和分层做出来（成本低、收益确定），再上压缩；压缩阈值和保留条数要按任务对精确度的要求分档，不要用一个全局常量糊到底。

下一篇我准备聊 Agent 的评测：怎么在不接真实模型的前提下，用可复现的方式量出「上下文一变，回答质量就变」这件事。

## 参考资料

- [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（注意力预算、上下文腐化、compaction、just-in-time 检索的出处）
- [Anthropic, Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（workflow 与 agent 的边界）
- [Anthropic, Writing tools for AI agents – with AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)（工具描述瘦身与工具集设计）
- [Claude Cookbook, Context engineering: memory, compaction, and tool clearing](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)（compact 与 tool-result clearing 的官方示例）
- [Chroma Research, Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot)（18 个模型、194480 次调用的输入长度退化研究）
- [Attention Is All You Need（arXiv:1706.03762）](https://arxiv.org/abs/1706.03762)（n² 两两注意力关系的来源）
