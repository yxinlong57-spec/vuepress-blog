---
title: "Agent 工作流编排：用 Java 手写一个带状态、检查点和人工介入的图编排引擎"
shortTitle: "工作流编排"
date: 2026-10-19
description: "用纯 JDK 手写一个图编排引擎：状态图、条件边、检查点落盘、人工介入中断恢复和最大步数兜底，并跑通客服工单分诊案例。"
category:
  - Agent
tag:
  - AI Agent
  - 工作流编排
  - 状态图
  - Java
order: 17
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin）
> 说明：本文的图编排引擎是纯 JDK 单文件实现（无第三方依赖，`java WorkflowDemo.java` 可直接运行），下面的运行输出都是本机真实执行结果。案例里的"模型"用关键词匹配的 MockLLM 代替，保证可复现；换成真实模型 API 时，只有节点内部换调用，引擎部分一行不用改。LangGraph4j、Spring AI 等框架的 API 概念来自官方文档与官方仓库，**未在本机运行验证**，文中已逐处标注。

用 while 循环跑 Agent 一开始很顺，直到你开始加需求：退款类工单要先人工审核、咨询类要直接查知识库；某一步失败要重试两次；审核要等外部人点了"通过"才能继续；服务重启后任务得从断的地方接着跑。这些需求最后全挤进同一个循环体里——分支判断夹在工具调用之间，重试计数和审批状态散在七八个变量里，进程一重启，"跑到哪一步了"直接丢失。

我的结论是：把编排从循环里抽出来，做成一张**状态图 + 检查点**。节点只做一件小事、只返回状态"增量"；边负责决定下一步去哪；每执行一步就把状态存成检查点；人工介入不再是特殊逻辑，而是"中断后从检查点恢复"。这篇用纯 JDK 手写一个两百行左右的图编排引擎，真实跑通条件路由、检查点落盘、中断恢复和最大步数兜底，再用它搭一个客服工单分诊工作流。

**目录**

- 一、循环式 Agent 还是工作流：先做取舍
- 二、图编排的四个基本概念
- 三、手写最小图编排引擎
- 四、人工介入：中断、检查点与恢复
- 五、案例：客服工单分诊工作流
- 六、和 LangGraph4j、Spring AI 生态对照
- 七、常见坑
- 八、面试视角
- 小结

## 一、循环式 Agent 还是工作流：先做取舍

多 Agent 那篇文章里我用成本结构回答了"单 Agent / 固定 Workflow / 多 Agent 怎么选"，这里补另一半：**可控性和自主性怎么选**。

循环式 Agent 的核心是：模型自己决定下一步调什么工具、调几次、什么时候停。它擅长"步骤事先不知道"的任务，代价是行为不可预测——同一句话两次运行的路径可能不同，出错点也不固定。

工作流（workflow）反过来：流程由人画成一张图，模型只在被指定的节点里干活（分类、总结、生成答复），往哪走由边决定。它的优势是**每一步都看得见、可复现、可审计**，代价是流程形状必须事先想清楚。

这两者不是对立选项，而是一条光谱：

| 维度 | 循环式 Agent | 图工作流 |
| --- | --- | --- |
| 谁决定下一步 | 模型 | 边（代码 / 条件函数） |
| 步骤是否可预测 | 否，运行期动态 | 是，拓扑在编译期固定 |
| 出错定位 | 难，要翻整段上下文 | 易，出错节点就是坐标 |
| 断点续跑 | 需要额外设计 | 检查点天然支持 |
| 人工介入 | 要打断自由循环，笨拙 | 中断某个节点即可 |
| 适合的任务 | 探索型、拆解方式未知 | 有边界、步骤可枚举 |
| 典型生产场景 | 研究、调试、开放式助手 | 客服分诊、审批、审校、ETL 式流水线 |

生产环境里真正占多数的，是**有边界的工作流**：退款要审核、咨询走知识库、内容发布前要过一遍审校。这类任务用循环式 Agent 会带来两个麻烦——一是流程不可审计，二是人没法"在中间插一脚"。用图工作流则反过来：想加一个审核环节，就是在图上加一个节点和一条边。

所以本文讨论的编排引擎，服务的是那段光谱偏"可控"的一侧：**允许节点内部调模型，但整体控制流由人掌握**。

## 二、图编排的四个基本概念

在写代码之前，先把四个概念钉死，它们后面每一个都会落到具体的数据结构上。

**节点（Node）**：图里的一个执行单元。约定是——读整个状态，做一件事，返回**增量**（要改的键），而不是返回一个新的完整状态。这个约定是后面所有好处的来源：节点之间没有直接引用，靠状态通信，因此每个节点可以单独测试。

**边（Edge）**：决定"这一步之后去哪"。分两种：

- **固定边**：`addEdge("intake", "classify")`，永远跳到同一个节点，本质是常量路由。
- **条件边**：`addConditionalEdges("classify", 路由函数, 允许的目标集合)`，路由函数读状态、返回下一个节点名。条件边必须**声明允许的目标集合**，路由函数返回集合外的值时立刻报错——这是防死循环的兜底，后面第七节会看到不加它会怎样。

**状态（State）**：整张图共享的上下文，实现成一个 `Map<String, Object>`。关键约束是**不可变传递**：引擎每一步都基于旧状态生成一个新的 Map 再传给下一个节点，节点拿到的是一份只读视图，想改只能通过返回增量。为什么要这么严？因为状态要被检查点序列化、要能在恢复时重建。如果节点可以就地改状态对象，那么"检查点里存的是什么"就依赖于对象引用的历史，恢复出来的状态和当时看到的可能不一致。

**检查点（Checkpoint）**：某个时刻的完整快照——当前状态、下一个待执行节点、已执行步数、状态标记（运行中 / 已中断 / 已完成）。它必须可序列化，因为要落盘、要在另一个进程里读回来。检查点同时承担三个职能：调试（打点看状态）、续跑（从断点继续）、人工介入（中断就是一种检查点状态）。

有一个概念要提前说清楚：检查点按 **threadId（会话 / 任务 id）** 隔离。一个 threadId 对应一次任务的全部历史，不同用户、不同任务互不干扰——这是后面"模拟进程重启"能成立的前提。

## 三、手写最小图编排引擎

目标很明确：不引入任何依赖，用纯 JDK 把上面四个概念实现出来，并且真实跑通。完整文件是 `WorkflowDemo.java`（486 行，其中引擎主体——抽象接口、检查点、图定义、执行循环——约 210 行，其余是案例和反例场景），运行命令就一条：

```bash
java WorkflowDemo.java
```

Windows PowerShell 下中文输出容易乱码，把输出重定向到文件再读，实测这样最稳：

```bash
java "-Dfile.encoding=UTF-8" WorkflowDemo.java > out.txt 2>&1
```

先说数据结构。状态用 `Map<String, Object>`；节点接口的返回值刻意声明成 `Map<String, Object>`（增量）而不是状态本体：

```java
/** 节点：读状态，返回"增量"，不返回完整状态 */
interface Node {
    String name();
    Map<String, Object> run(Map<String, Object> state);
}

/** 边：根据状态决定下一个节点（固定边就是常量路由） */
interface Router {
    String route(Map<String, Object> state);
}
```

检查点是一个可序列化的不可变对象，字段就是恢复所需的全部信息：

```java
static class Checkpoint implements Serializable {
    private static final long serialVersionUID = 1L;
    final String threadId;
    final String nextNode;              // 下一个待执行节点
    final Map<String, Object> state;    // 中断 / 完成时的完整状态
    final int step;                     // 已执行步数
    final String status;                // RUNNING / INTERRUPTED / DONE
    final String reason;
    // 构造器与 toString 略
}
```

检查点存储同时写内存和文件：内存用于本进程快速读写，文件用于跨进程恢复（模拟服务重启）。

```java
static class CheckpointStore {
    private final Map<String, Checkpoint> memory = new HashMap<>();
    private final File dir;

    void save(Checkpoint cp) throws IOException {
        memory.put(cp.threadId, cp);
        File f = new File(dir, "ckpt-" + cp.threadId + ".bin");
        try (ObjectOutputStream oos = new ObjectOutputStream(new FileOutputStream(f))) {
            oos.writeObject(cp);        // 序列化落盘
        }
    }

    Checkpoint load(String threadId) throws IOException, ClassNotFoundException {
        Checkpoint mem = memory.get(threadId);
        if (mem != null) {
            return mem;                 // 优先读内存
        }
        File f = new File(dir, "ckpt-" + threadId + ".bin");
        if (!f.exists()) {
            return null;
        }
        try (ObjectInputStream ois = new ObjectInputStream(new FileInputStream(f))) {
            return (Checkpoint) ois.readObject();   // 内存没有就读文件
        }
    }
}
```

图定义部分负责收集节点、边、中断点和入口，并在编译时做一次结构校验（有节点没有出边就报错）：

```java
static class StateGraph {
    final Map<String, Node> nodes = new LinkedHashMap<>();
    final Map<String, Router> routers = new LinkedHashMap<>();
    final Map<String, Set<String>> allowedTargets = new HashMap<>();
    final Set<String> interruptBefore = new LinkedHashSet<>();
    String entry;

    StateGraph addNode(Node n) { nodes.put(n.name(), n); return this; }

    StateGraph addEdge(String from, String to) {          // 固定边
        routers.put(from, s -> to);
        return this;
    }

    /** 条件边：必须声明允许的目标集合，越界立即报错，防死循环 */
    StateGraph addConditionalEdges(String from, Router r, Set<String> targets) {
        routers.put(from, r);
        allowedTargets.put(from, targets);
        return this;
    }

    /** 在这些节点执行前中断，等待人工确认 */
    StateGraph interruptBefore(String... names) {
        interruptBefore.addAll(Arrays.asList(names));
        return this;
    }

    CompiledGraph compile(int maxSteps, CheckpointStore store) throws Exception {
        if (entry == null) {
            throw new IllegalStateException("没有设置入口节点");
        }
        for (String name : nodes.keySet()) {
            if (!routers.containsKey(name)) {
                throw new IllegalStateException("节点 " + name + " 没有出边，图不完整");
            }
        }
        return new CompiledGraph(this, maxSteps, store);
    }
}
```

真正干活的是 `CompiledGraph` 里那个循环。它把"执行节点 → 合并状态 → 路由、校验 → 循环或中断"这一步一步串起来，同时处理三件兜底的事：进入中断点前存检查点、超过最大步数强制停、路由目标越界报错。

```java
private GraphResult runLoop(String threadId, Map<String, Object> state,
                            int step, String current, boolean skipInterruptOnce) throws Exception {
    while (true) {
        if (END.equals(current)) {
            store.save(new Checkpoint(threadId, END, state, step, "DONE", null));
            return new GraphResult("DONE", state, step, null);
        }
        // 中断点：进入节点前存检查点并交还控制权
        if (!skipInterruptOnce && g.interruptBefore.contains(current)) {
            store.save(new Checkpoint(threadId, current, state, step, "INTERRUPTED",
                    "进入节点 " + current + " 前需要人工确认"));
            return new GraphResult("INTERRUPTED", state, step, current);
        }
        skipInterruptOnce = false;

        if (step >= maxSteps) {            // 兜底：不允许无限跑
            return new GraphResult("MAX_STEPS", state, step, current);
        }

        Node node = g.nodes.get(current);
        // 传给节点的是只读视图，就地 put 会直接抛异常
        Map<String, Object> delta = node.run(Collections.unmodifiableMap(state));

        Map<String, Object> merged = new LinkedHashMap<>(state);   // 新 Map，不碰旧状态
        if (delta != null) {
            merged.putAll(delta);
        }
        state = merged;
        step++;

        String target = g.routers.get(current).route(state);
        Set<String> allowed = g.allowedTargets.get(current);
        if (allowed != null && !allowed.contains(target)) {
            throw new IllegalStateException("节点 " + current + " 返回了未声明的目标: " + target);
        }
        if (!END.equals(target) && !g.nodes.containsKey(target)) {
            throw new IllegalStateException("路由到不存在的节点: " + target);
        }
        current = target;
    }
}
```

`invoke(threadId, input)` 和 `resume(threadId, humanInput)` 都只是组装起始条件后调用这个循环：

```java
GraphResult invoke(String threadId, Map<String, Object> input) throws Exception {
    return runLoop(threadId, new LinkedHashMap<>(input), 0, g.entry, false);
}

GraphResult resume(String threadId, Map<String, Object> humanInput)
        throws IOException, ClassNotFoundException, Exception {
    Checkpoint cp = store.load(threadId);
    if (cp == null) {
        throw new IllegalStateException("找不到 threadId=" + threadId + " 的检查点");
    }
    if (!"INTERRUPTED".equals(cp.status)) {
        throw new IllegalStateException("检查点状态是 " + cp.status + "，不是 INTERRUPTED，不能恢复");
    }
    Map<String, Object> state = new LinkedHashMap<>(cp.state);
    state.putAll(humanInput);   // 人工输入与旧状态合并
    return runLoop(threadId, state, cp.step, cp.nextNode, true);
}
```

几个设计点解释一下：

- **状态合并用 `new LinkedHashMap<>(state)` 而不是复用旧 Map。** 用 `LinkedHashMap` 是为了打印时键顺序稳定、输出可复现；用新 Map 是为了让旧状态对象（可能正被某个检查点引用）不被后续步骤污染。
- **节点拿到的是 `Collections.unmodifiableMap(state)`。** 这不是防御性编程，是故意的约束：节点想违规就地改状态会立刻抛 `UnsupportedOperationException`，把 bug 暴露在编写期，而不是等到恢复时才表现为"状态对不上"。
- **条件边强制声明目标集合。** 路由函数是普通 Java 函数，写错了没人拦得住；但"返回值必须落在声明的集合里"这一条，能把"路由到不存在的节点"这种错误在第一次运行时变成一条明确的异常。
- **最大步数是兜底而非主要停止手段。** 正常情况下图应该靠 `archive → END` 自然结束；`MAX_STEPS` 只在边设计出错时触发，见第七节场景 4。

## 四、人工介入：中断、检查点与恢复

人工介入（human-in-the-loop）在图编排里不是一层额外逻辑，而是"中断 + 检查点 + 恢复"三个已有能力的组合。流程只有三步：

1. 运行到中断点前，存下检查点，标记 `INTERRUPTED`，把控制权交还给调用方；
2. 调用方（人或另一个服务）看完状态，给出决定；
3. 带 `threadId` 调用 `resume`，引擎读出检查点、把人工输入并进旧状态、从 `nextNode` 继续跑。

下面这段是真实运行输出（`java "-Dfile.encoding=UTF-8" WorkflowDemo.java`），跑一条退款工单：

```text
===== 场景 1：退款工单，条件分支命中人工介入 =====
invoke 返回: INTERRUPTED，停在节点 riskReview，已执行 2 步
中断时状态: {raw=我的订单 8 天还没发货，我要退款, ticketText=我的订单 8 天还没发货，我要退款, ticketType=REFUND}
本轮 LLM 调用次数: 1
检查点: Checkpoint{thread=t-refund-001, next=riskReview, step=2, status=INTERRUPTED, state={raw=..., ticketText=..., ticketType=REFUND}}
-- 外部审批通过，从检查点恢复 --
恢复返回: DONE，共执行 4 步
最终状态: {raw=..., ticketText=..., ticketType=REFUND, approval=APPROVED, reviewer=zhangsan, riskDecision=退款已批准, reviewedBy=zhangsan, ticketStatus=CLOSED}
```

拆开看这次运行：

- `intake`、`classify` 两个节点先跑完（2 步），`ticketType=REFUND`；
- 引擎准备进入 `riskReview`，发现它在 `interruptBefore` 集合里，于是存检查点、返回 `INTERRUPTED`；
- 外部代码调用 `resume("t-refund-001", {approval: APPROVED, reviewer: zhangsan})`，人工输入被并进旧状态，`riskReview` 读 `approval` 做出结论，之后 `archive` 收尾，状态来到 `DONE`；
- 中断时状态里只有 `raw / ticketText / ticketType`，`approval / reviewer` 是恢复时才出现的新键——这正是"人工输入与旧状态合并"的效果。

更值得验证的是**跨进程恢复**。把检查点写到文件后，即使内存清空，也应该能接着跑。所以我新建了一个内存空的 store 和一个新的 graph 实例，只从文件读：

```text
===== 场景 3：模拟进程重启，内存清空后只从文件恢复 =====
invoke 返回: INTERRUPTED，停在节点 riskReview
中断时状态: {raw=买错了，申请退款, ticketText=买错了，申请退款, ticketType=REFUND}
新 store 内存里查 t-refund-002: null
重启后恢复返回: DONE，共执行 4 步
最终状态: {raw=..., ticketText=..., ticketType=REFUND, approval=APPROVED, reviewer=lisi, riskDecision=退款已批准, reviewedBy=lisi, ticketStatus=CLOSED}
```

`新 store 内存里查 t-refund-002: null` 是关键一行：内存里确实什么都没有，但 `resume` 仍然成功，因为检查点已经落盘。这条路径对应的真实场景是——审批人第二天才点通过，中间服务重启过一次，甚至这台机器都不是原来那台。

从工程角度看，这套机制解决的是三个以前要靠外部系统硬撑的问题：**长任务的持久化**（不用自己维护一张任务表）、**审批环节**（不用在业务代码里写"卡住等人"的轮询）、**失败后的继续**（从最后一个检查点重放，而不是从头再来）。

## 五、案例：客服工单分诊工作流

用这套引擎搭一个客服工单分诊流程。五个节点，一个条件分支，一个人工介入点：

| 节点 | 职责 | 写出的状态键 |
| --- | --- | --- |
| `intake` | 接收原始工单，规整文本 | `ticketText` |
| `classify` | 调模型分类（MockLLM） | `ticketType`（REFUND / CONSULT / OTHER） |
| `riskReview` | 人工审核退款（中断点） | `riskDecision`、`reviewedBy` |
| `answer` | 咨询类：查知识库生成答复 | `reply` |
| `archive` | 归档，写终态 | `ticketStatus` |

拓扑用一个文本图表示（不放图片，避免仓库缺图 404）：

```text
START → intake → classify ──(ticketType=REFUND)──▶ riskReview ──▶ archive → END
                            └─(CONSULT / OTHER)───▶ answer ─────▶ archive → END
                            ↑ interruptBefore("riskReview")
```

图定义代码（就是上面那几个 API 的调用顺序）：

```java
g.setEntry("intake");
g.addEdge("intake", "classify");
g.addConditionalEdges("classify",
        s -> "REFUND".equals(s.get("ticketType")) ? "riskReview" : "answer",
        new LinkedHashSet<>(Arrays.asList("riskReview", "answer")));
g.addEdge("riskReview", "archive");
g.addEdge("answer", "archive");
g.addEdge("archive", END);
g.interruptBefore("riskReview");
```

注意 `interruptBefore("riskReview")` 只对走进这个节点的路径生效。走咨询分支的工单根本不会进 `riskReview`，所以不触发中断——这是条件边加中断点组合出来的效果，不需要额外写判断。实测两条分支：

```text
===== 场景 2：咨询工单，条件分支走另一条边，不触发中断 =====
返回: DONE，共执行 4 步
最终状态: {raw=请问优惠券怎么使用, ticketText=请问优惠券怎么使用, ticketType=CONSULT, reply=【知识库答复】针对「请问优惠券怎么使用…」，请查看帮助中心的对应条目。, ticketStatus=CLOSED}
```

咨询工单 4 步跑完，没有中断，`classify` 输出 `CONSULT`，条件边直接路由到 `answer`。同一张图、同一套引擎，退款和咨询走的是两条边，而"哪条边"完全由 `classify` 写进状态的 `ticketType` 决定——**节点只负责记录事实，边负责把事实翻译成路由**。这也是图工作流最好调试的地方：想知道为什么走了这条路，看状态里那个键的值就够了。

## 六、和 LangGraph4j、Spring AI 生态对照

手写完再回头看框架，会清楚很多。下面这些概念来自官方仓库和官方文档，**未在本机运行验证**，只用于对照，不作为"我跑过"的结论。

**LangGraph4j**（`org.bsc.langgraph4j`，官方仓库 README 显示最新为 1.9.6，基线 Java 17+，1.8.x 是 LTS）是 Python LangGraph 的 Java 对应实现，核心概念和本文几乎是同构的：

| 本文实现 | LangGraph4j 对应 | 说明 |
| --- | --- | --- |
| `Map<String,Object>` 状态 | `AgentState`（或子类） | 状态本体就是一个 `Map<String, Object>` |
| 节点返回增量 | `NodeAction<S>.apply` 返回 `Map<String,Object>` | 同样是"返回局部更新"，由框架按 schema 合并 |
| 手工 `putAll` 合并 | `Channel.Reducer` / schema | 每个键声明合并策略；`Channels.appender` 是追加、普通键是覆盖 |
| `Router` 接口 | `EdgeAction<S>`，配合 `addConditionalEdges` | 函数式路由 |
| `compile()` | `StateGraph.compile(...)` → `CompiledGraph<S>` | 编译后得到不可变可运行对象 |
| `Checkpoint` + 文件/Memory | `Checkpoint` + `CheckpointSaver`（`MemorySaver`、PostgresSaver 等） | 通过 `CompileConfig.builder().checkpointSaver(...)` 挂载 |
| `threadId` | `RunnableConfig` 里的 threadId | 一个线程一份状态历史 |
| `interruptBefore` | 中断 / `InterruptionMetadata` | 官方文档与社区文章确认支持中断语义 |

LangGraph4j 用 `Channels` 显式声明每个键的合并策略，比本文"统一覆盖 + 节点自己返回新集合"更省心，代价是配置更多。社区文章里 `Channels.base(...)` 与仓库 README 里 `Channels.appender(...)` 的写法在不同版本间有差异，真接项目时请以对应版本的 javadoc 为准——这一点我保留判断。

**Spring AI**（官方参考文档首页的功能清单）没有内置的图编排引擎。它的编排能力分散在几个组件上：`ChatClient` 的链式调用负责"调用——组装提示——拿结果"，`Advisors` 是一条拦截器链，可以在请求前后插入记忆、RAG、日志，`Tools/Function Calling` 负责节点内的工具调用。也就是说，如果用 Spring AI 做单节点或简单的线性流程，够用；要做带条件分支、检查点和中断恢复的图，官方组件需要自己拼。目前 Java 生态里补上这块的，主要是第三方：LangGraph4j 的 Spring AI 集成模块，以及 **Spring AI Alibaba** 的 `spring-ai-alibaba-graph-core`（官方站点给出的核心概念是 `StateGraph`、`Node`、`Edge`、`OverAllState`，状态用 `registerKeyAndStrategy` 注册键的更新策略，例如 `ReplaceStrategy`）。这些同样**未在本机验证**。

对照的结论不是"谁更好"，而是：**本文那两百行不是要替代框架，而是让你在用框架时知道它在替你做什么**——当 `Channel`、`checkpointSaver`、`threadId` 这些名词出现时，你能立刻对应回"状态合并策略""检查点存储""任务隔离"这几个具体位置。

## 七、常见坑

这部分是这篇的核心产出，四个坑我都造了反例真跑过。

**坑一：状态对象被就地修改，检查点会被"追溯篡改"。** 这是最容易忽略、也最难查的一个。造一个反例节点：它不返回新集合，而是把状态里的 `List` 就地 `add`，然后返回空增量。实测：

```text
===== 场景 5：就地修改状态的两个反例 =====
invoke 返回: INTERRUPTED，停在 mutator
中断瞬间——内存检查点 trail: [seed]
中断瞬间——文件副本 trail: [seed]
  [mutator] 就地修改后 trail=[seed, mutator-in-place]
  [putter] 直接 put 被拦截: UnsupportedOperationException
恢复返回: DONE
恢复后——再看中断时那个内存检查点对象，trail: [seed, mutator-in-place]
恢复后——再看中断时的文件副本对象，trail: [seed]
```

看最后两行：**同一个中断时拿到的内存检查点对象，恢复之后 `trail` 从 `[seed]` 变成了 `[seed, mutator-in-place]`**。原因是引擎合并状态时只做了浅拷贝——新 Map 但里面的 `List` 还是同一个引用，节点就地改这个 `List`，等于改了历史。而"文件副本"是从字节流反序列化出来的独立对象，所以不受影响，仍是 `[seed]`。

这个现象在真实系统里的表现是"时间旅行/回放对不上"：你从检查点 A 回放，得到的状态却不是当时记录的样子。解决办法只有一个——**节点返回新集合，不就地改**。引擎能拦住直接 `put`（`putter` 那行打印的 `UnsupportedOperationException` 就是证据），但拦不住改嵌套对象，这层只能靠约定和 code review。

**坑二：检查点粒度太粗。** 不要把整个大对象（比如一段很长的对话、一次 RAG 检索的全部 chunk）一股脑塞进状态里当检查点。检查点每一步都要序列化落盘，粒度太粗会导致：写文件变慢、文件变大、恢复时反序列化成本高。合理做法是把状态切成"恢复必需"和"过程性中间数据"两类，只把前者放进检查点。本文例子里状态只有几个短字符串，所以文件很小；换成真实业务要重新审视这一点。

**坑三：条件边没有兜底，会死循环。** 造一个路由永远回到自己的条件边（目标集合里只有 `spin` 自己），实测：

```text
===== 场景 4：条件边没有兜底，靠最大步数强制停 =====
  [spin] 第 1 次执行
  [spin] 第 2 次执行
  [spin] 第 3 次执行
  [spin] 第 4 次执行
  [spin] 第 5 次执行
返回: MAX_STEPS，已执行 5 步，停在 spin
```

注意：目标集合校验**不会**拦住这种错——`spin` 确实在允许集合里。真正兜住它的是 `maxSteps`。这跟 Agent 循环那篇一个道理：任何允许回边的图，都必须有一个不依赖逻辑正确性的硬上限。如果这条 `spin` 边上挂着一次模型调用，5 步就是 5 次真实账单。

**坑四：人工介入节点没有超时。** `resume` 依赖外部调用，而"人"是不确定性的来源。如果审批可能永远不来，任务就会永远停在 `INTERRUPTED`。本文引擎刻意不做超时，因为超时策略是业务决策：可以设 TTL 到点自动驳回、转人工升级、或者标为过期。要做的是**把 `INTERRUPTED` 当成一个需要被监控的状态**，而不是一个可以忘记的中间态——统计一下有多少任务长时间卡在这个状态，比事后追责有用得多。

## 八、面试视角

如果面试官问"工作流和 Agent 有什么区别""怎么做 human-in-the-loop"，我大概会这样答：

- 先说清取舍：**工作流把控制流交给代码，Agent 把控制流交给模型**。可控性和自主性是反向的，选哪个看任务形状是否事先可枚举；生产里多数有边界的任务适合工作流。
- 图编排的落点是四个抽象：**节点返回增量、边决定路由、状态不可变传递、检查点可序列化**。这四点回答的是"为什么它能续跑、能审计、能人工介入"。
- 人工介入不是新机制，而是"中断 + 检查点 + 恢复"的组合，关键是**按 threadId 隔离状态**，这样多个任务、多个用户可以并发跑而互不干扰。
- 最后一定要落到兜底：**允许回边的图必须有最大步数上限**，条件边要声明目标集合兜底，`INTERRUPTED` 状态要有超时和监控。能主动说出这三个兜底，比背 API 名更有区分度。
- 追问"看过什么框架"：LangGraph4j 的 `StateGraph / CompiledGraph / CheckpointSaver` 和 Spring AI 的 `ChatClient / Advisors` 思路，能说清它们各自对应本文哪个位置最好。

## 小结

- 循环式 Agent 和工作流是可控性与自主性的取舍；有边界、要审计、要人工介入的流程，用工作流更划算。
- 图编排的四个抽象：**节点返回增量、边负责路由、状态不可变传递、检查点可序列化**。前两个决定流程，后两个决定能不能续跑和恢复。
- 人工介入 = 中断 + 检查点 + 恢复，按 `threadId` 隔离状态，跨进程恢复只需要检查点落盘——这两点都在本机真跑通了。
- 四个必须有的兜底：节点禁止就地改状态、检查点粒度要克制、允许回边必须配最大步数、`INTERRUPTED` 状态必须监控并有超时策略。
- 手写一遍不是要重复造框架，而是为了在用 LangGraph4j、Spring AI 这类工具时，能一眼看出 `Channel`、`checkpointSaver`、`threadId` 各自对应到引擎的哪一层。

## 参考资料

- [LangGraph4j 官方仓库（含 StateGraph / CompiledGraph / CheckpointSaver 概念说明）](https://github.com/langgraph4j/langgraph4j)
- [LangGraph4j 官方文档站](https://langgraph4j.github.io/langgraph4j/)
- [LangGraph4j：State Management, Channels, Reducers 与 Human-in-the-Loop 实践（社区文章）](https://www.futurecraft.dev/ai/State-Management/)
- [Spring AI 官方参考文档](https://docs.spring.io/spring-ai/reference/index.html)
- [Spring AI Alibaba Graph 官方文档（StateGraph / Node / Edge / OverAllState）](https://java2ai.com/en/docs/1.0.0.2/tutorials/graph/whats-spring-ai-alibaba-graph/)
- [LangGraph（Python）官方文档](https://langchain-ai.github.io/langgraph/)
- 本站同专栏文章：《不用框架手写一个最小 Agent 循环》《多 Agent 什么时候值得用》（讲 Agent 循环与多 Agent 成本，本文聚焦图编排引擎的实现，不重复）
- 写作规范参照：`E:\技术博客\规范\01-技术文章写作规范.md`、`02-技术准确性与资料规范.md`

> 待本人确认后发布。
