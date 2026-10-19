---
title: "MCP 工具接入的安全边界：从 Confused Deputy 到最小权限，别把 Agent 变成万能钥匙"
description: "MCP 工具接入的安全边界：从 Confused Deputy 问题到最小权限设计，别把 Agent 变成万能钥匙。"
shortTitle: "MCP 安全边界"
date: 2026-10-05
category:
  - Agent
tag:
  - MCP
  - 安全
  - 最小权限
order: 4
---


> 协议版本：MCP 2026-07-28  
> 实验环境：Windows 11、Oracle JDK 17.0.12、PowerShell  
> 说明：文中的 Java 示例只验证策略判断的输入输出，不代替 OAuth 服务器、MCP SDK 或生产级 JWT 校验。

**目录**

- 为什么“能调用工具”不是普通 API 集成
- MCP 里的四类角色和两条信任边界
- 三类典型风险怎么发生
- 最小权限要落到哪些字段
- 用一个 Java 策略层验证 token 与 scope
- Java 后端接入时的工程检查表
- 还没有覆盖到的生产问题
- 参考资料

## 为什么“能调用工具”不是普通 API 集成

把一个订单查询工具交给 Agent 以后，模型返回一个 `tools/call`，只能说明它在当前上下文里决定调用这个工具。后端的登录态还在，不等于这次调用已经被授权；工具参数看起来合法，也不等于调用的目标、范围和副作用都符合用户意图。

普通 API 集成里，调用方通常是明确的业务代码。Agent 场景里，工具名和参数会经过模型生成，工具描述又可能来自第三方 MCP Server。模型看到的自然语言、工具返回内容、网页片段和文件内容，都可能影响下一次调用。只要把这些内容直接当成授权依据，读数据的工具就可能成为入口，写文件或发请求的工具就可能成为出口。

这篇要解决的是一类很具体的问题：MCP Server 已经接上了，OAuth 也能拿到 token，但后端还缺少“这次调用究竟允许做什么”的判断。核心结论可以先写在这里：MCP 解决的是 Host、Client、Server 之间怎样暴露和调用能力，应用仍然要自己完成用户同意、资源绑定、scope 最小化、参数检查和审计。Bearer token 只证明请求携带了某种凭据，不能替代业务授权。

## MCP 里的四类角色和两条信任边界

MCP 规范使用 JSON-RPC 2.0。它把参与者拆成 Hosts、Clients、Servers，授权场景里还会连接一个 Authorization Server。

| 角色 | 负责什么 | 容易混淆的地方 |
| --- | --- | --- |
| Host | 运行模型、组织 Agent、和用户交互 | Host 拿到用户同意后，才有理由把用户数据交给合适的 Client |
| Client | 维持到某个 Server 的连接、协商能力、发送 JSON-RPC 请求 | Client 是协议连接者，不是最终授权决策者 |
| Server | 提供 Resources、Prompts、Tools，也可以使用 Elicitation 请求补充输入 | Server 声明的工具注解、描述和权限需求不能天然视为可信 |
| Authorization Server | 签发和校验 access token，处理授权流程 | token 签发给谁、允许访问哪个资源，必须由受保护资源再次核对 |

Server 暴露的三类能力边界不同。Resources 更接近读取数据，Prompts 通常提供可复用模板，Tools 则可能执行任意代码或产生外部副作用。规范把工具执行视为高风险能力，要求 Host 在调用任何工具前取得明确的用户同意。工具描述和注解可以帮助界面展示，但 Server 不可信时，这些字段也不能当作安全证明。

两条信任边界值得单独记住：

1. 从 Server、网页、文件和工具结果进入模型上下文的数据，是外部输入。模型可以总结它，不能因为模型读到了就自动把它升级成用户指令。
2. 从模型返回的 tool call 进入真实系统之前，必须经过服务端策略。模型负责提出意图，服务端负责判断这个意图能不能执行。

## 三类典型风险怎么发生

### Confused Deputy 会把“谁同意过”弄混

Confused Deputy 的典型条件是：授权代理持有静态 client ID，接受动态注册，或者把多个客户端的授权请求塞进同一个用户级 consent cookie。代理随后用自己有权限的客户端身份去请求第三方授权，却没有确认当前用户到底同意的是哪个客户端。

这类实现最容易在下面几个地方出错：

- 只记录“用户曾经同意过”，cookie 没有绑定具体的 `client_id`。
- `redirect_uri` 使用前缀、通配符或不完整的 URL 校验。
- `state` 可以重复使用，或者有效期过长。
- 用户还没确认授权，代理已经先建立了对应的 session。

官方安全实践给出的方向是 per-client consent。同意记录要绑定具体的 client，`redirect_uri` 做精确字符串匹配，`state` 单次使用并短期有效，同意动作完成前不要设置授权相关的 cookie 或 session。

### token 用错接收方，等价于把权限送错门

MCP 的 HTTP 授权流程基于 OAuth 2.1。Client 需要通过 Protected Resource Metadata 找到对应的 authorization server，并在授权请求和 token 请求里使用 Resource Indicators，也就是 RFC 8707 的 `resource` 参数，把 token 和目标 MCP Server 绑定起来。

Server 收到 token 后，要校验 issuer、audience，以及 token 是否签发给当前 MCP Server。只验证“签名有效”或者“能解析出用户 ID”不够。一个发给其他服务的 token，也可能签名正确、没有过期，却不应该被这个资源服务器接受。

规范明确反对 token passthrough。MCP Server 不应该把 Client 送来的 token 原样转发给下游服务，也不应该接受不是由自己授权服务器签发的 token。access token 应放在每个 HTTP 请求的 `Authorization: Bearer ...` 头里，计划里不要把它塞到 URI query。

issuer 的校验还有一个容易被忽略的细节：`iss` 要做简单字符串比较，不能先做 URL 归一化再比较。错误响应里的 `iss` 也应遵循相同规则。URL 看起来等价，不代表授权主体相同。

### scope、SSRF 和 session 会放大小错误

scope 过宽是另一种常见问题。`files:*`、`db:*`、`admin:*` 看起来省事，实际把“读一个配置文件”和“删除整个目录”放进了同一个授权层级。更稳妥的做法是从低风险 scope 开始，运行期发现权限不足时再做 step-up authorization。

运行期 scope 不足时，资源服务器返回 HTTP 403，并通过 `WWW-Authenticate` 给出 challenge：

```http
WWW-Authenticate: Bearer error="insufficient_scope", scope="profile:read files:write files:read"
```

客户端拿到 challenge 后，可以请求补足权限，但重试必须有上限，失败结果也应缓存，避免授权循环或反复打扰用户。

SSRF 和 Session Hijacking 则发生在传输和服务生命周期附近。metadata discovery、DNS rebinding、重定向链和检查到使用之间的 TOCTOU，都可能让 Server 访问到非预期地址。生产环境应使用 HTTPS，只有本地回环开发场景才可以考虑 HTTP。授权 URL 只允许 `http://` 和 `https://`，并且不能通过 shell 打开；`javascript:`、`data:`、`file:`、`vbscript:` 这类 scheme 应直接拒绝。

session 也不能被当成一次认证的永久证明。每次入站请求都要重新确认用户、Client、token 和资源范围。如果只凭 session 存在就认为调用者仍是原来的用户，会话固定或劫持之后，后续工具调用会沿用一个错误的身份上下文。

本地 MCP Server 还有一层供应链风险。它往往是从网络下载后在用户机器上执行的二进制或脚本。Host 至少要把完整命令、参数来源、可访问目录和网络权限展示给用户，得到明确同意后再运行，并尽可能放进沙箱或低权限账户。安装路径可写、环境变量带密钥、进程能访问整个用户目录，都会让一个简单的工具发现过程变成权限扩散。

## 最小权限要落到哪些字段

“最小权限”不能只写在配置说明里，需要落到一次工具调用的策略输入。下面这些字段至少要参与判断：

| 字段 | 要回答的问题 |
| --- | --- |
| 用户与租户 | 当前请求代表谁，数据属于哪个组织 |
| `client_id` | 用户同意的是哪个客户端，不是哪一类客户端 |
| issuer | token 由哪个授权服务器签发，字符串是否完全一致 |
| audience / resource | token 是否明确签发给当前 MCP Server |
| scope | 本次工具调用需要的具体能力是什么 |
| consent record | 用户是否同意这次数据访问或副作用 |
| tool risk | 工具是只读、写入、外部发送，还是可以执行命令 |
| 参数字段 | 路径、SQL、URL、收件人、数量和资源 ID 是否在允许范围 |
| session / request | 当前连接是否仍然代表同一个用户和 Client |
| audit context | 决策、参数摘要、结果和 trace ID 是否可追溯 |

其中最容易漏掉的是工具风险分类和参数约束。一个名为 `read_file` 的工具未必只读，一个名为 `search` 的工具也可能把查询内容发到外部服务。工具注册表应由应用维护，而不是完全依赖 Server 自报。写操作、外部发送和高权限命令还需要二次确认、幂等键和回滚策略。

## 用一个 Java 策略层验证 token 与 scope

下面这段代码用 JDK 标准库模拟三层检查：issuer 是否精确匹配，audience 是否包含当前 MCP Server 的 canonical resource URI，以及本次调用要求的 scope 是否齐全。它不解析 JWT，也不验证签名，只用来把“服务端必须有一层策略判断”变成可运行的最小例子。

```java
import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Set;

public final class McpAuthPolicyDemo {
    private record TokenClaims(String issuer, Set<String> audience, Set<String> scopes) {
    }

    private record Decision(boolean allowed, String code, String reason) {
    }

    private static Decision evaluate(
            TokenClaims token,
            String expectedIssuer,
            URI expectedResource,
            Set<String> requiredScopes) {
        if (token == null) {
            return new Decision(false, "missing_token", "没有可用的 access token");
        }
        if (!expectedIssuer.equals(token.issuer())) {
            return new Decision(false, "issuer_mismatch", "issuer 与已记录的授权服务器不一致");
        }
        if (!token.audience().contains(expectedResource.toString())) {
            return new Decision(false, "audience_mismatch", "token 不是签发给当前 MCP Server 的");
        }

        Set<String> missing = new LinkedHashSet<>(requiredScopes);
        missing.removeAll(token.scopes());
        if (!missing.isEmpty()) {
            return new Decision(
                    false,
                    "insufficient_scope",
                    "缺少 scope: " + String.join(" ", missing));
        }
        return new Decision(true, "allowed", "issuer、audience 和 scope 均满足");
    }

    private static String stepUpChallenge(Set<String> granted, Set<String> required) {
        Set<String> merged = new LinkedHashSet<>(granted);
        merged.addAll(required);
        return "Bearer error=\"insufficient_scope\", scope=\""
                + String.join(" ", merged) + "\"";
    }

    private static void print(String label, Decision decision) {
        System.out.printf(
                "%s -> allowed=%s, code=%s, reason=%s%n",
                label, decision.allowed(), decision.code(), decision.reason());
    }

    public static void main(String[] args) {
        String issuer = "https://auth.example.com";
        URI resource = URI.create("https://mcp.example.com");
        Set<String> required = Set.of("files:read");

        TokenClaims valid = new TokenClaims(
                issuer,
                Set.of(resource.toString()),
                Set.of("files:read", "files:search"));
        print("valid token", evaluate(valid, issuer, resource, required));

        TokenClaims wrongIssuer = new TokenClaims(
                "https://attacker.example",
                Set.of(resource.toString()),
                Set.of("files:read"));
        print("wrong issuer", evaluate(wrongIssuer, issuer, resource, required));

        TokenClaims wrongAudience = new TokenClaims(
                issuer,
                Set.of("https://another-service.example"),
                Set.of("files:read"));
        print("wrong audience", evaluate(wrongAudience, issuer, resource, required));

        TokenClaims missingScope = new TokenClaims(
                issuer,
                Set.of(resource.toString()),
                Set.of("profile:read"));
        print("missing scope", evaluate(missingScope, issuer, resource, required));

        String challenge = stepUpChallenge(
                Set.of("profile:read"),
                Set.of("files:read", "files:write"));
        System.out.println("step-up challenge -> " + challenge);
    }
}
```

在 Windows PowerShell、JDK 17.0.12 下编译并运行：

```powershell
javac -encoding UTF-8 .\McpAuthPolicyDemo.java
java '-Dfile.encoding=UTF-8' McpAuthPolicyDemo
```

本机输出如下：

```text
valid token -> allowed=true, code=allowed, reason=issuer、audience 和 scope 均满足
wrong issuer -> allowed=false, code=issuer_mismatch, reason=issuer 与已记录的授权服务器不一致
wrong audience -> allowed=false, code=audience_mismatch, reason=token 不是签发给当前 MCP Server 的
missing scope -> allowed=false, code=insufficient_scope, reason=缺少 scope: files:read
step-up challenge -> Bearer error="insufficient_scope", scope="profile:read files:write files:read"
```

这段输出只证明了策略函数的判断结构。生产代码还需要 JWT 签名和算法校验、`exp` 与 `nbf`、时钟偏移、密钥轮换、token introspection 或撤销检查、并发缓存、敏感字段脱敏，以及和真实策略引擎或授权数据库的集成。

## Java 后端接入时的工程检查表

把 MCP 接进 Spring 或普通 Java 服务时，可以直接按下面的顺序做一次代码审查。

| 检查项 | 需要看到的证据 |
| --- | --- |
| 工具注册 | 工具有显式 allowlist、风险等级、所需 scope 和参数 schema |
| 每次请求认证 | 不依赖 session 猜测用户，每个入站请求都有可验证身份 |
| token 边界 | 校验 issuer、audience、资源 URI，拒绝非本 Server 签发的 token |
| 授权策略 | 用户、租户、Client、工具、资源和 scope 同时参与决策 |
| 用户同意 | 读敏感数据和执行副作用前都有可审计的确认记录 |
| 参数校验 | 文件路径、URL、SQL、命令和资源 ID 走白名单或参数化接口 |
| 沙箱与网络 | 子进程最小权限、目录限制、网络 allowlist、超时和资源上限 |
| 幂等和恢复 | 写操作有幂等键、状态检查、失败记录和重试上限 |
| 日志审计 | trace ID、决策原因、参数摘要和授权结果可追踪且已脱敏 |
| 负向测试 | 错 issuer、错 audience、缺 scope、跨租户、重放 state 和重定向都覆盖 |

LLM 应用里还要防止模型替用户完成确认。工具说明、网页内容和文件文本都可以包含假的“已确认”指令，真正的 consent 必须由服务端记录，不能让模型上下文里的文本成为同意凭据。

## 还没有覆盖到的生产问题

OAuth 和 scope 能解决凭据绑定、资源绑定和权限粒度，不能单独解决所有 Agent 风险。工具返回内容进入模型后仍可能带来提示注入，工具参数可能被设计成把敏感数据写到外部地址，多个 Server 组合起来还可能形成数据流。企业环境还需要考虑用户离职后的 token 撤销、密钥托管、网络出口审计、工具供应链签名和本地进程隔离。

实际落地时，建议把“能调用”和“允许产生后果”分开测试。只读查询、写数据库、发邮件、执行本地命令应该有不同的确认界面、日志和回滚要求。MCP 让工具接入更标准，安全边界仍然在应用这一层。

## 参考资料

- [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [MCP schema.ts](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/rfc9700)
