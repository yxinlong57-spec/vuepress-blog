---
title: "不用框架手写一个最小 Agent 循环：最大步数、停止条件和失控熔断怎么设计"
description: "不用框架手写最小 Agent 循环：最大步数、停止条件和失控熔断的设计要点。"
shortTitle: "手写最小 Agent 循环"
date: 2026-10-13
category:
  - Agent
tag:
  - AI Agent
  - Agent 循环
  - 熔断
order: 8
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK 单文件，无第三方依赖
> 说明：本文的 LLM 用按脚本输出的 Mock 代替，保证实验可复现；Agent 循环本身（步数上限、重复调用检测、错误熔断、停止条件）是真实实现并在本机跑通。换成真实模型 API 时，循环代码不变，只替换 `chat()` 的实现。

**目录**

- 为什么要手写一遍 Agent 循环
- Agent 循环的骨架：拆开以后它就是一个带保护的 while
- 实验设计：用 MockLLM 换可复现性
- 核心代码：工具层、协议解析和循环控制
- 场景 A：一个正常任务跑完四步
- 场景 B/C/D：三种失控方式，三种拦截手段
- 这个最小实现和生产级 Agent 的差距
- 小结

## 为什么要手写一遍 Agent 循环

学 Agent 开发时，大多数人（包括我自己）的第一步是接框架：LangChain4j、Spring AI，或者直接用模型厂商的 Agent SDK。框架用起来很顺，但用一段时间会遇到一个尴尬的问题——Agent 行为异常时，你不知道该怀疑模型、提示词、工具定义，还是框架的某层封装。

我的处理方式是回到骨架：不依赖任何框架，用纯 JDK 把 Agent 循环手写一遍，故意制造几种失控场景，看循环的控制逻辑能不能拦住。结论先说：

1. Agent 循环拆开以后没有神秘性，本质是一个"LLM 决策 → 工具执行 → 观察写回上下文"的 while 循环。
2. 真正决定一个 Agent 能不能用在生产环境的，不是循环本身，而是循环外面的保护层：最大步数、重复调用检测、错误熔断、明确的停止条件。
3. 模型失控是常态而不是小概率事件。重复调用同一个工具、输出格式漂移、参数和工具协议对不上，这三种情况在真实模型上都会发生，循环必须能在不依赖模型"自觉"的情况下终止。

下面给出完整实现和四个场景的实测输出。

## Agent 循环的骨架：拆开以后它就是一个带保护的 while

ReAct 论文（Yao et al., 2022）把 Agent 的单轮结构描述为 Thought → Action → Observation：模型先推理，再决定调什么工具，然后把工具返回的观察结果写回上下文，进入下一轮。工程实现里，这个结构就是一个循环：

```text
history = [用户任务, 系统提示(工具清单+输出协议)]
loop:
    output = LLM(history)            # 模型决策
    if output 是最终回答: return     # 停止条件 1
    if output 是工具调用:
        result = 执行工具(output)
        history += [output, result]  # 观察写回上下文
    检查保护层                        # 停止条件 2/3/4
```

所有框架做的，是在这个骨架上叠加：结构化输出解析（function calling）、并行工具调用、token 预算统计、重试、可观测性。骨架本身几十行代码就能写完，这篇文章就把它写完，并重点处理三件事：

- **什么时候停**：模型给出最终回答时停。
- **模型不停怎么办**：达到最大步数强制停。
- **模型乱来怎么办**：重复调用检测和连续错误熔断。

![最小 Agent 循环结构](/images/agent/minimal-agent-loop/01-agent-loop.svg)

## 实验设计：用 MockLLM 换可复现性

直接接真实模型做实验有两个问题：每次运行结果不一样，文章里的输出读者无法复现；而且为了演示"失控"，你得真的等到模型失控。所以我用一个按脚本输出的 `MockLLM` 代替真实模型，循环逻辑全部真实实现。

LLM 和循环之间约定一个教学用的输出协议，一行一条：

```text
TOOL <工具名> key=value,key=value    # 调用工具
FINAL <文本>                         # 给出最终回答，结束循环
```

真实系统里这个位置对应的是 function calling 的结构化输出（模型返回 `tool_calls` 字段而不是自然语言文本）。协议形式不同，循环结构完全一样。

准备三个工具：加法 `add(a,b)`、乘法 `mul(a,b)`、当前时间 `now()`。任务选一个需要多步的："计算 (3+4)*5，并告诉我现在几点"——模型必须先加、再乘、再查时间，最后汇总。

## 核心代码：工具层、协议解析和循环控制

工具层是一个接口加三个实现。注意 `add` 的参数校验：解析失败时不抛异常，而是返回 `TOOL_ERROR:` 开头的字符串。这是故意的——工具的错误信息要作为观察结果喂回给模型，让模型有机会自我修正，而不是让整个循环崩掉。

```java
interface Tool {
    String name();
    String description();
    String call(Map<String, String> args);
}

static class AddTool implements Tool {
    public String name() { return "add"; }
    public String description() { return "add(a,b): 计算两个整数的和"; }
    public String call(Map<String, String> args) {
        try {
            int a = Integer.parseInt(args.getOrDefault("a", ""));
            int b = Integer.parseInt(args.getOrDefault("b", ""));
            return String.valueOf(a + b);
        } catch (NumberFormatException e) {
            return "TOOL_ERROR: add 的参数必须是整数，收到 a=" + args.get("a")
                    + ", b=" + args.get("b");
        }
    }
}
```

循环控制是全文重点。每一轮做五件事：拿模型输出、判断是否结束、解析工具调用、执行工具、检查保护层。

```java
String run(String task, MockLLM llm) {
    List<String> history = new ArrayList<>();
    history.add("USER: " + task);
    history.add("SYSTEM: 可用工具: " + toolDescriptions()
            + "。每轮只允许输出一行：TOOL <name> k=v,k=v 或 FINAL <answer>");

    String lastCallSignature = null;   // 上一次工具调用的签名，用于重复检测
    int repeatCount = 0;
    int consecutiveErrors = 0;         // 连续错误计数，用于熔断

    for (int step = 1; step <= maxSteps; step++) {
        String out = llm.chat(history).trim();

        if (out.startsWith("FINAL")) {                 // 停止条件 1：模型给出答案
            return out.substring("FINAL".length()).trim();
        }

        if (!out.startsWith("TOOL")) {                 // 输出格式漂移
            consecutiveErrors++;
            history.add("ASSISTANT: " + out);
            history.add("SYSTEM: 输出格式无法解析，请严格使用 TOOL/FINAL 协议");
            if (consecutiveErrors >= maxConsecutiveErrors) {
                return "终止：连续 " + consecutiveErrors + " 次输出无法解析，熔断退出";
            }
            continue;
        }

        // 解析 TOOL 行，得到 toolName 和 args（解析代码略，见完整源码）

        String signature = toolName + args;            // 停止条件 2：重复调用检测
        if (signature.equals(lastCallSignature)) {
            repeatCount++;
            if (repeatCount >= 2) {
                return "终止：检测到重复调用 " + toolName + args + "，模型陷入循环";
            }
        } else {
            repeatCount = 0;
        }
        lastCallSignature = signature;

        Tool tool = tools.get(toolName);
        String result = (tool == null)
                ? "TOOL_ERROR: 未注册的工具 " + toolName
                : tool.call(args);

        if (result.startsWith("TOOL_ERROR")) {         // 停止条件 3：连续错误熔断
            consecutiveErrors++;
            if (consecutiveErrors >= maxConsecutiveErrors) {
                return "终止：连续 " + consecutiveErrors + " 次工具调用失败，熔断退出";
            }
        } else {
            consecutiveErrors = 0;
        }

        history.add("ASSISTANT: " + out);              // 观察写回上下文
        history.add("OBSERVATION: " + result);
    }
    return "终止：达到最大步数 " + maxSteps + "，强制停止";  // 停止条件 4：兜底
}
```

几个设计取舍说明一下：

- **重复检测用的是"工具名 + 参数"的签名**，不是单纯的工具名。任务里连续调两次 `add` 是合理的（比如算 `(1+2)+(3+4)`），但用同样的参数调第二次一定是卡住——观察结果已经在上下文里了，再问一遍不会得到新信息。
- **连续错误才熔断，单次错误不熔断**。模型看到 `TOOL_ERROR` 后自我修正（比如把中文数字改成阿拉伯数字）是真实存在的恢复路径，给它一两次机会是划算的；连续失败才说明协议真的对不上。
- **最大步数是最后兜底**，不是主要停止手段。如果一个 Agent 经常靠最大步数停下来，说明任务拆解或提示词有问题，而不是保护生效了。

## 场景 A：一个正常任务跑完四步

任务："计算 (3+4)*5，并告诉我现在几点"。MockLLM 的脚本是正常决策序列。实测输出：

```text
===== 场景 A：正常任务 (3+4)*5 等于多少，现在几点 =====
[step 1] LLM 输出: TOOL add a=3,b=4
[step 1] 工具 add 返回: 7
[step 2] LLM 输出: TOOL mul a=7,b=5
[step 2] 工具 mul 返回: 35
[step 3] LLM 输出: TOOL now
[step 3] 工具 now 返回: Tue Oct 13 18:57:35 CST 2026
[step 4] LLM 输出: FINAL (3+4)*5 = 35；当前时间见最后一次观察结果。
[step 4] 收到 FINAL，循环正常结束
最终回答: (3+4)*5 = 35；当前时间见最后一次观察结果。
LLM 调用次数: 4
```

四步收敛。注意 step 2：模型拿到的输入里已经有 `OBSERVATION: 7`，所以它能把 7 作为 `mul` 的第一个参数传进去——这就是"观察写回上下文"的实际作用，模型每一步的决策都基于此前全部历史。

## 场景 B/C/D：三种失控方式，三种拦截手段

保护层的价值只有在失控时才看得见。我构造了三种真实模型上都会出现的情况。

**场景 B：模型重复调用同一个工具、同样的参数。** 真实模型在长上下文或提示词不清晰时会这样"复读"。实测：

```text
[step 1] LLM 输出: TOOL add a=3,b=4
[step 1] 工具 add 返回: 7
[step 2] LLM 输出: TOOL add a=3,b=4
[step 2] 工具 add 返回: 7
[step 3] LLM 输出: TOOL add a=3,b=4
最终回答: 终止：检测到重复调用 add{a=3, b=4}，模型陷入循环
LLM 调用次数: 3
```

第 3 步触发重复检测，循环在第 3 次调用时终止。如果没有这层检测，这个循环会一直烧到最大步数，每一步都是一次真实的模型调用——花的都是 token 预算。

**场景 C：参数类型错误 + 调用未注册的工具。** 这对应真实场景里的 function calling 参数校验失败和幻觉工具名：

```text
[step 1] LLM 输出: TOOL add a=三,b=四
[step 1] 工具 add 返回: TOOL_ERROR: add 的参数必须是整数，收到 a=三, b=四
[step 2] LLM 输出: TOOL search q=天气
[step 2] 工具 search 返回: TOOL_ERROR: 未注册的工具 search
最终回答: 终止：连续 2 次工具调用失败，熔断退出
LLM 调用次数: 2
```

脚本里其实还有第三条 `FINAL 我不知道`，但循环在第 2 步就熔断了——连续两次工具错误说明模型和工具协议已经对不上，再给机会大概率也是浪费调用。熔断计数 `maxConsecutiveErrors=2` 是个可调的阈值，工具复杂、参数容易错时可以放宽到 3。

**场景 D：模型失控，但每次调用的参数略有不同。** MockLLM 在脚本用尽后设计为无限调用 `add`，且每次把第二个参数加一——这模拟一种更隐蔽的失控：模型没有完全复读，而是每次微调参数再试一次。签名检测对这种模式失效，实测只能靠最大步数兜底：

```text
[step 1] LLM 输出: TOOL add a=1,b=1
[step 1] 工具 add 返回: 2
[step 2] LLM 输出: TOOL add a=1,b=2
[step 2] 工具 add 返回: 3
[step 3] LLM 输出: TOOL add a=1,b=3
[step 3] 工具 add 返回: 4
[step 4] LLM 输出: TOOL add a=1,b=4
[step 4] 工具 add 返回: 5
[step 5] LLM 输出: TOOL add a=1,b=5
[step 5] 工具 add 返回: 6
[step 6] LLM 输出: TOOL add a=1,b=6
[step 6] 工具 add 返回: 7
最终回答: 终止：达到最大步数 6，强制停止（防止无限循环烧光预算）
LLM 调用次数: 6
```

6 步跑满，被最大步数强制停止。这正是最大步数存在的意义：它不关心模型在干什么、用的是什么模式，只保证循环一定有界。真实系统里这一层对应的是 token 预算上限——比步数更精确的"必须停"信号。

三层保护的触发顺序因此是：重复检测最灵敏，先抓同参数复读；错误熔断抓协议层面的持续失败；最大步数无差别兜底。设计上这是故意的：越靠前的层越便宜（少花 token），越靠后的层越可靠（不依赖任何模式识别）。

## 这个最小实现和生产级 Agent 的差距

这个 200 行的实现能让你看清骨架，但离生产还差得远，主要差在：

- **结构化输出**。真实系统用 function calling，模型返回的是带 schema 的 `tool_calls`，不存在"解析一行文本"的脆弱性。我的教学协议遇到模型输出多余空白就会解析失败，生产里这层由厂商 API 保证。
- **token 预算**。最大步数只是预算的粗略代理。真实场景每一步的上下文都在变长，需要按累计 token 设上限，配合上下文截断或摘要。
- **并行工具调用**。`add(3,4)` 和 `now()` 互不依赖，真实 function calling 支持一轮返回多个 `tool_calls` 并行执行，我的循环是严格串行的。
- **超时与副作用**。真实工具会访问网络、数据库，需要超时控制；有副作用的工具（写库、发消息）还需要人工确认节点，不能放进自由循环。
- **可观测性**。生产环境要把每一步的输入输出、延迟、token 消耗打进日志和 trace，否则线上行为不可复盘。本文的 `System.out.println` 就是最小形态的 trace。

这些差距不是劝退，而是读框架源码时的地图：知道了骨架和保护层在哪，再去看 LangChain4j 的 `AiServices`、Spring AI 的 `ChatClient` 工具调用链，你就能分辨哪些是骨架、哪些是框架加的保护、哪些只是语法糖。

## 小结

- Agent 循环的本质是"LLM 决策 → 工具执行 → 观察写回"的 while，几十行代码就能写出来。
- 循环简单，保护层才是工程：停止条件（FINAL）、最大步数（兜底）、重复调用检测（防复读）、连续错误熔断（防协议错位），四层缺一不可。
- 工具错误要以文本形式喂回上下文，给模型自我修正的机会；但连续失败必须熔断。
- 建议每个学 Agent 框架的人都手写一遍这个循环。之后框架里任何一层行为异常，你都能定位到它属于骨架的哪一环。
