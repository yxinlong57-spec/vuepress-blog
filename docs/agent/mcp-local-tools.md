---
title: "MCP 接入本地工具：把线上消息摊开看握手、tools/call、权限和错误分层"
shortTitle: "MCP 接入本地工具"
date: 2026-10-13
category:
  - Agent
tag:
  - MCP
  - AI Agent
  - 工具调用
order: 3
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK 单文件实验，无第三方依赖
> 说明：本文在单 JVM 内模拟 MCP over stdio 的线上消息，消息格式、方法名和错误分层与 MCP 规范一致；真实部署请用官方 SDK（Java 侧有官方 `io.modelcontextprotocol` SDK）。文中手写的极简 JSON 解析器仅为零依赖教学，生产环境请用 Jackson。

**目录**

- 问题：SDK 把协议藏起来了，出错时不知道在看什么
- MCP 是什么，不是什么
- 实测：一个完整会话的六步线上消息
- 设计要点一：权限必须在 server 侧强制执行
- 设计要点二：错误分两层，别用混
- 设计要点三：inputSchema 是模型唯一的工具说明书
- 这个教学模型和真实 MCP 的差距
- 小结

## 问题：SDK 把协议藏起来了，出错时不知道在看什么

想给本地 Agent 接工具，现在的标准答案是 MCP（Model Context Protocol）。但照着 SDK 文档起了一个 server 之后，大多数人（包括我）对线上实际跑了什么都说不清楚——握手发了什么？工具列表长什么样？模型传了越权参数时，错误是从哪一层返回的？

不知道这些，排查"模型调不动工具"这类问题就只能在 SDK 的日志里碰运气。我的办法是绕开 SDK，用纯 JDK 模拟一遍 MCP over stdio 的线上消息：客户端和 server 在同一个 JVM 里用字符串收发 JSON-RPC，每条消息原样打印。结论先说：

1. MCP 的线上协议比直觉简单得多：JSON-RPC 2.0，stdio 上每行一条消息，核心方法就是 `initialize`、`tools/list`、`tools/call`。
2. 权限控制必须在 **server 侧**强制执行，不能指望模型自觉，也不能只靠 client 提示。
3. 错误分两层：协议错误（方法不存在）走 JSON-RPC 的 `error` 字段；工具执行失败（含权限拒绝）走 `result.content` + `isError=true`。用混了，模型就失去自我修正的机会。

## MCP 是什么，不是什么

一句话：MCP 是 Anthropic 在 2024 年底开源的应用层协议，解决"Agent 应用（client）和工具/数据源（server）之间的标准化连接"问题。它经常被拿来和 function calling 混淆，区别很实际：

- **Function calling 是模型能力**：模型决定"要调一个工具"并生成结构化参数。它发生在模型和应用之间。
- **MCP 是应用和工具之间的协议**：工具长什么样、怎么调用、错误怎么返回，都标准化了。它发生在应用和工具进程之间。

两者的关系是接力：模型通过 function calling 告诉应用"我要调 `read_file`"，应用作为 MCP client 把这个调用翻译成 `tools/call` 消息发给 MCP server，server 执行后返回结果，应用再把结果喂回模型。本文聚焦的是后半段。

传输方式上，本地工具最常用 **stdio**：client 把 server 作为子进程启动，双方通过标准输入输出通信，每行一条 JSON-RPC 消息。这也是我的实验模拟的形态。

## 实测：一个完整会话的六步线上消息

实验里 server 暴露两个工具：`add(a,b)`（纯计算，无副作用）和 `read_file(path)`（读文件，有权限问题）。以下全部是本机实测输出。

**第 1 步：握手。** client 发 `initialize` 声明自己支持的协议版本和能力，server 回应自己的版本和能力；随后 client 发 `initialized` 通知，握手完成：

```text
client -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mini-client","version":"0.1"}}}
server -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"mini-mcp-server","version":"0.1.0"}}}
client -> {"jsonrpc":"2.0","method":"notifications/initialized"}
server -> (通知，无响应)
```

注意三点：`protocolVersion` 是双方协商的，server 可以回应一个不同的版本让 client 降级；`capabilities` 声明 server 提供哪类能力（tools、resources、prompts），client 后面只能用它声明过的；`notifications/initialized` 是**通知**——JSON-RPC 里没有 `id` 的消息就是通知，server 不回应。真实 stdio 部署里，server 如果对通知回了消息，一些严格的 client 会直接断连。

**第 2 步：发现工具。** `tools/list` 返回每个工具的名字、描述和 `inputSchema`（JSON Schema）：

```text
client -> {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
server -> {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"add","description":"计算两个整数的和","inputSchema":{"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"integer"}},"required":["a","b"]}},{"name":"read_file","description":"读取白名单目录内的文本文件","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]}}
```

这份列表之后会被应用翻译成 function calling 的工具定义喂给模型——**`description` 和 `inputSchema` 是模型能看到的唯一工具说明书**，写得多清楚，模型就调得多准。

**第 3 步：正常调用。** `tools/call` 的 `params` 里是工具名和 `arguments` 对象：

```text
client -> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add","arguments":{"a":3,"b":4}}}
server -> {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"7"}],"isError":false}}
```

返回的 `content` 是一个数组，元素可以是 text、image 等资源类型——一个工具一次可以返回多段内容，这个设计和消息结构对齐，方便多模态工具。

**第 4 步：读白名单内的文件，正常：**

```text
client -> {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"demo-data/notes.txt"}}}
server -> {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"MCP 学习笔记：先跑通握手，再谈工具。"}],"isError":false}}
```

**第 5 步：模型试图读白名单外的文件，被 server 拒绝：**

```text
client -> {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"C:/Windows/System32/drivers/etc/hosts"}}}
server -> {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"权限拒绝：read_file 只允许读取 demo-data/ 内的文件，收到 C:/Windows/System32/drivers/etc/hosts"}],"isError":true}}
```

**第 6 步：client 调用了 server 没声明的方法，协议层报错：**

```text
client -> {"jsonrpc":"2.0","id":6,"method":"resources/list","params":{}}
server -> {"jsonrpc":"2.0","id":6,"error":{"code":-32601,"message":"Method not found: resources/list"}}
```

第 5 步和第 6 步的失败走的是完全不同的通道，这就是下一节的重点。

## 设计要点一：权限必须在 server 侧强制执行

`read_file` 的权限检查实现只有两行，但位置是刻意选的——在 **server 的工具执行体里**：

```java
case "read_file": {
    String path = String.valueOf(args.get("path"));
    if (path.contains("..") || !path.startsWith(FILE_WHITELIST)) {
        throw new SecurityException(
                "权限拒绝：read_file 只允许读取 " + FILE_WHITELIST + " 内的文件，收到 " + path);
    }
    return new String(Files.readAllBytes(Paths.get(path)), "UTF-8");
}
```

为什么不能只靠 client 或模型？因为威胁模型很明确：工具的参数是模型生成的，而模型的行为不可预测——提示注入、上下文误导、单纯的幻觉，都可能让它生成越权参数。把防线放在 server 侧，意味着不管上游是谁、被怎么操纵，越权请求都在执行前被拦下。检查项至少包括：路径穿越（`..`）、白名单前缀、符号链接（生产环境还要用 `toRealPath()` 解析后再比前缀，防止软链绕过）。

对写操作（发消息、改文件、执行命令）还要再加一层：要求人工确认。MCP 生态里常见的做法是由 client 弹确认框，但 server 侧应该提供"这个工具有副作用"的标注（MCP 的 tool annotations，如 `destructiveHint`），而不是默默执行。

## 设计要点二：错误分两层，别用混

实测里第 5 步和第 6 步的对比值得停下来看清楚：

- **协议层错误**（方法不存在、消息格式非法）→ JSON-RPC 的 `error` 字段，code 遵循 JSON-RPC 规范（-32601 Method not found、-32602 Invalid params）。这层错误的含义是"你的调用本身就不合法"，通常不该喂给模型，因为模型改不了协议。
- **工具执行错误**（权限拒绝、文件不存在、业务校验失败）→ HTTP 意义上"成功"的响应，`result.content` 里放错误描述，`isError=true`。这层错误**应该喂回模型**——错误信息写得清楚，模型下一轮就能修正参数重试。

这和上一篇 Function Calling 参数校验的"错误信息喂回模型"是同构的，只是 MCP 把它在协议层面固定下来了：`isError=true` 的 result 就是给模型看的。如果你把权限拒绝也做成协议层 `error`，client 侧的 Agent 循环很可能直接中断，丢掉自我修正的机会。

## 设计要点三：inputSchema 是模型唯一的工具说明书

第 2 步返回的 `inputSchema` 决定了模型能调出什么样的参数。三个经验：

1. **description 写给模型看，不是写给人看。**"读取白名单目录内的文本文件"这句描述里，"白名单目录内"是故意写给模型的——它提前告诉模型边界在哪，减少第 5 步那种越权尝试。
2. **schema 里能表达的约束都表达**：`required`、`enum`、`minimum/maximum`。表达不了的（路径白名单）才留给运行时校验。
3. **工具宁可拆小不要合并。**一个 `file(path, op)` 同时支持读写删的工具，权限检查会复杂到容易出错；拆成 `read_file` / `write_file`，白名单策略可以分别收紧。

## 这个教学模型和真实 MCP 的差距

为了让协议可见，这个实验砍掉了不少东西，真实接入时要补回来：

- **真实 stdio 是独立子进程**：client 用 `ProcessBuilder` 启动 server 进程，逐行读写 stdin/stdout。我的单 JVM 字符串传递省掉了进程管理，但消息格式完全一样。
- **能力不止 tools**：MCP 还有 resources（数据订阅）和 prompts（提示模板）两类能力，实验里的第 6 步 `resources/list` 报 -32601，正是因为这个 server 只声明了 tools。
- **远程 server 用 HTTP**：stdio 适合本地工具；远程 server 走 Streamable HTTP 传输，多了鉴权（OAuth）这一整层。
- **解析用成熟库**：我的手写 JSON 解析器只支持本实验的子集，真实项目用官方 SDK，它同时处理了批请求、取消通知、进度通知等我全部跳过的边缘情况。

看清骨架的价值依然在：当你的 SDK 报"connection closed"时，知道线上本来应该跑什么消息，排查就有方向——先抓子进程的 stdin/stdout，对照本文的六步看停在哪一步。

## 小结

- MCP over stdio 的线上协议就是 JSON-RPC 2.0 逐行消息，核心流程六步：initialize、initialized 通知、tools/list、tools/call。
- 权限在 server 侧强制执行（路径穿越、白名单、真实路径解析），写操作再加人工确认。
- 错误分两层：协议错误走 `error` 字段，工具执行错误走 `result` + `isError=true`；后者是给模型自我修正用的，别用混。
- `description` 和 `inputSchema` 是模型唯一的工具说明书，值得像写 API 文档一样认真写。

> 待本人确认后发布。
