---
title: "Spring AI 工具调用不是反射一下就结束：用 2.0.1 跑通失败恢复与调用上限"
shortTitle: "Spring AI 工具调用链"
date: 2026-10-07
category:
  - Agent
tag:
  - Spring AI
  - 工具调用
  - Function Calling
order: 12
---


> 环境：Windows 11、JDK 17.0.12、Maven 3.9.14、Spring Boot 4.1.1、Spring AI 2.0.1
>
> 验证方式：不接真实模型，手工构造 `ChatResponse`，直接调用 `DefaultToolCallingManager.executeToolCalls()`；代码已编译运行。

目录

- 先说结论
- 从 ChatResponse 到 ToolResponseMessage：执行链在哪
- 最小实验：不接真实模型，手工构造 Tool Call
- 成功、无工具、未知工具分别发生什么
- 参数异常与业务异常：哪些反馈给模型
- 40 与 150：调用上限如何落地
- 把工具调用当成远程边界
- 参考资料
- 标签

## 先说结论

模型返回一个 Tool Call，真正的工作才刚开始。Spring AI 2.0.1 会在 `DefaultToolCallingManager` 中完成工具查找、参数规范化、实际调用、异常转换、`ToolResponseMessage` 构造和会话历史回填；任何一步失败，都要判断是终止请求，还是把错误反馈给模型让它修正。

本次实验里，成功调用最终得到 `[USER, ASSISTANT, TOOL]` 三段历史；工具不存在和无 Tool Call 会抛出 `IllegalStateException`；非法 JSON、工具内部运行时异常会进入工具响应；单工具默认最多执行 40 次，总调用默认上限是 150 次。超过上限时，框架抛出 `ToolCallLimitExceededException`，异常里带着已经完成的部分结果。

这篇文章不重复 `@Tool` 的入门写法，重点放在“工具调用执行链”和失败路径上。

## 从 ChatResponse 到 ToolResponseMessage：执行链在哪

Spring AI 的官方流程是：模型决定调用哪个工具，`ToolCallingManager` 找到匹配的 `ToolCallback` 并执行，循环继续到模型不再请求工具。

把这段流程拆开，可以观察到这几个动作：

1. 从 `ChatResponse` 的 `Generation` 中取出含有 Tool Call 的 `AssistantMessage`。
2. 根据 Tool Call 的名称找到已经注册的 `ToolCallback`。
3. 读取参数文本。参数为空或只有空白时，按空 JSON 对象处理。
4. 调用本地工具方法，把返回值或异常消息转换成字符串。
5. 构造 `ToolResponseMessage`，再把它追加到对话历史。

如果直接使用 `DefaultToolCallingManager.executeToolCalls()`，这些步骤都会暴露在当前调用栈里。它适合用来验证框架行为和设计上层容错策略。

关键在于，工具调用不是一个普通的本地方法调用。模型给出的工具名和参数是不可信输入，工具本身又可能访问数据库、网络或第三方系统。执行链必须同时处理“模型写错了”和“业务执行失败了”两类问题。

## 最小实验：不接真实模型，手工构造 Tool Call

实验只依赖 `spring-ai-model`：

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-model</artifactId>
    <version>2.0.1</version>
</dependency>
```

注册几个用于验证不同路径的工具：

```java
@Tool(name = "echo", description = "Return the supplied text in upper case")
public String echo(String text) {
    return text.toUpperCase();
}

@Tool(name = "noArgs", description = "Return a fixed value without parameters")
public String noArgs() {
    this.emptyArgumentCalls.incrementAndGet();
    return "normalized-empty-arguments";
}

@Tool(name = "explode", description = "Throw a business exception")
public String explode() {
    throw new IllegalArgumentException("business rule rejected the call");
}
```

然后把工具交给 `ToolCallingChatOptions`，创建默认执行管理器：

```java
ToolCallback[] callbacks = ToolCallbacks.from(new Tools());
ToolCallingChatOptions options = ToolCallingChatOptions.builder()
        .toolCallbacks(List.of(callbacks))
        .build();
DefaultToolCallingManager manager = DefaultToolCallingManager.builder().build();
```

测试时不需要真实模型，直接构造一个带 `ToolCall` 的 `AssistantMessage`：

```java
AssistantMessage assistantMessage = AssistantMessage.builder()
        .content("Requested tool: echo")
        .toolCalls(List.of(new AssistantMessage.ToolCall(
                "call-1", "function", "echo", "{\"text\":\"spring ai\"}")))
        .build();

ChatResponse response = new ChatResponse(List.of(new Generation(assistantMessage)));
```

运行命令如下。这里使用 `target/classes` 和运行时依赖类路径，因为示例项目没有配置可执行 jar 的 `Main-Class`。

```powershell
mvn -q -DskipTests compile dependency:build-classpath `
  '-Dmdep.outputFile=target\runtime-classpath.txt'
$cp = (Get-Content -Raw -Encoding UTF8 'target\runtime-classpath.txt').Trim()
& java.exe '-Dfile.encoding=UTF-8' `
  -cp "target\classes;$cp" demo.toolcall.ToolCallingProbe
```

## 成功、无工具、未知工具分别发生什么

正常调用 `echo` 时，输出如下：

```text
spring-ai-version=2.0.1
registered-tools=[noArgs, explode, counted, addNumbers, echo]
success-tool=echo
success-result="SPRING AI"
success-history=[USER, ASSISTANT, TOOL]
```

返回值 `SPRING AI` 被序列化后放进 `ToolResponseMessage`。工具注册结果是一个集合，本次输出顺序与上一轮运行不同，因此不要把打印顺序理解成调用顺序或注册顺序保证。

如果模型返回了普通文本，没有 Tool Call：

```text
no-tool-call=IllegalStateException: No tool call requested by the chat model
```

这说明直接调用 `executeToolCalls()` 时，调用方要先判断 `ChatResponse` 是否真的包含工具调用。实际项目里通常由 `ToolCallingAdvisor` 管理循环，普通业务代码不需要自己解析每个 Generation。

如果模型请求了不存在的工具：

```text
unknown-tool=IllegalStateException: No ToolCallback found for tool name: missingTool
```

这通常意味着本地工具注册和模型看到的工具定义不一致，或者历史消息里保留了已经删除的工具名。生产环境需要记录工具名、请求 ID 和当前可用工具集合，不能只打印一句“工具调用失败”。

## 参数异常与业务异常：哪些反馈给模型

空白参数和非法 JSON 的结果不同。

```text
blank-arguments-calls=1
blank-arguments-result="normalized-empty-arguments"
invalid-json-result=Unexpected end-of-input within/between Object entries
```

参数是空白字符串时，无参工具仍然执行成功，说明空文本在进入参数绑定前被规范化为空 JSON 对象。参数是残缺 JSON 时，解析错误会进入工具响应，模型可以据此重新生成参数。

业务异常则走另一条路径：

```text
tool-exception-result=business rule rejected the call
```

`explode` 抛出的是 `IllegalArgumentException`。Spring AI 官方文档说明，默认 `DefaultToolExecutionExceptionProcessor` 会把 `RuntimeException` 的消息反馈给模型，受检异常和 `Error` 仍然抛出。这样模型有机会换参数、换工具或向用户解释失败，但调用方不能把“异常消息已经返回”理解成业务已经成功。

一些异常适合反馈，一些异常必须终止：

| 异常类型 | 是否反馈给模型 | 更适合的处理 |
| --- | --- | --- |
| 参数格式错误 | 通常可以 | 让模型修正参数，但要限制重试次数 |
| 参数校验失败 | 可以，需脱敏 | 返回稳定错误码和可理解的原因 |
| 工具不存在 | 可以记录后重新规划 | 检查工具白名单和上下文 |
| 权限不足 | 不应暴露内部细节 | 拒绝执行，记录审计事件 |
| 数据库或网络故障 | 不建议原样反馈 | 退避、重试或转人工处理 |
| 代码缺陷导致的 `Error` | 否 | 终止并保留完整日志 |

把异常消息直接交给模型并不等于安全。消息里可能包含 SQL、地址、密钥或用户隐私。工程上应该增加一层错误转换，对模型只暴露必要的错误类型和可操作提示。

## 40 与 150：调用上限如何落地

Spring AI 2.0.1 的 `DefaultToolCallingManager` 默认限制单工具 40 次、总调用 150 次。通过在 jar 中读取公开常量，可以直接确认：

```text
DEFAULT_MAX_CALLS_PER_TOOL = 40
DEFAULT_MAX_TOTAL_TOOL_CALLS = 150
```

实验构造了 41 次同名工具调用，观察结果如下：

```text
per-tool-limit-executed=40
per-tool-limit-exception=ToolCallLimitExceededException
per-tool-limit-message=Tool call limit (40) exceeded for tool 'counted'
per-tool-limit-response-count=41
per-tool-limit-last-response=Tool call limit (40) exceeded for tool 'counted'. No further calls to this tool are allowed in this turn.
```

真正执行的调用是 40 次，第 41 次触发限制。异常携带的部分结果里有 41 条工具响应，最后一条是超限提示，因此已经完成的 40 次工作没有被直接丢弃。

再把总调用上限改成 2，发送 3 次请求：

```java
DefaultToolCallingManager manager = DefaultToolCallingManager.builder()
        .maxTotalToolCalls(2)
        .build();
```

输出是：

```text
total-limit-executed=2
total-limit-exception=ToolCallLimitExceededException
total-limit-message=Total tool call limit (2) exceeded for this turn
```

这两个上限用于防止 Agent 陷入循环、重复写数据或持续消耗模型调用。上限值必须结合业务副作用设置：查询工具可以宽一些，支付、删除、发消息等写操作应该更严格，并且配合幂等键和权限审批。

## 把工具调用当成远程边界

看完执行链，可以形成三个实用判断。

第一，工具名和参数来自模型，不能默认可信。要用 JSON Schema、Bean Validation 和业务校验分层检查，尤其是路径、ID、金额和权限字段。

第二，异常反馈和日志记录要分开设计。给模型的错误应该短、稳定、可操作；给开发者的事件应该包含工具名、调用 ID、参数摘要、耗时、异常类型和脱敏后的堆栈。

第三，调用上限要和业务幂等一起使用。只要框架允许重试，就要假设同一个业务动作可能被执行多次。对于写操作，工具内部应使用幂等键、状态机或唯一约束兜底。

`DefaultToolCallingManager` 解决了执行链的大部分机械工作。项目真正需要补上的，是权限、审计、错误映射、幂等和人工接管。

## 参考资料

- Spring AI Reference: Tool Calling，说明工具调用循环、`ToolCallingManager`、异常处理和调用上限：<https://docs.spring.io/spring-ai/reference/api/tools.html>
- Spring AI `DefaultToolCallingManager` 2.0.1 字节码：用于核对默认上限 40、150，以及 `ToolCallLimitExceededException` 的部分结果能力
- Spring AI `ToolCallingChatOptions`：用于把 `ToolCallback` 与每次聊天请求绑定

## 标签

`Spring AI` `Function Calling` `Java` `Agent` `后端开发`
