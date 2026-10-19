---
title: "Agent 可观测性：用纯 Java 给 Agent 装上追踪、指标和一张成本账单"
shortTitle: "Agent 可观测性"
date: 2026-10-19
description: "Agent 上线后说不清哪一步变慢、变贵、变蠢。本文用纯 JDK 手写 Span 树、指标聚合和成本账本，并真跑四个场景验证失败归因。"
category:
  - Agent
tag:
  - AI Agent
  - 可观测性
  - 成本治理
  - 链路追踪
order: 15
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin）
> 说明：文中所有代码与运行输出均为本机真实执行结果（纯 JDK 单文件，`java Main.java`）。模型调用用按脚本输出的 MockLLM 代替，延迟用随机 30～60ms 的真实 `Thread.sleep` 模拟，因此耗时数字每次运行略有浮动，其余逻辑（Span 结构、父子关系、token 估算、成本计算、超时与熔断）全部真实实现。第五节涉及的生产生态（Spring AI / OpenTelemetry / Langfuse / ARMS）为官方文档结论，未在本机验证。

**目录**

- 一、Agent 为什么比普通服务更难观测
- 二、一轮 Agent 运行要采集的三类信号
- 三、用纯 Java 手写一个可观测层
- 四、实测：四个场景的完整 Span 树与成本账单
- 五、对接生产生态：Spring AI、OpenTelemetry 与后端
- 六、六个常见坑
- 七、面试怎么答
- 小结
- 参考资料

## 一、Agent 为什么比普通服务更难观测

先说一个很多人遇到过但说不清楚的场景：Agent 上线两周，账单比预估高了 40%，P95 延迟从 8 秒涨到 23 秒，用户投诉"有时候答得莫名其妙"。你翻日志，只能看到一长串 `llm call`、`tool call` 和几百行提示词，既看不出这 40% 花在哪一步，也看不出那 23 秒卡在模型还是工具。问题不是日志不够多，而是**日志是线性的，而 Agent 的执行是树形的**。本文的路子是：先定义一轮运行要采集的三类信号，再用纯 JDK 手写一个可观测层并真跑四个场景，最后讲清它怎么映射到 Spring AI、OpenTelemetry 上。

普通 Java 服务的可观测性早就被解决了：一次 HTTP 请求对应一条 trace，Span 是"Controller → Service → DAO"这种固定且有限的形状，指标用 Micrometer 打点，成本就是 CPU 和内存。Agent 把这一切都搅乱了，具体乱在四个地方。

**第一，非确定性让"复现"失效。** 普通服务出 bug，你可以拿同一个请求重放，看它稳定复现。Agent 同一个输入跑两次，工具调用顺序、步数、甚至答案都可能不同。你不能靠"再跑一次"来定位问题，只能靠**留痕**：把每一次真实运行的完整轨迹存下来回头看。

**第二，一次用户请求 = 一串子调用。** 一轮 Agent 循环可能包含 4 次模型调用和 3 次工具调用，工具内部还可能再调一次向量检索。它们的耗时不是相加的关系，而是包含和嵌套的关系。用 `System.out.println` 打平铺日志，你会丢掉"哪次工具调用属于哪一步推理"这层结构。

**第三，计费维度在服务端不可见。** 一个 Java 方法调用不会产生"费用"这种属性。但模型调用会——按输入 token 和输出 token 分别计价，而 token 数量取决于上下文有多长。要在 Java 侧算清这笔账，必须自己把每次模型调用的 token 用量记下来，再乘模型单价。

**第四，工具调用带副作用。** 查天气这种工具失败了无非是重试，但"下单""发消息""写库"失败了，重试可能造成重复副作用。这意味着工具 Span 上还要带上幂等键、重试次数这类属性，失败归因也不能只看"有没有抛异常"。

把这四条对照普通微服务，差异就很清楚：

| 维度 | 普通 Java 服务 | Agent 服务 |
| --- | --- | --- |
| 调用形状 | 固定分层（Controller→Service→DAO） | 动态树形，步数和分支每次都可能不同 |
| 可复现性 | 同输入同结果 | 同输入不同结果，只能靠轨迹留痕 |
| 资源计费 | CPU / 内存 / 连接数 | 输入 token + 输出 token，按模型单价计费 |
| 失败形态 | 异常堆栈基本能定位 | 失败可能"没异常"：模型空转、工具返回脏数据 |
| 关键指标 | QPS、延迟、错误率 | 步数、token、工具成功率、单次任务成本 |

结论一句话：**Agent 想回答"哪一步变慢了、哪一步变贵了、哪一步变蠢了"，就必须有运行时的结构化轨迹，而不是事后猜。**

## 二、一轮 Agent 运行要采集的三类信号

可观测性有三个经典支柱：Logging、Metrics、Tracing。放到 Agent 场景，我把它落成三类具体信号：**Span 树**（定位"哪一步"）、**指标**（回答"多慢/多贵/多可靠"）、**成本账本**（回答"钱花在哪个模型、哪一步"）。

### 2.1 Span 树：一次运行 = 一条 trace

一个 trace 对应用户的一个请求。trace 内部是一条树：

```text
agent.run                        ← 一次用户请求 = 一条 trace（AGENT）
├─ llm.chat step=1               ← 第 1 步的模型调用（MODEL）
├─ tool.search                   ← 第 1 步决定的工具调用（TOOL）
│  └─ retrieval.vector           ← 工具内部的检索（RETRIEVAL）
├─ llm.chat step=2               ← 第 2 步的模型调用（MODEL）
├─ tool.calc                     ← 第 2 步的工具调用（TOOL）
├─ llm.chat step=3
├─ tool.weather
└─ llm.chat step=4               ← 这一轮返回 FINAL，循环结束
```

这张树回答了平铺日志答不了的问题：

- **哪一步慢**：看子 Span 的耗时占比，不用猜模型慢还是工具慢。
- **哪一步贵**：token 和费用记在 MODEL Span 上，逐层累加到根，一眼看到是第 3 步的长上下文贵，还是第 4 步的长输出贵。
- **哪一步错**：失败标记打在具体 Span 上，"失败"不再是一个整体状态，而是"第 2 步 `tool.calc` 参数不是整数"。

Span 需要的最小字段：

| 字段 | 作用 |
| --- | --- |
| `traceId` | 一次运行的全局标识，串起所有 Span |
| `spanId` / `parentId` | 重建父子关系，是"树"得以成立的基础 |
| `name` / `kind` | 名称与类型（AGENT / MODEL / TOOL / RETRIEVAL） |
| `startNanos` / `endNanos` | 起止时间，算出耗时 |
| `status` / `error` | OK 还是 ERROR，以及失败类型（TOOL_ERROR / TIMEOUT） |
| `inputTokens` / `outputTokens` / `costUsd` | 只在 MODEL Span 上有效 |
| `attributes` | 自由键值：任务、参数、结果摘要、模型名 |

### 2.2 指标：从 Span 树里聚合出来的数字

指标不是另记一套，而是从 Span 树里聚合。一轮运行至少要聚合出这些：

| 指标 | 怎么来 | 用来回答 |
| --- | --- | --- |
| 端到端耗时 | 根 Span 耗时 | 用户体感快不快 |
| 模型调用次数 / 平均模型延迟 | 统计 MODEL Span | 推理是不是瓶颈 |
| 工具调用次数 / 工具成功率 | 统计 TOOL Span 的 status | 工具层稳不稳定 |
| 输入 token / 输出 token / 合计 | 累加 MODEL Span | 上下文膨胀了没有 |
| 循环步数 | 根 Span 的 `steps` 属性 | 任务是不是被拆得太碎 |
| 检索次数 / 命中数 | RETRIEVAL Span 属性 | RAG 是不是在白跑 |
| 停止原因 | 根 Span 的 `stop` 属性 | 是正常收敛还是被熔断/兜底截断 |

最后一项经常被忽略，但它是我认为最重要的一个：**"模型给出最终回答"和"步数超限，强制停止"是两种完全不同的运行结果**。前者的成功率可信，后者本质上是失败，如果只统计"有没有返回答案"，你会把大量被兜底截断的运行算成成功，成功率数字很好看，线上体验很糟。

### 2.3 成本账本：单价 × token，逐层累加

成本就是两次乘法：`输入 token × 输入单价 + 输出 token × 输出单价`。难点不在算，而在**在哪一层记**。我的做法是把每类模型单价的价目表放进代码（生产里放配置中心），每次模型调用结束时立刻算出这一个 Span 的费用并写进 Span，再从 Span 树累加到 trace 级和任务级。

为什么强调"立刻算"？因为如果等到 Agent 运行结束再统一统计，中途被熔断或抛异常退出的那次运行，token 就全丢了——而那恰恰是最贵、最需要复盘的一类运行。这一点在第六节还会展开。

## 三、用纯 Java 手写一个可观测层

下面是最小实现的核心部分，完整单文件放在 `D:\temp\agent-observability\Main.java`，JDK 11 直接 `java Main.java` 就能跑。

### 3.1 Span：一个普通对象，只有字段没有魔法

```java
static final class Span {
    final String traceId;
    final String spanId;
    String parentId = null;
    final String name;
    final String kind;              // AGENT / MODEL / TOOL / RETRIEVAL
    long startNanos;
    long endNanos;
    String status = "OK";           // OK / ERROR
    String error = null;            // 失败类型：TOOL_ERROR / TIMEOUT ...
    long inputTokens = 0;
    long outputTokens = 0;
    double costUsd = 0.0;
    final Map<String, String> attributes = new LinkedHashMap<>();
    final List<Span> children = new ArrayList<>();

    Span(String traceId, String spanId, String name, String kind) { ... }

    double durationMs() { return (endNanos - startNanos) / 1_000_000.0; }

    void fail(String reason) { this.status = "ERROR"; this.error = reason; }
}
```

`parentId` 加上 `children` 是冗余的——两个都留，是因为 `parentId` 方便序列化成标准 trace 格式（OpenTelemetry 就是这么传的），而 `children` 方便本地直接打印成树。`startNanos` 用 `System.nanoTime()` 而不是 `currentTimeMillis`，因为后者会被系统时钟调整影响，算耗时会漂。

### 3.2 Tracer：用栈维护父子关系

父子关系不需要靠"传参"来维护。开一个栈，`start()` 时把新 Span 压在栈顶，`end()` 时弹栈，**栈顶就是当前 Span**，新 Span 的父就是它。这样业务代码里不用到处传 parent 对象：

```java
static final class Tracer {
    final String traceId = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
    final Deque<Span> stack = new ArrayDeque<>();
    final List<Span> roots = new ArrayList<>();
    int seq = 0;

    Span start(String name, String kind) {
        Span s = new Span(traceId, "s" + String.format("%02d", ++seq), name, kind);
        s.startNanos = System.nanoTime();
        if (stack.isEmpty()) {
            roots.add(s);
        } else {
            Span parent = stack.peek();
            s.parentId = parent.spanId;
            parent.children.add(s);
        }
        stack.push(s);
        return s;
    }

    Span end() {
        Span s = stack.pop();
        s.endNanos = System.nanoTime();
        return s;
    }
}
```

这里有个必须强调的工程约束：**`start()` 之后一定要有 `end()`**。生产里标准做法是把 `end()` 放进 `finally`，否则中途抛异常时 Span 不闭合，耗时会算成"至今为止"，指标直接失真。我的 Agent 循环里，工具 Span 的 `end()` 就写在 `finally` 里。

### 3.3 埋点：只埋两个位置

很多人以为要埋很多点，其实核心就两个：**模型调用**和**工具调用**。检索是工具内部的子 Span，逻辑上和其他工具一样，只是类型不同。

```java
// ---- 显式埋点：模型调用 ----
Span llmSpan = tracer.start("llm.chat step=" + step, "MODEL");
llmSpan.attributes.put("model", llm.model);
String out = llm.chat(history);
llmSpan.inputTokens = llm.lastInputTokens;
llmSpan.outputTokens = llm.lastOutputTokens;
llmSpan.costUsd = cost(llm.model, llm.lastInputTokens, llm.lastOutputTokens);
llmSpan.attributes.put("out", preview(out, 56));
tracer.end();
history.add("ASSISTANT: " + out);
```

```java
// ---- 显式埋点：工具调用 ----
Span toolSpan = tracer.start("tool." + toolName, "TOOL");
toolSpan.attributes.put("args", args.toString());
try {
    if (tool == null) throw new ToolFailure("未注册的工具 " + toolName);
    String result = callWithTimeout(tool, args, tracer, toolTimeoutMs);
    toolSpan.attributes.put("result", preview(result, 48));
    consecutiveErrors = 0;
    history.add("OBSERVATION: " + result);
} catch (ToolTimeout te) {
    toolSpan.fail("TIMEOUT");
    toolSpan.attributes.put("error", te.getMessage());
    // ... 熔断判断略
} catch (ToolFailure tf) {
    toolSpan.fail("TOOL_ERROR");
    toolSpan.attributes.put("error", tf.getMessage());
    // ... 熔断判断略
} finally {
    tracer.end();
}
```

注意失败路径也照样写 `attributes` 和 `error`——这就是"失败归因"的全部秘密：**失败信息必须落在 Span 上，而不是只落在日志里**。这样你按 `status=ERROR` 一筛，就能看到所有失败运行的失败点分布，而不需要一行行读日志。

### 3.4 成本：价目表 + 估算器

```java
static final class Price {
    final double in;
    final double out;
    Price(double in, double out) { this.in = in; this.out = out; }
}

// 单位：USD / 1M tokens（示例价格，仅用于演示账本算法）
static final Map<String, Price> PRICING = new LinkedHashMap<>();
static {
    PRICING.put("mock-small", new Price(0.15, 0.60));
    PRICING.put("mock-large", new Price(2.50, 10.00));
}

static double cost(String model, long in, long out) {
    Price p = PRICING.get(model);
    if (p == null) return 0.0;
    return in / 1_000_000.0 * p.in + out / 1_000_000.0 * p.out;
}
```

token 数量在 Mock 里是估出来的（CJK 字符按 1 token，其余按 4 字符 1 token）；真实系统里这个数字由模型响应里的 `usage` 字段直接给出，不需要自己数——这也是为什么真实实现里 token 采集比这里更准。

```java
static long estimateTokens(String text) {
    long cjk = 0, other = 0;
    for (int i = 0; i < text.length(); i++) {
        char c = text.charAt(i);
        if (c >= 0x4E00 && c <= 0x9FFF) cjk++; else other++;
    }
    return cjk + (other + 3) / 4;
}
```

### 3.5 超时：真实实现，不是假装

工具超时不能用"事后量一下耗时"来糊弄，必须真的能中断。这里用一个 daemon 线程 + `join(timeout)`：

```java
static String callWithTimeout(Tool tool, Map<String, String> args, Tracer tracer, long timeoutMs) {
    final String[] holder = new String[1];
    final Throwable[] err = new Throwable[1];
    Thread worker = new Thread(() -> {
        try { holder[0] = tool.call(args, tracer); }
        catch (Throwable t) { err[0] = t; }
    });
    worker.setDaemon(true);
    worker.start();
    try { worker.join(timeoutMs); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    if (worker.isAlive()) {
        worker.interrupt();
        throw new ToolTimeout("工具 " + tool.name() + " 超过 " + timeoutMs + "ms 未返回");
    }
    if (err[0] != null) {
        throw (err[0] instanceof RuntimeException) ? (RuntimeException) err[0] : new RuntimeException(err[0]);
    }
    return holder[0];
}
```

三个设计取舍：**用 daemon 线程**是为了让演示程序不会因为漏掉一个 worker 而退不出去；**`interrupt()` 只是尽力而为**，真正挂死在 socket 上的工具线程不会响应中断，生产里要靠 HTTP 客户端自己的读超时兜底，这里只是把"超时"这件事建模准确；**超时算 ERROR 而不是成功**——这个判断很重要，很多系统把"最终返回了"当成功，把 90 秒的慢调用记成正常，延迟指标就被污染了。

## 四、实测：四个场景的完整 Span 树与成本账单

运行命令（PowerShell 下必须给 `-Dfile.encoding=UTF-8` 加引号，否则会被拆成两个参数）：

```bash
java "-Dfile.encoding=UTF-8" Main.java > out.txt 2>&1
```

输出重定向到文件再读，避免中文控制台乱码。

### 4.1 场景 A：4 步正常任务

任务："查 Spring AI 工具调用，算 3+4，再看上海天气"。模型脚本依次调用 `search`、`calc`、`weather`，最后 `FINAL`。真实输出：

```text
################ 场景 A：4 步正常任务 ################
[trace 35b33121]
└─ agent.run                 210.4ms OK       {task=查 Spring AI 工具调用，算 3+4，再看上海天气, steps=4, answer=已检索到 Spring AI 工具调用文档；3+4=7；上海多云 24℃。, stop=模型给出最终回答}
   ├─ llm.chat step=1            36.9ms OK     in=40 out=10  $0.000012  {model=mock-small, out=TOOL search q=Spring AI 工具调用}
   ├─ tool.search                16.6ms OK       {args={q=Spring AI 工具调用}, result=[doc] Spring AI 通过 ToolCallback 暴露工具，工具执行链在 Chat…}
   │  └─ retrieval.vector            3.1ms OK       {query=Spring AI 工具调用, hits=3}
   ├─ llm.chat step=2            51.6ms OK     in=83 out=5  $0.000015  {model=mock-small, out=TOOL calc a=3,b=4}
   ├─ tool.calc                   3.7ms OK       {args={a=3, b=4}, result=7}
   ├─ llm.chat step=3            42.1ms OK     in=94 out=7  $0.000018  {model=mock-small, out=TOOL weather city=上海}
   ├─ tool.weather                7.6ms OK       {args={city=上海}, result=上海 24℃ 多云}
   └─ llm.chat step=4            40.1ms OK     in=113 out=22  $0.000030  {model=mock-small, out=FINAL 已检索到 Spring AI 工具调用文档；3+4=7；上海多云 24℃。}
===== 成本账本 =====
价目表(USD/1M): mock-small in=0.15 out=0.60 | mock-large in=2.50 out=10.00
模型调用: 4 次   工具调用: 3 次(成功 3 / 失败 0)   检索: 1 次
输入 token: 330   输出 token: 44   合计: 374
模型费用: $0.000076
端到端耗时: 210.4 ms   工具成功率: 100.0%   工具超时: 0 次
停止原因: 模型给出最终回答
最终回答: 已检索到 Spring AI 工具调用文档；3+4=7；上海多云 24℃。
```

这段输出里有三个值得盯着看的地方。

**一是检索 Span 的嵌套。** `retrieval.vector` 缩进在 `tool.search` 下面，说明它是工具内部的子 Span。如果检索变慢，耗时账会直接显示在这一层，而不是含糊地算在"工具耗时"里。

**二是输入 token 的单调增长：40 → 83 → 94 → 113。** 这就是多轮 Agent 的成本特征：每一步都要把之前所有历史重新喂给模型，输入 token 随步数递增。第 4 步的输出最长（22 token），所以那一步单价最高（$0.000030）。**输入 token 增长是 Agent 成本的隐性大头，而不是输出。**

**三是耗时结构。** 总耗时 210.4ms 里，4 次模型调用加起来 170.7ms，3 次工具调用加起来不到 28ms。结论很直接：**瓶颈在模型，工具优化没有意义**。如果反过来工具占了大头，那优化方向就完全不同。这就是 Span 树相对单一日志的核心价值——它把"猜"变成了"看"。

### 4.2 场景 B：工具连续报错，熔断终止

模型连续把参数写成中文和字母，工具两次都返回参数错误，触发连续错误熔断：

```text
################ 场景 B：工具连续报错，熔断终止 ################
[trace 01bb400e]
└─ agent.run                 129.3ms OK       {task=算一下 3+4, steps=2, stop=工具连续报错熔断}
   ├─ llm.chat step=1            52.2ms OK     in=28 out=6  $0.000008  {model=mock-small, out=TOOL calc a=三,b=四}
   ├─ tool.calc                  12.5ms ERROR    fail=TOOL_ERROR  {args={a=三, b=四}, error=参数必须是整数，收到 a=三, b=四}
   ├─ llm.chat step=2            55.6ms OK     in=56 out=5  $0.000011  {model=mock-small, out=TOOL calc a=x,b=y}
   └─ tool.calc                   7.2ms ERROR    fail=TOOL_ERROR  {args={a=x, b=y}, error=参数必须是整数，收到 a=x, b=y}
===== 成本账本 =====
模型调用: 2 次   工具调用: 2 次(成功 0 / 失败 2)   检索: 0 次
输入 token: 84   输出 token: 11   合计: 95
模型费用: $0.000019
端到端耗时: 129.3 ms   工具成功率: 0.0%   工具超时: 0 次
停止原因: 工具连续报错熔断
最终回答: 
```

这里最该注意的是**根 Span 的 status 是 OK，但工具 Span 是 ERROR，而且最终回答为空**。如果只看"trace 有没有报错"，你会以为这次运行是成功的。真实的失败信号藏在三个地方：两个 ERROR 的 TOOL Span、`stop=工具连续报错熔断`、以及为空的结果。**"运行没抛异常"不等于"运行成功"**——这是 Agent 可观测性和普通服务可观测性最大的分野，值得单独做成一个监控规则：`stop != "模型给出最终回答"` 的运行全部计入失败率。

熔断止损的效果也能从账本上读到：这次只花了 2 次模型调用、$0.000019 就退出了。如果放任它烧到最大步数，成本会线性增长，而且大概率仍然不会成功。**熔断保护在监控上表现为"失败运行的成本上限"**。

### 4.3 场景 C：模型空转，步数超限

模型每步参数都略有不同（`b=1,2,3,4,5,6`），重复检测抓不住，只能靠最大步数兜底：

```text
################ 场景 C：模型空转，步数超限 ################
[trace bb91797b]
└─ agent.run                 305.6ms OK       {task=随便算几个数, steps=6, stop=步数超限，强制停止}
   ├─ llm.chat step=1            47.0ms OK     in=30 out=5  $0.000008  {model=mock-small, out=TOOL calc a=1,b=1}
   ├─ tool.calc                   8.7ms OK       {args={a=1, b=1}, result=2}
   ├─ llm.chat step=2            34.9ms OK     in=41 out=5  $0.000009  {model=mock-small, out=TOOL calc a=1,b=2}
   ├─ tool.calc                   5.2ms OK       {args={a=1, b=2}, result=3}
   ├─ llm.chat step=3            54.9ms OK     in=52 out=5  $0.000011  {model=mock-small, out=TOOL calc a=1,b=3}
   ├─ tool.calc                   3.8ms OK       {args={a=1, b=3}, result=4}
   ├─ llm.chat step=4            58.7ms OK     in=63 out=5  $0.000012  {model=mock-small, out=TOOL calc a=1,b=4}
   ├─ tool.calc                   8.2ms OK       {args={a=1, b=4}, result=5}
   ├─ llm.chat step=5            35.3ms OK     in=74 out=5  $0.000014  {model=mock-small, out=TOOL calc a=1,b=5}
   ├─ tool.calc                   3.3ms OK       {args={a=1, b=5}, result=6}
   ├─ llm.chat step=6            39.2ms OK     in=85 out=5  $0.000016  {model=mock-small, out=TOOL calc a=1,b=6}
   └─ tool.calc                   2.7ms OK       {args={a=1, b=6}, result=7}
===== 成本账本 =====
模型调用: 6 次   工具调用: 6 次(成功 6 / 失败 0)   检索: 0 次
输入 token: 345   输出 token: 30   合计: 375
模型费用: $0.000070
端到端耗时: 305.6 ms   工具成功率: 100.0%   工具超时: 0 次
停止原因: 步数超限，强制停止
最终回答: 
```

**这是最容易被漏判的一类运行。** 工具成功率 100%，没有任何 ERROR Span，一切看起来"很健康"；但 `stop=步数超限` 说明模型空转被兜底截断了，任务并没有完成。如果把这类运行计入成功率，你的成功率会被系统性高估。

对比场景 A 和场景 C 的成本也很有意思：C 跑了 6 步（比 A 多 2 步），费用 $0.000070 反而低于 A 的 $0.000076。原因是 A 的每步输出更长。**所以"步数多 = 更贵"是错的，成本由 token 决定，步数只是间接相关**。想控成本，先控上下文长度和输出长度，而不是只砍步数。

### 4.4 场景 D：工具超时一次后继续

工具 `slow_api` 要睡 120ms，超过 50ms 阈值被判定超时；模型收到失败观察后自己改口，直接给出最终回答：

```text
################ 场景 D：工具超时一次后继续 ################
[trace 3305e1e2]
└─ agent.run                 166.1ms OK       {task=调一下上游接口再总结, steps=2, answer=上游接口超时，我先返回已知信息。, stop=模型给出最终回答}
   ├─ llm.chat step=1            37.0ms OK     in=34 out=5  $0.000008  {model=mock-small, out=TOOL slow_api id=42}
   ├─ tool.slow_api              66.5ms ERROR    fail=TIMEOUT  {args={id=42}, error=工具 slow_api 超过 50ms 未返回}
   └─ llm.chat step=2            62.0ms OK     in=59 out=16  $0.000018  {model=mock-small, out=FINAL 上游接口超时，我先返回已知信息。}
===== 成本账本 =====
模型调用: 2 次   工具调用: 1 次(成功 0 / 失败 1)   检索: 0 次
输入 token: 93   输出 token: 21   合计: 114
模型费用: $0.000027
端到端耗时: 166.1 ms   工具成功率: 0.0%   工具超时: 1 次
停止原因: 模型给出最终回答
最终回答: 上游接口超时，我先返回已知信息。
```

这次运行**表面成功、内部有失败**：根 Span 状态 OK，根属性里的 `answer` 有内容，但工具成功率是 0.0%、超时 1 次。这就是为什么"工具成功率"必须和"任务成功率"分开看：任务成功不代表工具可靠，工具失败也不代表任务失败。两个指标交叉着看，你才能区分"模型很聪明地用降级方案兜住了"和"系统真的稳定"。

顺带一个细节：`tool.slow_api` 的耗时是 66.5ms，比 50ms 的阈值多出 16ms——这是 `join(50)` 返回后 `interrupt()` 和线程收尾的开销。**超时判定不是精确的，监控阈值要留余量**，不要把告警阈值贴着超时阈值设。

### 4.5 四场景汇总

```text
################ 四场景汇总 ################
场景       端到端ms        模型调用       工具调用       总token     费用USD     
A        210.4        4          3          374        $0.000076
B        129.3        2          2          95         $0.000019
C        305.6        6          6          375        $0.000070
D        166.1        2          1          114        $0.000027
```

从这 83 行输出里能读出的结论：

1. **定位靠结构，不靠猜测**：四个场景的"哪里出了问题"都是从树结构和属性直接读出来的，没有一处需要读日志正文。
2. **成本必须按 Span 记账**：B 场景在失败中途退出，token 和费用依然完整——因为它记录在每个模型调用结束的那一刻。
3. **成功有多重定义**：至少要把"根状态、停止原因、工具成功率"三个维度合起来看，任何单一信号都会误判。
4. **单次任务成本可以直接对比**：A 和 D 是同类任务（检索+计算+汇总），A 花 $0.000076、D 花 $0.000027，差 2.8 倍，可以直接归因到"多了一轮模型调用和一次检索"。

## 五、对接生产生态：Spring AI、OpenTelemetry 与后端

下面这些是**官方文档结论，未在本机验证**——我没有在本机跑 Spring AI 应用，也没有接入 Langfuse 或 ARMS。写这一段的目的不是让你照抄，而是告诉你上面手写的那套结构在生产里叫什么名字、由谁生成。

### 5.1 Spring AI：观测能力内建在框架层

Spring AI 的可观测性建立在 Spring 生态之上，为 `ChatClient`（含 `Advisor`）、`ChatModel`、`EmbeddingModel`、`ImageModel`、`VectorStore` 提供指标和链路追踪，开关由 Spring Boot Actuator 的 Metrics 与 Tracing 提供。也就是说，**你不用自己写 Span 类**——只要你用了 Spring AI 的 `ChatClient`，模型调用和工具调用的 Span 会自动生成。官方文档里几个关键 observation / span 名称：

| 观察对象 | 名称 | 关键属性 |
| --- | --- | --- |
| ChatClient 调用 | `spring.ai.chat.client` | `gen_ai.operation.name=framework`、`gen_ai.system=spring_ai`、`spring.ai.chat.client.stream` |
| ChatModel 调用 | `gen_ai.client.operation` | `gen_ai.operation.name`、`gen_ai.request.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens` |
| 工具调用 | `spring.ai.tool` | `gen_ai.operation.name=execute_tool`、`spring.ai.tool.definition.name`、`spring.ai.tool.call.id` |
| token 指标 | `gen_ai.client.token.usage` | 单次模型调用的输入/输出 token 用量 |

有几个默认值值得记住，因为它们直接对应第六节的坑：

- `spring.ai.chat.client.observations.log-prompt` 默认 `false`，`log-completion` 默认 `false`——**提示词和补全内容默认不记录**，因为可能含敏感信息。
- `spring.ai.chat.observations.include-error-logging` 默认 `false`。
- `spring.ai.tools.observations.include-content` 默认 `false`——**工具参数和返回值默认不写入 Span**。

把这套映射到我手写的实现：`spring.ai.chat.client` 对应我的 `agent.run` 之外的一层，`gen_ai.client.operation` 对应我的 `llm.chat step=N`，`spring.ai.tool` 对应我的 `tool.<name>`，`gen_ai.client.token.usage` 对应我从每个 MODEL Span 上累加的 token 指标。**字段名不同，结构和语义是一模一样的。**

来源：[Spring AI Observability](https://docs.spring.io/spring-ai/reference/observability/index.html)、[Spring Boot Tracing](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)、[Spring Boot Metrics](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)。

### 5.2 OpenTelemetry：GenAI 语义约定是通用语言

Spring Boot 的 Tracing 兼容 OpenTelemetry，Trace 可以通过 OTLP 导出。属性命名不是 Spring 自己定的，而是跟随 OpenTelemetry 的 GenAI 语义约定：`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.usage.total_tokens`、`gen_ai.operation.name`、`gen_ai.request.model`、`gen_ai.response.model` 这些都属于该约定。需要注意的是，GenAI 语义约定仍在演进，**官方页面已迁移**，最新内容以新仓库为准，使用前务必对照当前版本的文档，不要照抄旧版本里的属性名。

**工程上的实际意义**：只要你的埋点沿用 `gen_ai.*` 命名，换后端（从 Langfuse 换到自建 Jaeger、换到云厂商 APM）就不需要改业务代码——因为导出的是标准数据，而不是某个厂商的私有格式。这也是我在手写实现里坚持把 `kind`、`status`、`inputTokens` 拆成独立字段而不是塞进一个字符串的原因：**字段化的数据才能被下游转换，字符串只能被人读**。

来源：[OpenTelemetry GenAI Semantic Conventions](https://github.com/open-telemetry/semantic-conventions-genai)。

### 5.3 后端：Langfuse 与 ARMS

**Langfuse** 可以作为 OpenTelemetry 后端，接收 `/api/public/otel`（OTLP）端点的 trace，也可以直接从 OpenTelemetry Collector 导出。它会按属性把 OTel trace 映射到自己的数据模型，例如 `gen_ai.usage.*` 映射为 usageDetails、`gen_ai.usage.cost` 映射为 costDetails.total、`gen_ai.request.model` 映射为 model。它的 SDK 是**异步批量上报**，官方说明不会增加应用响应延迟。注意它要求 trace 的根 Span 必须上报，否则 trace 无法正确建立。

**阿里云 ARMS** 提供应用监控、可观测链路 OpenTelemetry 版等子产品，面向分布式 Java 应用支持调用链路、接口调用、慢事务等分析，属于"通用 APM + 自建 trace"的思路；如果团队已经在用 Java + Spring Boot 生态，接入成本相对低。

**选择建议**：如果只是想快速看到 Agent 轨迹和成本，先用 Langfuse 这类 LLM 专用后端，它原生理解 token、成本、prompt 这些概念；如果要和现有微服务链路（网关、RPC、DB）打通，走 OTel Collector + 通用 APM 更合适。**两者不互斥**：OTel Collector 可以同时导出到多个后端，这也正是标准化属性命名的价值。

来源：[Langfuse OpenTelemetry](https://langfuse.com/docs/opentelemetry/get-started)、[Langfuse Observability](https://langfuse.com/docs/observability/overview)、[阿里云 ARMS 产品概述](https://help.aliyun.com/zh/arms/product-overview/what-is-arms)。

## 六、六个常见坑

**坑一：只记成功，不记失败。** 场景 B 已经证明了：失败运行的 Span 才是有信息量的那些。如果只在 `try` 的正常路径上写埋点，异常抛出后 Span 不闭合、状态不记录，你在监控里看到的永远是"一切正常"。正确做法是埋点写在 `finally`，状态写在 `catch`。

**坑二：token 统计放在最外层。** 有人在 Agent 循环结束后统一算一次总 token。一旦中途熔断、超时或进程崩溃，这次运行的数据就全丢了——而这类运行恰恰是最该复盘的。正确做法是**每个模型调用结束时立即把 token 和费用写到该 Span 上**，逐层累加只是聚合视图，不是唯一数据源。我在场景 B 里能拿到"熔断退出时花了 95 token"，就是因为记账发生在每次调用之后。

**坑三：日志里打印完整上下文泄露隐私。** 这是最容易出安全事故的一条。完整 prompt 里可能有用户手机号、订单号、内部接口地址，甚至 API Key。Spring AI 把 `log-prompt`、`log-completion`、工具参数与结果全部默认设为 `false`，是有意为之的。我的实现里也做了 `preview(out, 56)` 截断——**默认只记摘要，需要排查时再按 trace 精确开启采样级别的详细记录**，而不是全量常开。

**坑四：采样率设置不当。** 生产不可能 100% 全采样：prompt 内容很占存储，全量上报会变成一笔新的成本。但 Agent 的采样和普通服务不一样——普通服务可以按比例随机采样，因为请求之间独立；Agent 出问题的运行往往集中在特定用户、特定工具、特定分支上，纯随机采样很容易采不到。**常见做法是"错误必采 + 慢请求必采 + 正常流量按低比例采"**，而不是一刀切。Spring Boot Tracing 文档里有采样相关配置，实施时要显式确认默认值（很多实现默认是概率采样而不是全采）。

**坑五：把高基数标签写进指标。** `userId`、`sessionId`、`traceId` 这类值的基数等于用户量，把它们作为 `gen_ai.*` 指标标签会导致时序库基数爆炸。OpenTelemetry 的规范思路是把**低基数标签进指标、高基数标签只进 trace**——Spring AI 文档里也是这么区分的。要在指标上按用户维度分析，正确做法是先用 trace 找到异常用户，再做专门的聚合，而不是把用户 ID 塞进时间序列。

**坑六：成本只算单价 × token。** 真实账单里还有几项容易被漏掉：**重试产生的重复调用**（所以埋点要记 `retryCount`）、**缓存命中的输入 token**（Spring AI 有 `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens` 这类属性，价格和普通输入不同）、**推理模型额外产生的思考 token**、以及**失败运行的沉没成本**。如果账本只算"成功请求的 token"，那它永远比真实账单少，而且少得没有规律——恰好是最不能用来做预算的那种账。

## 七、面试怎么答

如果面试官问"Agent 的可观测性怎么做"，我给一个三段式回答。

**第一句给结论**：Agent 的可观测性核心是把一次运行还原成一棵 Span 树（模型调用 / 工具调用 / 检索），在树上挂三样东西——耗时、token 与成本、失败状态；指标和成本账本都从这棵树上聚合出来。

**第二层讲为什么不能复用普通服务的做法**：一是非确定性使"重放复现"失效，只能靠轨迹留痕；二是调用形状是动态树而不是固定分层，平铺日志会丢掉父子关系；三是计费维度（token）在 Java 侧不可见，必须显式采集；四是失败经常"没有异常"，比如模型空转被最大步数截断。

**第三层讲取舍和坑**：失败路径必须也写 Span（`finally` 里结束、`catch` 里记状态）；token 和费用要在每次模型调用后就地记账，不能等运行结束统一算，否则中途失败丢数据；`stop != 模型给出最终回答` 的运行要单独计入失败率，不能只看返回内容非空；采样策略是"错误必采 + 慢请求必采 + 正常低比例"，而不是一刀切随机采；高基数标签只进 trace 不进指标。

可能被追问的几个点：

- **"怎么区分是模型慢还是工具慢？"** 看子 Span 耗时占比。我实测里模型占 170.7ms、工具不到 28ms，答案直接读出来。
- **"成本怎么算才准？"** 要么用模型 `usage` 字段返回的 token，要么按统一 tokenizer 估算，然后乘价目表；关键是记账粒度到单次调用，并额外覆盖重试、缓存命中、思考 token。
- **"你知道哪些现成方案？"** Spring AI 的 `spring.ai.tool`、`gen_ai.client.operation` 这些 observation 会自动产出 Span，属性跟随 OpenTelemetry GenAI 语义约定；后端可以接 Langfuse（LLM 专用，原生理解 token 和成本）或通用 APM（如 ARMS，便于和现有微服务链路打通），通过 OTLP 导出可以不绑定供应商。

## 小结

- Agent 的可观测性不是"多打点日志"，而是**把一次运行还原成树**：AGENT 根 Span 下挂 MODEL、TOOL、RETRIEVAL 三类子 Span，`parentId` 是树的骨架。
- 三类信号各有分工：**Span 树**定位"哪一步"，**指标**回答"多慢/多贵/多可靠"，**成本账本**回答"钱花在哪个模型、哪一步"。
- 埋点只需两个位置（模型调用、工具调用），但"失败也要埋"和"就地记账"是两条不可让步的原则；`stop` 属性是判断一次运行真成功还是被兜底截断的关键。
- 实测四个场景印证了三点：耗时要看结构占比、成本由 token 而非步数决定、任务成功与工具可靠必须分开统计。
- 生产里不需要手写这套：Spring AI 内建 observations，命名跟随 OpenTelemetry GenAI 语义约定，后端可接 Langfuse 或 ARMS（本节为官方文档结论，未在本机验证）。手写一遍的价值在于——当框架的 trace 断了、或者成本对不上账单时，你知道该检查哪一层的哪一步。

## 参考资料

- Spring AI Observability 官方文档：https://docs.spring.io/spring-ai/reference/observability/index.html
- Spring Boot Tracing（Micrometer Tracing / OpenTelemetry）：https://docs.spring.io/spring-boot/reference/actuator/tracing.html
- Spring Boot Metrics（Actuator）：https://docs.spring.io/spring-boot/reference/actuator/metrics.html
- OpenTelemetry GenAI 语义约定（已迁移至新仓库）：https://github.com/open-telemetry/semantic-conventions-genai
- Langfuse OpenTelemetry 接入：https://langfuse.com/docs/opentelemetry/get-started
- Langfuse Observability 概述：https://langfuse.com/docs/observability/overview
- 阿里云 ARMS 产品概述：https://help.aliyun.com/zh/arms/product-overview/what-is-arms
