---
title: "Java 项目接大模型：Spring AI 和 LangChain4j 先比较什么（选型实测视角）"
shortTitle: "Spring AI vs LangChain4j"
date: 2026-10-13
category:
  - Agent
tag:
  - Spring AI
  - LangChain4j
  - 选型
order: 7
---


> 参照版本：Spring AI 2.0.x（1.0 于 2025 年 5 月 GA）、LangChain4j 1.x（注意：1.0 起核心接口 `ChatLanguageModel` 更名为 `ChatModel`）
> 证据说明：本文结论来自两个项目的官方文档和 Release Notes；文中的最小代码是官方文档的示例形态，本机未跑真实模型调用（无 API Key）。两个项目迭代都很快，落地前请以当时的官方文档为准。

**目录**

- 先给结论：大多数 Spring 项目选 Spring AI，例外情况在最后
- 两个项目的定位差异决定了后面的一切
- 第一层比较：统一抽象，谁的"换模型"成本低
- 第二层比较：Agent 能力——工具调用、结构化输出、MCP
- 第三层比较：生态集成和维护成本
- 两段最小代码，感受 API 风格差异
- 选型决策表
- 小结

## 先给结论：大多数 Spring 项目选 Spring AI，例外情况在最后

我接到"Java 项目要接大模型"这个需求时，先把结论放这：

- 项目已经是 Spring Boot 技术栈、团队熟悉 Spring 的配置和注入模型 → **默认选 Spring AI**。理由不是功能更强，而是配置管理、可观测性、依赖注入全部走 Spring 现有体系，维护成本最低。
- 项目不是 Spring 技术栈（Quarkus、裸 Java、Android），或者要用到 LangChain4j 某些更细的组件（比如它的部分 RAG 扩展、离线模型集成）→ **选 LangChain4j**，它不强绑 Spring。
- 只是做一个一次性脚本或验证想法 → **都不用选**，直接用 JDK 11+ 自带的 `HttpClient` 调模型 API，二十行代码，没有框架学习成本。

剩下的篇幅解释这个结论是怎么比出来的。

## 两个项目的定位差异决定了后面的一切

两者表面上都是"Java 版大模型开发框架"，定位其实不同：

**Spring AI** 的目标是成为 Spring 生态的一部分。它的设计语言是 Spring 的：starter 依赖、自动装配、`application.yml` 配置、和 Spring Boot Actuator/Micrometer 集成做可观测性。背后的治理主体是 Broadcom（原 VMware 的 Spring 团队），版本节奏跟着 Spring 生态走。你用它，本质上是在买"和 Spring 全家桶的一致性"。

**LangChain4j** 的目标是做一个框架中立的大模型工具箱。核心模块零 Spring 依赖，想在什么框架里用就在什么框架里用（它有 Spring Boot starter，但那是可选集成，不是地基）。社区驱动，迭代快，新模型和新能力的跟进速度通常更快，组件切分得更细。

定位差异带来一个直接后果：**功能清单对比意义不大**。两家在模型支持、工具调用、RAG、结构化输出这些大项上都覆盖，差别在"和你现有技术栈的咬合方式"和"出问题时的排查路径"。所以我把比较分三层：统一抽象、Agent 能力、生态维护成本。

## 第一层比较：统一抽象，谁的"换模型"成本低

两个框架最基础的价值相同：把 OpenAI、Anthropic、Gemini、Ollama、Azure OpenAI 等各家 API 抽象成统一接口，换模型改配置不改业务代码。

Spring AI 是两层抽象：`ChatModel` 是底层接口（对应一次对话调用），`ChatClient` 是高层流式 API（链式调用，内置 advisors——类似 Servlet Filter 的拦截链，日志、记忆、RAG 都以 advisor 形式挂上去）。

LangChain4j 是 `ChatModel` 接口加 `AiServices` 声明式层。注意一个真实的版本坑：**LangChain4j 在 1.0 把沿用多年的 `ChatLanguageModel` 接口改名为 `ChatModel`**，网上大量 2024 年及以前的教程还在用旧名字，照抄会在新版本上编译失败。这类"接口改名"在两个框架的快速迭代期都发生过，选型时要看的不只是功能，还有团队愿意承受的版本跟进成本。

抽象层的实际差异：

| 维度 | Spring AI | LangChain4j |
| --- | --- | --- |
| 模型接入方式 | starter 依赖 + `application.yml` | 显式 builder 构造，或它的 Spring starter |
| 横切能力 | advisor 链（日志、记忆、RAG） | `AiServices` + 拦截器 |
| 流式输出 | `Flux<ChatResponse>`（Reactor） | `StreamingChatModel` + 回调 |
| 换模型成本 | 改配置和 starter | 改构造参数 |

如果你团队的心智模型已经是"配置 + Bean"，Spring AI 的抽象几乎零学习成本；如果团队更习惯显式构造对象、对魔法装配有戒心，LangChain4j 更顺手。

## 第二层比较：Agent 能力——工具调用、结构化输出、MCP

这是 2025 年之后两个框架投入最猛的方向，逐项看：

**工具调用（Function Calling）。** 两家都支持把 Java 方法标注成工具。Spring AI 用 `@Tool` 注解或在 `ChatClient` 调用时传入回调；LangChain4j 用 `@Tool` 注解配合 `AiServices` 自动注册。功能对等，差别还是在绑定方式：Spring AI 的工具方法天然可以是 Spring Bean 的方法，直接注入业务 Service；LangChain4j 的工具对象由你显式构造。对后端项目来说，前者的"工具就是已有业务方法"体验更顺滑。

**结构化输出。** 两家都支持把模型输出直接绑定到 Java 记录类（record）或 POJO。Spring AI 是 `.entity(MyRecord.class)`，LangChain4j 是 `AiServices` 接口方法直接声明返回类型。对等，不看这个选型。

**MCP（Model Context Protocol）。** 这是两者都开始支持但形态不同的点：Spring AI 提供 MCP client 和 server 的 starter，可以把一个 Spring Boot 应用直接暴露成 MCP server；LangChain4j 有 `langchain4j-mcp` 模块做 client 侧。如果你的目标包括"把自己的 Java 服务包装成 MCP 工具源给别人用"，Spring AI 目前的路径更短。这块两边都在快速演进，使用前必须查当时版本的文档。

**Agent 编排。** 两家都在做更高层的 Agent 抽象（Spring AI 的 Agentic 相关能力、LangChain4j 的 Agentic 模块），但都还在早期。我的建议是：这个层面**都不要依赖框架**，先理解 Agent 循环的骨架（我自己用纯 JDK 手写过一个最小循环，见文末链接），框架的高层抽象等它稳定再迁。

## 第三层比较：生态集成和维护成本

这一层是 Spring 技术栈项目的决定性因素：

- **配置管理**：Spring AI 的 API key、模型名、超时全在 `application.yml`，走 Spring 的配置加密和 profile 体系；LangChain4j 要自己管。
- **可观测性**：Spring AI 接 Micrometer，token 用量、调用延迟直接进现有的 Metrics/Tracing 体系；LangChain4j 有 listener 机制，但要自己接到监控。
- **依赖管理**：Spring AI 版本由 Spring Boot 的 BOM 管，升级跟着 Boot 走；LangChain4j 是独立版本线，和 Boot 升级解耦（这既是自由也是负担）。
- **出问题时**：Spring AI 的问题大概率能在 Spring 生态的惯用路径里解决（看自动装配条件、看配置属性类）；LangChain4j 的问题要读它自己的代码。两边源码质量都不错，但排查路径的熟悉度不同。

维护成本还有一项容易被忽略：**教程时效性**。两个框架的 API 在 GA 前后都变过，中文社区教程大量过期。选型时把"官方文档质量"算进去——这两家的官方文档都写得可以，看官方文档、别看二手教程，是这两个框架共同的生存法则。

## 两段最小代码，感受 API 风格差异

同样是"问模型一句话"，两家的风格差异一眼可见。

Spring AI（依赖 `spring-ai-starter-model-openai`，配置 `spring.ai.openai.api-key`）：

```java
@RestController
class ChatController {
    private final ChatClient chatClient;

    ChatController(ChatClient.Builder builder) {   // Builder 由自动装配提供
        this.chatClient = builder.build();
    }

    @GetMapping("/chat")
    String chat(@RequestParam String q) {
        return chatClient.prompt().user(q).call().content();
    }
}
```

LangChain4j（依赖 `langchain4j-open-ai`）：

```java
ChatModel model = OpenAiChatModel.builder()
        .apiKey(System.getenv("OPENAI_API_KEY"))
        .modelName("gpt-4o-mini")
        .build();

String answer = model.chat("你好");
```

风格差异很清楚：Spring AI 把一切都交给容器，你写的是"装配后的使用"；LangChain4j 是显式构造，你看到的是"对象怎么来"。没有谁更好，只有谁更像你团队已有的代码。

## 选型决策表

| 你的情况 | 建议 |
| --- | --- |
| Spring Boot 项目，接入对话/RAG/工具调用 | Spring AI |
| 要把 Java 服务暴露成 MCP server | Spring AI（client 侧两家都可以） |
| Quarkus / 裸 Java / Android | LangChain4j |
| 需要跟进最新模型能力，愿意承受版本变动 | LangChain4j |
| 一次性的验证脚本 | 都不用，HttpClient 直连 |
| 团队不熟悉 Spring 装配，喜欢显式构造 | LangChain4j |

还有一个常被忽略的问题：**能不能两个都不用，或者用了一层再换？** 可以，前提是你把模型调用收敛在自己的接口后面。两个框架都是"抽象别家 API"的框架，你自己的业务代码如果被框架的 API 形状渗透得太深，换框架的成本会很高。定义一个自己的 `ChatPort` 接口，框架只在实现层出现，这是我在 Agent 相关代码里一直坚持的隔离方式。

## 小结

- Spring AI 和 LangChain4j 的功能清单高度重叠，选型比的不是功能，是与现有技术栈的咬合方式和维护成本。
- Spring 技术栈默认 Spring AI：配置、可观测性、Bean 体系的复用是实打实的成本差。
- 非 Spring 栈、需要更细组件或更快跟进新能力，选 LangChain4j；注意 1.0 的接口改名，别抄旧教程。
- Agent 高层编排两家都在早期，这层先自己掌控；业务代码用自有接口隔离框架，保留换框架的权利。

> 待本人确认后发布。
