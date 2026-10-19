---
title: "A2A 1.0 到底和 MCP 差在哪：从 Agent Card、Task 到 Java 最小互操作"
description: "A2A 1.0 和 MCP 到底差在哪：从 Agent Card、Task 状态机到 a2a-java 最小互操作实测。"
shortTitle: "A2A 与 MCP 边界"
date: 2026-10-06
category:
  - Agent
tag:
  - A2A
  - MCP
  - AI Agent
order: 5
---


> 实验环境：Windows 11、Oracle JDK 17.0.12、Maven 3.9.14、a2a-java 1.4.0.Final  
> 规范依据：A2A Protocol 1.0.x、A2A and MCP、Life of a Task  
> 说明：文中使用官方 Java Client 连接本地规范级 mock Server，验证发现、任务状态和上下文续接，不代表通过全部厂商的兼容性认证。

**目录**

- MCP 管工具，A2A 管 Agent 之间的委托
- Agent Card 解决的是“先找到谁”
- Message 先进入，Task 负责持续状态
- Task 状态机比 HTTP 返回值更重要
- 终态之后，为什么同一上下文要新建 Task
- 用 a2a-java 跑一条最小互操作链路
- 运行输出里最值得看的六行
- A2A 不是把 MCP 再包一层
- 接生产环境前要补的边界
- 结论与参考资料

很多文章把 MCP 和 A2A 放在一张对比表里，最后得出“新协议会替代旧协议”的结论。这个判断容易误导。MCP 解决的是 Agent 如何调用工具和读取资源，A2A 解决的是一个 Agent 如何发现另一个 Agent、把任务委托出去，并持续跟踪任务状态。两者连接的对象不同，通常放在同一条系统链路里使用。

这篇文章不继续堆概念。我用 `a2a-java 1.4.0.Final` 的 Client 连接一个本地 mock Server，实际跑通 Agent Card 发现、`SendMessage`、`GetTask`、状态迁移和同一 `context_id` 下创建第二个 Task。实验支持什么、不能证明什么，我会在对应章节写清楚。先给结论：A2A 的工程价值主要落在三处，公开能力描述、可观察的 Task 生命周期、跨 Agent 的任务续接。

## MCP 管工具，A2A 管 Agent 之间的委托

把一次业务请求拆开看，模型可能既要查询数据库，又要调用发布系统，还要把最终文档交给另一个负责审核的 Agent。数据库查询和发布系统属于工具或资源访问，Agent 之间的审核协作属于任务委托。两类能力都可以出现在一次执行里，但协议关注的边界不同。

| 维度 | MCP | A2A |
| --- | --- | --- |
| 主要连接对象 | Agent 与工具、资源、提示模板 | 独立 Agent 与独立 Agent |
| 核心问题 | 有哪些能力可调用，参数和结果怎么表达 | 谁提供了什么能力，任务现在执行到哪一步 |
| 典型调用单位 | Tool、Resource、Prompt | Message、Task、Artifact |
| 状态关注点 | 单次工具调用及其结果 | 长任务、输入补充、鉴权、终结状态 |
| 发现方式 | MCP Server 暴露能力列表 | Agent Card 描述 Agent 和接口 |
| 常见耦合方式 | Agent 通过 MCP Client 使用工具 | Agent 通过 A2A Client 委托另一个 Agent |

官方在 [A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/) 中把两者描述为互补关系。一个 Agent 可以既作为 MCP Client 调用数据库工具，又作为 A2A Server 接收另一个 Agent 的审核任务。选型时先问“我要连接的是能力还是执行者”，比只问“谁更新”更有用。

## Agent Card 解决的是“先找到谁”

A2A Client 不会凭一个函数名找到远端 Agent。它需要先拿到 Agent Card，知道对方叫什么、支持哪些接口、具有什么能力，以及应该把请求发到哪里。常用发现路径是：

```text
/.well-known/agent-card.json
```

规范中的 `supported_interfaces` 是有序列表。客户端通常从第一项开始尝试；每一项 `AgentInterface` 包含接口 URL、`protocol_binding`、协议版本和可选的 `tenant`。`tenant` 对客户端是不透明值，Server 设置以后，后续请求需要原样带回，不能自行猜测或改写。

实验中的 Agent Card 由本地 HTTP Server 动态生成：

```java
AgentCard card = AgentCard.builder()
        .name("Release Notes Agent")
        .description("A local A2A probe for task and context boundaries.")
        .version("1.0.0")
        .capabilities(AgentCapabilities.builder()
                .streaming(false)
                .pushNotifications(false)
                .build())
        .defaultInputModes(List.of("text/plain"))
        .defaultOutputModes(List.of("text/plain"))
        .skills(List.of(AgentSkill.builder()
                .id("release-notes")
                .name("Release notes")
                .description("Draft a release note from a user request.")
                .tags(List.of("release", "documentation"))
                .examples(List.of("Create release notes for version 1.4.0"))
                .inputModes(List.of("text/plain"))
                .outputModes(List.of("text/plain"))
                .build()))
        .supportedInterfaces(List.of(new AgentInterface(
                "JSONRPC",
                baseUrl,
                null,
                AgentInterface.CURRENT_PROTOCOL_VERSION)))
        .build();
```

客户端使用 SDK 的 `A2ACardResolver` 读取该路径：

```java
AgentCard card = A2ACardResolver.builder()
        .baseUrl(baseUrl)
        .build()
        .getAgentCard();
```

这一步只解决“怎么找到并描述 Agent”。它不证明远端业务真的可用，也不替代鉴权。生产环境还要处理 DNS、TLS、证书、租户、版本协商和卡片缓存。Agent Card 可以动态发布，客户端不能假设它永远不变。

## Message 先进入，Task 负责持续状态

Agent 之间传递的一条消息包含角色、消息 ID、内容和可选的 `context_id`。当远端需要持续执行、等待输入或进行鉴权时，请求会关联到一个 Task。Task 有独立 ID、状态、历史记录和上下文 ID，Client 可以通过轮询、订阅或推送继续观察。

实验先发送一条普通 Message：

```java
Message message = Message.builder()
        .role(Message.Role.ROLE_USER)
        .messageId("msg-" + UUID.randomUUID())
        .contextId("ctx-release-1")
        .parts(new TextPart("Create release notes for version 1.4.0"))
        .build();

MessageSendParams params = MessageSendParams.builder()
        .message(message)
        .configuration(MessageSendConfiguration.builder()
                .returnImmediately(true)
                .build())
        .build();
```

`return_immediately` 的默认值是 `false`。默认情况下，调用方会等到 Task 进入终态或中断态。实验把它设为 `true`，让 Server 尽快返回 Task，再由 Client 主动调用 `GetTask`。这个选择适合观察状态变化；真实业务是否立即返回，要看请求时长、网关超时和用户体验。

需要区分 Message 和 Task 的职责。Message 是交互内容，Task 是可跟踪的执行实例。只返回一段文本的轻量调用可以结束在 Message；需要跨多次请求完成的工作，则需要 Task 承载状态。

## Task 状态机比 HTTP 返回值更重要

一次 HTTP 200 只能说明请求被协议层接收，不能说明任务已经完成。A2A Task 的状态决定调用方下一步该做什么。

| 状态类别 | 状态 | 客户端处理方向 |
| --- | --- | --- |
| 进行中 | `SUBMITTED`、`WORKING` | 等待、订阅或轮询 |
| 需要输入 | `INPUT_REQUIRED` | 收集补充信息，再继续同一 Task |
| 需要鉴权 | `AUTH_REQUIRED` | 完成鉴权，再恢复任务 |
| 终态 | `COMPLETED`、`FAILED`、`CANCELED`、`REJECTED` | 读取结果或错误，结束本次任务 |

`COMPLETED`、`FAILED`、`CANCELED`、`REJECTED` 是终态。`INPUT_REQUIRED` 和 `AUTH_REQUIRED` 属于中断态，任务还没有完成，也不应该被当成失败。客户端如果只看 HTTP 状态码，很容易把“正在等待用户补充版本号”误判成调用成功。

轮询并不复杂，但条件要写对：

```java
Task task = client.getTask(
        TaskQueryParams.builder().id(taskId).build());

if (task.status().state().isFinal()) {
    // 读取最终产物或失败原因
}
```

生产代码还要设置轮询退避、总超时、最大次数和取消逻辑。`SubscribeToTask` 只适合活跃且未终结的 Task。终结后再订阅，协议层可能直接拒绝，客户端也不应该继续等待新事件。

## 终态之后，为什么同一上下文要新建 Task

实验中，第一个 Task 完成后，又发送了一条属于同一发布说明流程的消息：

```java
String contextId = "ctx-release-1";

Task first = send(client, contextId,
        "Create release notes for version 1.4.0");

// 等待 first 进入 COMPLETED

Task second = send(client, contextId,
        "Add a migration note for version 1.4.1");
```

第二次调用返回了 `task-2`，但 `context_id` 仍然是 `ctx-release-1`。这说明上下文和 Task 不是同一个概念。`context_id` 把一组相关工作串在一起，方便保留连续会话；终结的 Task 本身不能被重新启动。

这个边界对后端设计很重要。数据库中的任务表如果只有 `context_id` 一个主键，就可能把“同一会话”和“同一次执行”混为一谈。更稳妥的模型至少要有 `task_id`、`context_id`、状态、重试次数和终态时间，历史消息与产物再单独关联。

重试也要小心。规范允许 `SendMessage` 实现幂等，但没有要求所有 Server 都这样做。网络超时后直接重发，可能产生两个 Task。调用方可以先按消息 ID 或业务幂等键查询已有执行，再决定重试。Push Notification 则按至少一次投递设计，接收端必须能处理重复事件。

## 用 a2a-java 跑一条最小互操作链路

项目只依赖官方 Java Client：

```xml
<dependency>
  <groupId>org.a2aproject.sdk</groupId>
  <artifactId>a2a-java-sdk-client</artifactId>
  <version>1.4.0.Final</version>
</dependency>
```

本地 mock Server 使用 JDK 自带的 `HttpServer`，实现了两个最小端点：

```java
server.createContext(
        "/.well-known/agent-card.json",
        A2AInteropDemo::serveAgentCard);
server.createContext("/", A2AInteropDemo::serveJsonRpc);
```

JSON-RPC 端只处理 `SendMessage` 和 `GetTask`。`SendMessage` 创建 `task-1`，第一次 `GetTask` 返回 `WORKING`，第二次返回 `COMPLETED`。再次发送消息时，Server 创建 `task-2` 并沿用原来的上下文：

```java
if ("SendMessage".equals(method)) {
    String taskId = "task-" + TASK_SEQUENCE.incrementAndGet();
    Task working = Task.builder()
            .id(taskId)
            .contextId(contextId)
            .status(new TaskStatus(TaskState.TASK_STATE_WORKING))
            .history(List.of(userMessage))
            .build();
    TASKS.put(taskId, new TaskRecord(working, new AtomicInteger()));
    return;
}

if ("GetTask".equals(method)) {
    String taskId = request.getAsJsonObject("params")
            .get("id").getAsString();
    TaskRecord record = TASKS.get(taskId);
    Task task = record.polls().incrementAndGet() >= 2
            ? completedTask(record.task())
            : record.task();
    return;
}
```

这里有一个容易踩的版本差异：Java SDK 的 JSON-RPC 方法名是 `SendMessage` 和 `GetTask`。旧示例里常见的 `message/send`、`tasks/get` 写法不能直接照搬。核对方法名时，应以当前规范和 SDK 实际发送的请求为准。

编译运行命令如下：

```powershell
mvn -q dependency:build-classpath `
  -Dmdep.outputFile=classpath.txt

$cp = (Get-Content -Raw -Encoding UTF8 .\classpath.txt).Trim()

javac -encoding UTF-8 -cp $cp .\A2AInteropDemo.java

java '-Dfile.encoding=UTF-8' `
  -cp "$cp;." A2AInteropDemo
```

### 运行输出里最值得看的六行

端口由操作系统动态分配，所以每次运行都可能不同。本次关键输出是：

```text
discovery: resolver accepted Release Notes Agent v1.0.0
interface: JSONRPC http://127.0.0.1:62452 protocol=1.0
tenant omitted: true
server-call-1: SendMessage
client-event: Task id=task-1 state=TASK_STATE_WORKING
poll-2: task=task-1 state=TASK_STATE_COMPLETED final=true
server-call-4: SendMessage
client-event: Task id=task-2 state=TASK_STATE_WORKING
send-2: task=task-2 context=ctx-release-1 newTask=true
```

前几行证明 Client 能从约定路径发现 Agent，并选择了第一个 `JSONRPC` 接口。中间输出证明请求先返回 `WORKING`，两次轮询后进入 `COMPLETED`。最后几行证明终结 Task 没有被复用，而是在同一上下文里创建了新 Task。

这个探针能验证协议对象、方法名、状态判断和上下文续接。它不覆盖跨厂商兼容、真实模型输出、鉴权、TLS、Push Notification、断线重连和持久化，也不能证明业务结果正确。官方 Client 加本地 mock Server 的测试范围，应当明确限制在互操作结构，而不是包装成完整生产验证。

## A2A 不是把 MCP 再包一层

从代码形态看，A2A 也使用 JSON-RPC，也有请求和响应，所以很容易被理解成“另一套 MCP”。这种类比会漏掉关键差别。

MCP Client 关心“我现在能调用哪些工具”。工具通常是相对短的操作，参数和返回结果可以很快确定。A2A Client 关心“哪个 Agent 能承担这项工作，任务是否还在执行，是否需要补充输入，最终产物在哪里”。任务可以持续几分钟、几天，甚至跨越多次人工确认。

这决定了两边的工程重点不同。MCP 更强调能力列表、参数 Schema、资源读取和工具权限；A2A 更强调 Agent Card、任务状态、上下文关联、事件订阅和任务防护。一个 Java 服务完全可以同时扮演两种角色：

| 当前职责 | 适合的协议入口 |
| --- | --- |
| 查询订单数据库 | MCP Resource 或 Tool |
| 调用内部发布接口 | MCP Tool |
| 把发布说明交给审核 Agent | A2A Message 和 Task |
| 等待审核 Agent 补传附件 | A2A `INPUT_REQUIRED` |
| 恢复审核任务的订阅 | A2A `SubscribeToTask` |
| 把最终审核结果落库 | A2A Artifact，再通过业务代码持久化 |

选型时不要从“哪个协议更高级”出发。先画出系统里有哪些工具、资源和执行者，再决定哪些边界需要暴露。一个单体 Agent 内部的函数调用不需要 A2A；一个只在启动时读取本地文件的 Skill 也不需要 A2A。只有跨进程、跨团队或跨厂商的 Agent 协作，才更容易体现出它的价值。

## 接生产环境前要补的边界

最小互操作跑通以后，距离生产系统还有一段路。下面这些问题应该在设计阶段就进入检查表。

| 边界 | 需要实现的行为 |
| --- | --- |
| 鉴权 | 校验 Agent Card、请求来源、租户和接口权限 |
| 幂等 | 为业务请求设置幂等键，处理超时重发和重复 Task |
| 超时 | 区分连接超时、任务等待超时和业务执行超时 |
| 状态持久化 | Task、Context、历史和 Artifact 不能只放内存 |
| 事件恢复 | 断线后重新拉取状态，订阅只面向活跃 Task |
| 人工接管 | `INPUT_REQUIRED`、`AUTH_REQUIRED` 要有明确处理人 |
| 取消 | 区分客户端取消、服务端取消和任务已经终结 |
| 观测 | 记录 task ID、context ID、方法名、耗时和错误码 |
| 成本 | 限制最大步骤、工具调用次数、模型调用量和产物大小 |
| 安全 | Agent Card 和 Artifact 都按不可信输入处理 |

最容易漏掉的是状态持久化和幂等。Agent 任务跨越服务重启以后，内存中的 `TASKS` 会直接消失。客户端重试时，如果没有业务幂等键，服务端就会再次执行。把 Task 当成一个普通的数据库状态机来设计，通常比在 Client 侧堆重试逻辑更可靠。

监控也要围绕 Task 做。只记录 HTTP 200 没有意义，至少要能看到创建了多少 Task、有多少进入终态、多少长时间停在 `WORKING`、多少等待人工输入，以及重试后是否产生重复执行。没有这些数据，Agent 协作的表面成功率很容易掩盖任务层面的失败。

## 结论与参考资料

A2A 和 MCP 的共同点是都出现在 Agent 链路里，区别在于连接对象。MCP 连接 Agent 与工具、资源，A2A 连接独立 Agent 与独立 Agent。A2A 的 Agent Card 解决发现，Message 负责传递交互内容，Task 负责持续状态，`context_id` 负责关联一组相关工作。

这次 Java 实验确认了三件事：Client 能从 `/.well-known/agent-card.json` 读取 Agent Card；JSON-RPC SDK 实际调用 `SendMessage` 和 `GetTask`；终结 Task 不会被重启，同一上下文中的后续请求会创建新 Task。它还暴露了一个工程上很重要的判断，HTTP 调用成功不等于任务完成，必须看 Task 状态和最终产物。

如果你准备把 A2A 接进 Java 服务，建议先把 Task、Context、鉴权、幂等和持久化画成状态图，再写协议 Client。最小 Demo 适合验证发现和状态，生产实现还要补上超时、重试、删除、权限和可观测性。下一步值得单独验证的是 `INPUT_REQUIRED` 的人工接管流程，以及 Push Notification 重复投递时的幂等处理。

参考资料：

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [A2A Protocol a2a.proto](https://a2a-protocol.org/latest/spec/a2a.proto)
- [Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/)
- [Streaming and Async](https://a2a-protocol.org/latest/topics/streaming-and-async/)
- [A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)
- [a2a-java](https://github.com/a2aproject/a2a-java)
- [a2a-java v1.4.0.Final](https://github.com/a2aproject/a2a-java/releases/tag/v1.4.0.Final)
