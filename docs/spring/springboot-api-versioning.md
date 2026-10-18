---
title: "Spring Boot 4.1 的 API 版本控制：Header、Query、路径和 Media Type 到底怎么选"
shortTitle: "API 版本控制"
date: 2026-10-07
category:
  - Spring
tag:
  - Spring Boot
  - API 版本控制
  - RESTful
order: 1
---


> 环境：Windows 11、JDK 17.0.12、Spring Boot 4.1.1、Spring Framework 7.0.9、Tomcat 11.0.24
>
> 验证方式：本地启动服务，分别通过请求头、查询参数、路径段和 Media Type 参数请求同一个接口；代码已编译运行。

目录

- 先说结论
- 一个接口同时接受四种版本来源
- 配置与控制器写法
- 请求结果：精确版本与 1.2+ 的优先级
- 缺少、非法、不支持版本会怎样
- 四种方案怎么选
- 网关、缓存、日志和文档要同步考虑
- 参考资料
- 标签

## 先说结论

Spring Boot 4.1.1 背后的 Spring Framework 7.0.9 已经提供内置 API Versioning。版本号可以来自请求头、查询参数、URL 路径或 Media Type 参数，但进入控制器前都要经过同一个 `ApiVersionStrategy`：先解析原始值，再转成可比较的版本，然后校验并匹配控制器映射。

本次实验里，Header 的 `1.1` 命中固定处理器，Query 的 `1.3` 和路径里的 `1.3` 都命中 `1.2+`，Media Type 的 `1.5` 和路径里的 `1.5` 命中固定版本 1.5。缺少版本、非法版本和不支持版本都返回 400。

四种来源没有天然优劣。真正要提前确定的是版本规范、旧客户端兼容期限、网关能否识别版本，以及日志和 OpenAPI 文档能不能把这些版本信息串起来。

## 一个接口同时接受四种版本来源

实验控制器映射了三个逻辑版本：

| 映射版本 | 返回的处理器 | 作用 |
| --- | --- | --- |
| `1.1` | `fixed-1.1` | 精确处理旧接口 |
| `1.2+` | `baseline-1.2+` | 处理 1.2 及已配置的更高版本 |
| `1.5` | `fixed-1.5` | 精确处理一次破坏性变更 |

应用同时启用了四种解析方式，方便在一次运行中对比结果：

```java
@Override
public void configureApiVersioning(ApiVersionConfigurer configurer) {
    configurer
            .useRequestHeader("X-API-Version")
            .useQueryParam("api-version")
            .useMediaTypeParameter(MediaType.APPLICATION_JSON, "version")
            .usePathSegment(1, path -> path.pathWithinApplication().value().startsWith("/api/"))
            .addSupportedVersions("1.1", "1.2", "1.3", "1.4", "1.5", "1.6");
}
```

`usePathSegment(1, ...)` 中的索引 1 对应 `/api/1.3/greeting` 里的 `1.3`：路径段依次是 `api`、`1.3`、`greeting`。Predicate 只在应用路径以 `/api/` 开头时启用路径解析，避免普通 `/greeting` 请求误把其他字符串当成版本。

这段配置用于验证四种入口，不等于推荐同时开启。生产项目最好明确一种主方案，再为兼容期增加辅助入口。

## 配置与控制器写法

控制器把所有版本映射到相同的路径模板，通过 `version` 属性区分：

```java
@RestController
public class GreetingController {

    @GetMapping(path = {"/greeting", "/api/{version}/greeting"}, version = "1.1")
    public Map<String, String> version11(SemanticApiVersionParser.Version requestVersion) {
        return response("fixed-1.1", requestVersion);
    }

    @GetMapping(path = {"/greeting", "/api/{version}/greeting"}, version = "1.2+")
    public Map<String, String> version12AndAbove(
            SemanticApiVersionParser.Version requestVersion) {
        return response("baseline-1.2+", requestVersion);
    }

    @GetMapping(path = {"/greeting", "/api/{version}/greeting"}, version = "1.5")
    public Map<String, String> version15(SemanticApiVersionParser.Version requestVersion) {
        return response("fixed-1.5", requestVersion);
    }

    private Map<String, String> response(
            String handler, SemanticApiVersionParser.Version version) {
        return Map.of("handler", handler, "resolvedVersion", version.toString());
    }
}
```

默认解析器是 `SemanticApiVersionParser`。请求里写 `1.3`，控制器参数里的版本对象会规范化为 `1.3.0`，因此响应里看到的不是原字符串。

控制器同时保留 `/greeting` 和 `/api/{version}/greeting`，是为了让 Header、Query 和 Media Type 来源走普通路径，让路径来源走带版本段的路径。

## 请求结果：精确版本与 1.2+ 的优先级

启动后先验证 Header：

```powershell
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:18080/greeting' `
  -Headers @{'X-API-Version'='1.1'}
```

结果：

```text
{"resolvedVersion":"1.1.0","handler":"fixed-1.1"}
```

再通过查询参数传 1.3：

```powershell
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:18080/greeting?api-version=1.3'
```

```text
{"resolvedVersion":"1.3.0","handler":"baseline-1.2+"}
```

Media Type 参数和路径的请求如下：

```powershell
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:18080/greeting' `
  -Headers @{Accept='application/json;version=1.5'}

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:18080/api/1.5/greeting'
```

两个请求都命中：

```text
{"resolvedVersion":"1.5.0","handler":"fixed-1.5"}
```

本次实验的关键输出可以整理成：

```text
HEADER 1.1
{"resolvedVersion":"1.1.0","handler":"fixed-1.1"}

HEADER 1.2
{"resolvedVersion":"1.2.0","handler":"baseline-1.2+"}

QUERY 1.3
{"resolvedVersion":"1.3.0","handler":"baseline-1.2+"}

MEDIA 1.5
{"resolvedVersion":"1.5.0","handler":"fixed-1.5"}

PATH 1.3
{"resolvedVersion":"1.3.0","handler":"baseline-1.2+"}

PATH 1.5
{"resolvedVersion":"1.5.0","handler":"fixed-1.5"}
```

`1.2+` 覆盖 1.2 以及配置中更高的版本。请求 1.3 时，`1.1` 精确映射不覆盖它，固定 1.5 又高于请求版本，所以落到 `1.2+`。

请求 1.5 时情况不同。`1.2+` 和固定 `1.5` 都满足条件，但固定版本更具体、离请求版本更近，因此固定处理器优先。

## 缺少、非法、不支持版本会怎样

API Versioning 默认要求请求必须带版本。去掉 Header 和 Query 后请求 `/greeting`：

```text
missing: status=400
```

传入尚未配置的 2.0：

```text
unsupported-header (2.0): status=400
```

传入无法解析的 `abc`：

```text
invalid-header (abc): status=400
```

这三种情况对应不同的业务含义：

| 场景 | 异常语义 | 对外建议 |
| --- | --- | --- |
| 没有版本 | `MissingApiVersionException` | 返回 400，并在错误信息中说明版本应放在哪里 |
| 格式错误 | `InvalidApiVersionException` | 返回 400，说明支持的版本格式 |
| 版本不支持 | `InvalidApiVersionException` | 返回 400 或 406，同时给出当前支持范围 |
| 版本存在但无处理器 | 映射不匹配或 `NotAcceptableApiVersionException` | 返回明确的版本不可用信息，不要伪装成服务器错误 |

如果版本可省略，可以配置默认版本或让框架选择最新版本。这样做能降低旧客户端改造成本，但也会隐藏客户端没有发送版本的事实。日志中最好保留“未传版本并使用了默认值”的标记，否则排查请求行为时很难判断版本来自哪里。

## 四种方案怎么选

| 维度 | 请求头 | 查询参数 | URL 路径 | Media Type 参数 |
| --- | --- | --- | --- | --- |
| 示例 | `X-API-Version: 1.3` | `?api-version=1.3` | `/api/1.3/greeting` | `Accept: application/json;version=1.5` |
| 对 URL 的影响 | 小 | 中等 | 明确改变资源地址 | 小 |
| 缓存友好度 | 需要把请求头加入缓存键 | URL 天然区分 | URL 天然区分 | 需要把 Accept 或参数纳入缓存键 |
| 浏览器直接访问 | 不方便 | 方便 | 最直观 | 不方便 |
| 网关路由 | 需要读取请求头 | 需要解析查询参数 | 容易按路径路由 | 需要解析媒体类型 |
| 客户端改造 | 中等 | 较低 | 较高 | 较高 |
| 常见风险 | 代理和缓存漏掉头信息 | 链接污染、参数被忽略 | 同一资源出现多个路径 | 媒体类型解析差异 |
| 适合场景 | 内部服务、网关可统一处理 | 调试、简单应用、过渡期 | 对外 API、需要明确地址 | 内容协商本身就是契约的一部分 |

路径版本的优势是可见、可缓存、容易做网关策略。它的代价是版本进入资源标识，客户端升级时需要替换路径，旧路径也要保留一段时间。

Header 版本让 URL 保持稳定，适合内部 API 和由 SDK 统一封装的服务。但缓存、浏览器直达、日志检索和网关规则都更依赖中间件是否正确转发请求头。

Query 参数最容易手工验证，也最容易被复制传播。它适合快速上线和兼容期，但如果版本成为长期契约，URL 会混入越来越多控制参数。

Media Type 参数适合已经围绕内容协商设计接口的系统。它把“返回什么表示”和“返回哪个版本”放在一起，但对客户端、网关和测试工具的要求相对更高。

如果让我在普通 REST 服务里选，我会优先考虑 URL 路径或请求头。前者直观，后者能保持地址稳定。查询参数适合作为过渡入口，Media Type 参数只在团队已经统一使用内容协商时收益更明显。

## 网关、缓存、日志和文档要同步考虑

版本解析发生在 Spring MVC 内部，请求在到达应用前还会经过反向代理、网关、CDN 和日志系统。

版本放在请求头时，网关的鉴权、路由和缓存组件必须明确区分哪些头参与缓存键。否则 1.2 和 1.3 可能被错误地当成同一个响应。

版本放在 URL 时，访问日志和 APM 通常能直接看到版本，但旧路径、重定向规则和监控告警要一起维护。不要只改控制器，遗漏网关里写死的路径规则。

版本放在 Query 时，统计系统要避免把含版本的完整 URL 当成完全不同的页面，否则一个接口很容易出现大量相似地址。

版本放在 Media Type 时，接口文档、测试请求和客户端生成器都要支持参数化媒体类型。只改服务端，调用方往往会在 `Accept` 或 `Content-Type` 上踩坑。

无论选哪种方式，都应该在日志中记录三样东西：解析到的版本、版本来源、匹配到的处理器。出现兼容问题时，才能判断是客户端没传、网关没转发，还是服务端映射写错。

版本控制最终要保护的是接口契约的变更边界。旧版本什么时候停止支持、弃用信息怎么返回、客户端如何灰度升级，这些问题比“版本号放哪里”更值得在项目初期确定。

## 参考资料

- Spring Framework Reference: API Versioning，说明 `ApiVersionStrategy`、版本解析、校验和请求映射：<https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html>
- Spring Framework Reference: API Version，说明 MVC 配置入口：<https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-config/api-version.html>
- Spring Framework Reference: Request Mapping - API Version，说明固定版本、baseline 版本和匹配优先级：<https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html>
- Spring Framework Javadoc: `ApiVersionConfigurer`：<https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/servlet/config/annotation/ApiVersionConfigurer.html>
- Spring Framework Javadoc: `SemanticApiVersionParser`：<https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/web/accept/SemanticApiVersionParser.html>

## 标签

`Spring Boot` `Spring Framework` `API 版本控制` `REST API` `Java`
