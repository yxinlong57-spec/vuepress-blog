---
title: "从会用到会写：用 Java 实现一个符合 MCP 规范的 Server，并在本机跑通一把"
shortTitle: "手写 MCP Server"
date: 2026-10-19
description: "只会装现成 MCP Server 不够用：用纯 JDK 手写一个符合规范的 MCP Server，真实跑通 initialize、tools/list、tools/call，附完整报文与踩坑。"
category:
  - Agent
tag:
  - MCP
  - Java
  - 协议实现
  - JSON-RPC
order: 16
---

> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin）
> 说明：Server 与客户端都是纯 JDK 单文件（`java X.java` 直接运行，无第三方依赖），客户端通过 `ProcessBuilder` 拉起 Server 子进程，走真实 stdio 收发报文。本文实现的是握手时代的 2025-06-18 版协议；未在本机验证的部分会单独标注。

**目录**

- 一、MCP 解决什么问题：Server 站在协议的哪一侧
- 二、最小可用协议面：握手、能力声明、tools/list、tools/call
- 三、手写 Server：帧处理、极简 JSON、路由与两个工具
- 四、跑通：initialize → tools/list → tools/call 的真实报文
- 五、补两个实验：版本协商与坏参数
- 六、接进真实 Agent：它怎么被加载，和 Function Calling 怎么分工
- 七、生产化要点：日志、错误、超时、校验
- 八、常见坑：五个真实踩到的问题
- 九、面试视角怎么答
- 小结
- 参考资料

## 一、MCP 解决什么问题：Server 站在协议的哪一侧

我的入口问题很具体：想给内部订单系统加一个「能被 Agent 调用」的接口。现成的 MCP Server 能连 GitHub、能读本地文件、能查网页，但没人替我读自家订单表。装一个 Server 我会，写一个 Server 我不会——更麻烦的是，SDK 帮我封装得太好，我说不清线上到底跑了什么报文，出问题只能在 SDK 日志里碰运气。

先把结论放在开头：**MCP Server 在协议层面不神秘。stdio 传输上它就是「一行一条 JSON-RPC 2.0 报文」的服务端，最小可用面只有 initialize、tools/list、tools/call 三个方法，外加一条 initialized 通知。** 一个单文件 Java 程序，不引任何依赖，就能实现它，并且在真实的父子进程通信里跑通。

本文路线：先划清 MCP 和 Function Calling 的边界，再抽出最小协议面，然后写完整的 Server 和极简 Client 并贴出真实报文，最后讲清生产化要点和坑。

角色边界要先摆正，否则后面所有报文都会理解错：

| 维度 | Function Calling | MCP |
| --- | --- | --- |
| 本质 | 模型提供方给出的模型能力 | 应用层协议（基于 JSON-RPC 2.0） |
| 发生位置 | 模型 ↔ 应用之间 | 应用（client）↔ 工具进程（server）之间 |
| 谁产出「要调哪个工具」 | 模型（返回结构化 tool_calls） | 模型（同上，MCP 不参与） |
| 谁负责执行 | 应用自己实现 | MCP Server 进程执行 |
| 产物 | 结构化参数 | `tools/call` 报文与 `result.content` |
| 错误形态 | 应用自行定义 | 规范统一了两层错误通道 |

一句话总结这条接力链：**模型通过 function calling 说「我要调 `query_orders`」，应用作为 MCP client 把这句意图翻译成 `tools/call` 发给 Server，Server 执行后返回 `content`，应用再把 `content` 喂回模型。** 模型从头到尾不知道 MCP 存在。

在 MCP 的角色模型里，Server 是**能力提供方**：它在 initialize 时声明自己提供哪几类能力（tools、prompts、resources、logging 等），之后被动响应 client 的请求，自己不主动发请求。官方规范把「模型可以直接发现并调用工具」描述为 model-controlled，并要求应用侧保留人工否决的入口（[Tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)）。

本专栏前两篇分别讲了「怎么接 MCP 工具」和「MCP 的安全边界」，都停留在使用方视角；这篇补上实现方视角：同样的报文，这次是我自己发出去的。权限与授权策略的完整讨论以那篇安全文为准，本文只在代码里保留最必要的路径白名单校验。

## 二、最小可用协议面：握手、能力声明、tools/list、tools/call

**帧格式**是理解一切的起点。MCP 用 JSON-RPC 2.0 编码消息，消息必须是 UTF-8；stdio 传输下「消息以换行分隔，且消息内不能包含换行」（[Transports 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)）。规范对 stdout 的约束是硬性的：

- Server **MUST NOT** 往 stdout 写任何不是合法 MCP 消息的内容；
- Server **MAY** 往 stderr 写 UTF-8 日志，客户端可以捕获也可以忽略。

这两条直接决定了 Server 的代码结构——我后面会把 `stdout` 和 `stderr` 两个流在入口处就分开。

**握手**分三步（[Lifecycle 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization)）：

1. client **MUST** 先发 `initialize`，参数里带 `protocolVersion`、`capabilities`、`clientInfo`；
2. server 返回自己的 `protocolVersion`、`capabilities`、`serverInfo`（可选 `instructions`）；
3. client **MUST** 再发 `notifications/initialized` 通知，表示进入正常操作阶段。

**版本协商**是握手里的重点：请求的版本 server 支持，就 **MUST** 原样返回；不支持，则 **MUST** 返回自己支持的另一版；client 不支持 server 返回的版本时 **SHOULD** 断开。这条规则让协议得以演进，也是我下面做补充实验的原因。

这里有一个必须说清的现状：**「initialize 握手」属于旧时代。** 按规范 [Versioning 页面](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)的定义，`2026-07-28` 及之后的版本是 modern：不再有握手，协议版本、客户端身份、能力都随每个请求放在 `_meta` 里（如 `io.modelcontextprotocol/protocolVersion`），server **MUST** 实现 `server/discover`；`2025-11-25` 及更早是 legacy，也就是握手时代。所以现在的现实是两套并存：大多数已部署的 SDK 和客户端仍按 legacy 握手走，新写的实现要面对 modern 的按请求元数据。**本文实现 legacy 的 `2025-06-18` 版**——它是握手时代里被沿用最广的一版，报文形状也最简单，适合把协议看清楚。

**能力声明**决定了这个连接上允许出现哪些方法。声明 `tools` 能力（`{"tools":{"listChanged":true}}`）表示提供可调用工具；`listChanged` 表示工具清单变化时 server 会发 `notifications/tools/list_changed`。我这次声明 `listChanged:false`，因为工具清单是写死的。

两个核心方法的报文形状（[Tools 规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#protocol-messages)）：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"cursor":"可选的分页游标"}}
```

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_weather","description":"Get current weather information for a location","inputSchema":{"type":"object","properties":{"location":{"type":"string","description":"City name or zip code"}},"required":["location"]}}],"nextCursor":"next-page-cursor"}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_weather","arguments":{"location":"New York"}}}
```

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Current weather in New York"}],"isError":false}}
```

`tools/list` 里每项工具有 `name`、`description`、`inputSchema`；`tools/call` 的 `result.content` 是数组，元素可以是 `text`、`image`、`audio`、`resource_link`、`resource` 等类型（多模态工具就靠这个结构），`isError` 标记这次执行是否失败。可选字段还有 `title`、`outputSchema`、`annotations`。

**通知与请求的区别**只看一件事：有没有 `id`。有 `id` 就必须应答，没 `id` 就是通知，**不应答**。规范在 lifecycle 里给的通知名是 `notifications/initialized`；换行分隔的 stdio 上没有第二条通道，所有消息共用 stdout 这一条流，所以「不该应答的消息回了应答」会直接打乱客户端的请求-响应配对。

## 三、手写 Server：帧处理、极简 JSON、路由与两个工具

下面这份 `McpServer.java` 是本机实际运行的那份，运行环境 JDK 11.0.32.1，无第三方依赖。全文约 430 行，结构分四块：入口与流分离、极简 JSON 解析/序列化、方法路由、工具实现。

```java
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 手写 MCP Server（stdio 传输，握手时代协议 2025-06-18，纯 JDK，无第三方依赖）。
 * 运行：java -Dfile.encoding=UTF-8 McpServer.java
 * 约束：stdout 只写 JSON-RPC 报文，日志一律走 stderr。
 */
public class McpServer {

    static final String PROTOCOL_VERSION = "2025-06-18";
    static final String SERVER_NAME = "mini-mcp-server";
    static final String SERVER_VERSION = "0.1.0";

    /** 工具可访问的根目录，所有 path 参数都必须落在它下面。 */
    static final Path DATA_ROOT = Paths.get("data").toAbsolutePath().normalize();

    static final List<String> STATUSES = Arrays.asList("PAID", "SHIPPED", "REFUNDED", "CREATED");

    static final List<Order> ORDERS = new ArrayList<>();

    static PrintStream protocolOut; // stdout：只放协议报文
    static PrintStream logs;        // stderr：日志

    static final class Order {
        final String id;
        final String status;
        final double amount;
        final String createdAt;

        Order(String id, String status, double amount, String createdAt) {
            this.id = id;
            this.status = status;
            this.amount = amount;
            this.createdAt = createdAt;
        }
    }

    static {
        ORDERS.add(new Order("SO20261019001", "PAID", 199.00, "2026-10-19T09:12:31"));
        ORDERS.add(new Order("SO20261019002", "PAID", 3580.50, "2026-10-19T10:03:07"));
        ORDERS.add(new Order("SO20261019003", "SHIPPED", 89.90, "2026-10-19T11:40:52"));
        ORDERS.add(new Order("SO20261018007", "REFUNDED", 1299.00, "2026-10-18T20:15:44"));
        ORDERS.add(new Order("SO20261018008", "CREATED", 45.00, "2026-10-18T21:02:19"));
    }

    public static void main(String[] args) throws IOException {
        protocolOut = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        logs = new PrintStream(new FileOutputStream(FileDescriptor.err), true, "UTF-8");
        logs.println("[server] started, protocol=" + PROTOCOL_VERSION + ", data_root=" + DATA_ROOT);

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isEmpty()) continue;
            dispatch(line);
        }
        logs.println("[server] stdin EOF, exit");
    }

    static void dispatch(String line) {
        Object parsed;
        try {
            parsed = Json.parse(line);
        } catch (RuntimeException e) {
            logs.println("[server] parse error: " + e.getMessage());
            writeError(null, -32700, "Parse error", e.getMessage());
            return;
        }
        if (!(parsed instanceof Map)) {
            writeError(null, -32600, "Invalid Request", "报文不是 JSON 对象");
            return;
        }
        Map<String, Object> msg = asMap(parsed);
        boolean isNotification = !msg.containsKey("id");
        Object id = msg.get("id");
        Object methodRaw = msg.get("method");
        if (!(methodRaw instanceof String)) {
            if (!isNotification) writeError(id, -32600, "Invalid Request", "缺少 method 字段");
            return;
        }
        String method = (String) methodRaw;
        Map<String, Object> params = msg.get("params") instanceof Map
                ? asMap(msg.get("params")) : new LinkedHashMap<>();

        if (isNotification) {
            logs.println("[server] notification " + method + "（通知不回应答）");
            return;
        }
        try {
            switch (method) {
                case "initialize":
                    onInitialize(id, params);
                    break;
                case "tools/list":
                    onToolsList(id);
                    break;
                case "tools/call":
                    onToolsCall(id, params);
                    break;
                case "ping":
                    writeResult(id, new LinkedHashMap<>());
                    break;
                default:
                    writeError(id, -32601, "Method not found: " + method, null);
            }
        } catch (RuntimeException e) {
            logs.println("[server] internal error: " + e);
            writeError(id, -32603, "Internal error", String.valueOf(e.getMessage()));
        }
    }

    static void onInitialize(Object id, Map<String, Object> params) {
        String requested = str(params.get("protocolVersion"));
        logs.println("[server] initialize from " + Json.write(params.get("clientInfo"))
                + ", requested protocol=" + requested);
        if (!PROTOCOL_VERSION.equals(requested)) {
            logs.println("[server] 客户端请求 " + requested + "，本 Server 只支持 "
                    + PROTOCOL_VERSION + "，按规范回退为 " + PROTOCOL_VERSION);
        }
        Map<String, Object> toolsCapability = new LinkedHashMap<>();
        toolsCapability.put("listChanged", false);

        Map<String, Object> capabilities = new LinkedHashMap<>();
        capabilities.put("tools", toolsCapability);

        Map<String, Object> serverInfo = new LinkedHashMap<>();
        serverInfo.put("name", SERVER_NAME);
        serverInfo.put("version", SERVER_VERSION);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("protocolVersion", PROTOCOL_VERSION);
        result.put("capabilities", capabilities);
        result.put("serverInfo", serverInfo);
        result.put("instructions", "本 Server 只声明 tools 能力；read_file_meta 的 path 必须位于 data/ 目录内。");
        writeResult(id, result);
    }

    static void onToolsList(Object id) {
        List<Object> tools = new ArrayList<>();
        tools.add(tool("read_file_meta",
                "读取 data/ 目录内某个文件的元信息：字节大小、最后修改时间、是否为目录。只返回元信息，不返回文件内容。",
                objectSchema(props(
                        "path", prop("string", "相对 data/ 目录的文件路径，例如 notes.txt；不能使用 .. 或绝对路径")
                ), list("path"))));
        tools.add(tool("query_orders",
                "查询内存中的订单表。可按订单状态和最低金额过滤，返回订单号、状态、金额、下单时间，以及命中订单的金额合计。",
                objectSchema(props(
                        "status", propEnum("string", "按订单状态过滤，取值必须来自枚举",
                                "PAID", "SHIPPED", "REFUNDED", "CREATED"),
                        "minAmount", prop("number", "只返回金额大于等于该值的订单"),
                        "limit", prop("integer", "最多返回几条，1 到 20，默认 5")
                ), list())));

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("tools", tools);
        writeResult(id, result);
    }

    static void onToolsCall(Object id, Map<String, Object> params) {
        String name = str(params.get("name"));
        Map<String, Object> arguments = params.get("arguments") instanceof Map
                ? asMap(params.get("arguments")) : new LinkedHashMap<>();
        logs.println("[server] tools/call name=" + name + " arguments=" + Json.write(arguments));
        if (name == null) {
            writeError(id, -32602, "Invalid params", "tools/call 缺少 name 字段");
            return;
        }
        switch (name) {
            case "read_file_meta":
                readFileMeta(id, arguments);
                break;
            case "query_orders":
                queryOrders(id, arguments);
                break;
            default:
                writeError(id, -32602, "Unknown tool: " + name, null);
        }
    }

    static void readFileMeta(Object id, Map<String, Object> arguments) {
        String raw = str(arguments.get("path"));
        if (raw == null || raw.isBlank()) {
            toolError(id, "参数错误：path 必填，且必须是字符串。");
            return;
        }
        Path target = DATA_ROOT.resolve(raw).normalize();
        if (!target.startsWith(DATA_ROOT)) {
            toolError(id, "权限拒绝：path 必须位于 data/ 目录内，收到 " + raw);
            return;
        }
        if (!Files.exists(target)) {
            toolError(id, "文件不存在：" + raw);
            return;
        }
        try {
            Path real = target.toRealPath(); // 先解析符号链接，再比前缀
            if (!real.startsWith(DATA_ROOT.toRealPath())) {
                toolError(id, "权限拒绝：符号链接指向 data/ 目录之外，收到 " + raw);
                return;
            }
            boolean isDirectory = Files.isDirectory(real);
            long sizeBytes = isDirectory ? 0L : Files.size(real);
            String lastModified = Files.getLastModifiedTime(real).toInstant().toString();
            toolText(id, "path=" + raw
                    + "\nsize_bytes=" + sizeBytes
                    + "\nlast_modified=" + lastModified
                    + "\nis_directory=" + isDirectory);
        } catch (IOException e) {
            toolError(id, "读取元信息失败：" + e.getMessage());
        }
    }

    static void queryOrders(Object id, Map<String, Object> arguments) {
        String status = str(arguments.get("status"));
        if (status != null && !STATUSES.contains(status)) {
            toolError(id, "参数错误：status 只能取 " + STATUSES + "，收到 " + status);
            return;
        }
        Double minAmount = num(arguments.get("minAmount"));
        if (arguments.containsKey("minAmount") && minAmount == null) {
            toolError(id, "参数错误：minAmount 必须是数字。");
            return;
        }
        Long limitRaw = lng(arguments.get("limit"));
        if (arguments.containsKey("limit") && limitRaw == null) {
            toolError(id, "参数错误：limit 必须是整数。");
            return;
        }
        int limit = limitRaw == null ? 5 : (int) Math.max(1L, Math.min(20L, limitRaw));

        List<Order> hits = new ArrayList<>();
        for (Order order : ORDERS) {
            if (status != null && !order.status.equals(status)) continue;
            if (minAmount != null && order.amount < minAmount) continue;
            hits.add(order);
        }
        hits.sort(Comparator.comparingDouble((Order o) -> o.amount).reversed());

        int shown = Math.min(limit, hits.size());
        double totalAmount = 0.0;
        for (Order order : hits) totalAmount += order.amount;

        StringBuilder text = new StringBuilder();
        text.append("命中 ").append(hits.size()).append(" 条，展示前 ").append(shown).append(" 条：");
        for (int i = 0; i < shown; i++) {
            Order order = hits.get(i);
            text.append("\n- ").append(order.id)
                    .append(" | ").append(order.status)
                    .append(" | CNY ").append(String.format(Locale.ROOT, "%.2f", order.amount))
                    .append(" | ").append(order.createdAt);
        }
        text.append("\n命中订单金额合计：CNY ")
                .append(String.format(Locale.ROOT, "%.2f", totalAmount));
        toolText(id, text.toString());
    }

    static void toolText(Object id, String text) {
        writeResult(id, toolResult(text, false));
    }

    static void toolError(Object id, String text) {
        writeResult(id, toolResult(text, true));
    }

    static Map<String, Object> toolResult(String text, boolean isError) {
        Map<String, Object> contentItem = new LinkedHashMap<>();
        contentItem.put("type", "text");
        contentItem.put("text", text);

        List<Object> content = new ArrayList<>();
        content.add(contentItem);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("content", content);
        result.put("isError", isError);
        return result;
    }

    static Map<String, Object> tool(String name, String description, Map<String, Object> inputSchema) {
        Map<String, Object> tool = new LinkedHashMap<>();
        tool.put("name", name);
        tool.put("description", description);
        tool.put("inputSchema", inputSchema);
        return tool;
    }

    static Map<String, Object> objectSchema(Map<String, Object> properties, List<Object> required) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("properties", properties);
        if (!required.isEmpty()) schema.put("required", required);
        return schema;
    }

    static Map<String, Object> props(Object... keyValuePairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValuePairs.length; i += 2) {
            map.put((String) keyValuePairs[i], keyValuePairs[i + 1]);
        }
        return map;
    }

    static Map<String, Object> prop(String type, String description) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("type", type);
        map.put("description", description);
        return map;
    }

    static Map<String, Object> propEnum(String type, String description, String... values) {
        Map<String, Object> map = prop(type, description);
        map.put("enum", list((Object[]) values));
        return map;
    }

    static List<Object> list(Object... items) {
        return new ArrayList<>(Arrays.asList(items));
    }

    static void writeResult(Object id, Map<String, Object> result) {
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("jsonrpc", "2.0");
        message.put("id", id);
        message.put("result", result);
        protocolOut.println(Json.write(message));
    }

    static void writeError(Object id, int code, String message, String data) {
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("code", code);
        error.put("message", message);
        if (data != null) error.put("data", data);

        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("jsonrpc", "2.0");
        envelope.put("id", id);
        envelope.put("error", error);
        protocolOut.println(Json.write(envelope));
    }

    static String str(Object value) {
        return value instanceof String ? (String) value : null;
    }

    static Double num(Object value) {
        return value instanceof Number ? ((Number) value).doubleValue() : null;
    }

    static Long lng(Object value) {
        return value instanceof Number ? ((Number) value).longValue() : null;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object value) {
        return (Map<String, Object>) value;
    }

    /** 极简 JSON 解析与序列化：只覆盖 JSON-RPC 报文用到的子集。 */
    static final class Json {

        private final String src;
        private int pos;

        private Json(String src) {
            this.src = src;
        }

        static Object parse(String src) {
            Json parser = new Json(src);
            parser.skipWhitespace();
            Object value = parser.value();
            parser.skipWhitespace();
            if (parser.pos != src.length()) {
                throw new IllegalArgumentException("JSON 尾部存在多余字符，位置 " + parser.pos);
            }
            return value;
        }

        private void skipWhitespace() {
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        private char peek() {
            if (pos >= src.length()) throw new IllegalArgumentException("JSON 意外结束");
            return src.charAt(pos);
        }

        private Object value() {
            char c = peek();
            switch (c) {
                case '{':
                    return object();
                case '[':
                    return array();
                case '"':
                    return string();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return number();
            }
        }

        private void expect(String literal) {
            if (!src.startsWith(literal, pos)) {
                throw new IllegalArgumentException("非法字面量，位置 " + pos);
            }
            pos += literal.length();
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++; // 跳过 {
            skipWhitespace();
            if (peek() == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWhitespace();
                if (peek() != '"') throw new IllegalArgumentException("对象键必须是字符串，位置 " + pos);
                String key = string();
                skipWhitespace();
                if (peek() != ':') throw new IllegalArgumentException("缺少冒号，位置 " + pos);
                pos++;
                skipWhitespace();
                map.put(key, value());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == '}') {
                    pos++;
                    return map;
                }
                throw new IllegalArgumentException("对象结构非法，位置 " + pos);
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            pos++; // 跳过 [
            skipWhitespace();
            if (peek() == ']') {
                pos++;
                return list;
            }
            while (true) {
                skipWhitespace();
                list.add(value());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == ']') {
                    pos++;
                    return list;
                }
                throw new IllegalArgumentException("数组结构非法，位置 " + pos);
            }
        }

        private String string() {
            pos++; // 跳过开引号
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (pos >= src.length()) throw new IllegalArgumentException("字符串没有闭合");
                char c = src.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char escaped = src.charAt(pos++);
                switch (escaped) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        sb.append((char) Integer.parseInt(src.substring(pos, pos + 4), 16));
                        pos += 4;
                        break;
                    default:
                        throw new IllegalArgumentException("非法转义 \\" + escaped);
                }
            }
        }

        private Object number() {
            int start = pos;
            boolean fractional = false;
            while (pos < src.length()) {
                char c = src.charAt(pos);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+') {
                    pos++;
                } else if (c == '.' || c == 'e' || c == 'E') {
                    fractional = true;
                    pos++;
                } else {
                    break;
                }
            }
            String raw = src.substring(start, pos);
            if (raw.isEmpty()) throw new IllegalArgumentException("非法数字，位置 " + start);
            if (fractional) return Double.valueOf(raw);
            return Long.valueOf(raw);
        }

        static String write(Object value) {
            StringBuilder sb = new StringBuilder();
            writeValue(sb, value);
            return sb.toString();
        }

        private static void writeValue(StringBuilder sb, Object value) {
            if (value == null) {
                sb.append("null");
                return;
            }
            if (value instanceof String) {
                writeString(sb, (String) value);
                return;
            }
            if (value instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    writeString(sb, String.valueOf(entry.getKey()));
                    sb.append(':');
                    writeValue(sb, entry.getValue());
                }
                sb.append('}');
                return;
            }
            if (value instanceof List) {
                sb.append('[');
                boolean first = true;
                for (Object item : (List<?>) value) {
                    if (!first) sb.append(',');
                    first = false;
                    writeValue(sb, item);
                }
                sb.append(']');
                return;
            }
            sb.append(value.toString());
        }

        private static void writeString(StringBuilder sb, String text) {
            sb.append('"');
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    case '\b': sb.append("\\b"); break;
                    case '\f': sb.append("\\f"); break;
                    default:
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            sb.append('"');
        }
    }
}
```

几个设计点值得单独解释，它们都不是风格问题，而是协议逼出来的：

**1. 两个流在入口就分开。** `protocolOut` 用 `FileDescriptor.out`、`logs` 用 `FileDescriptor.err`，而不是随手用 `System.out.println` 打日志。回头看一眼规范那条 MUST NOT 就明白为什么：`stdout` 一旦混进一行 `[server] started...`，客户端第一反应就是 JSON 解析失败，严格的客户端会直接断连。我用 stderr 打印启动信息、收到的通知名、每次 `tools/call` 的参数，这些在实测输出里都能看到，全部走的是 `[server:stderr]` 前缀。

**2. 换行必须在序列化时转义。** 工具的返回文本里带 `\n`（订单列表是多行文本）。手写实现时很容易直接把这段文本拼进 JSON，结果一行报文被折成多行，帧就断了。`Json.writeString` 里把 `\n`、`\r`、`\t` 和控制字符统一转义成 `\n`、`\r`、`\t`、`\u00xx`，报文始终保持单行——这是我在写工具返回文本时唯一特别注意的地方。

**3. 数字要区分整数和小数。** 解析时先扫字符，出现 `.`、`e`、`E` 就走 `Double`，否则走 `Long`。如果全按 `Double` 处理，请求里的 `"id":1` 回写时就变成 `"id":1.0`，按整数匹配 `id` 的客户端会对不上；现在分离后，`limit:5` 取到的也是整数 5，可以直接参与比较。

**4. 通知靠 `containsKey("id")` 判断，不看值。** `msg.get("id")` 在字段缺失和字段值为 `null` 时都返回 `null`，只有 `containsKey` 能区分「这是通知」和「这是 id 为 null 的请求」。

**5. 工具里的校验是「模型可修正」优先。** 路径越权、枚举值写错、参数类型不对，这些一律用 `isError=true` 返回给模型；只有「工具名不存在」「tools/call 缺 name」这类结构性问题才走 JSON-RPC 的 `error`。规范把 `invalid arguments` 列在协议错误一侧，我这里是**有意的偏离**：结构性错误模型改不了，参数取值错误模型下一轮就能改，用 `isError` 能把修正机会留回去。这个取舍需要团队内部统一，不能两套混着用。

运行方式就是 JDK 11 的单文件源码模式（JEP 330，JDK 11 起支持直接运行 `.java`）：

```powershell
java '-Dfile.encoding=UTF-8' McpServer.java
```

参数要加引号这件事我是踩出来的：PowerShell 里直接写 `-Dfile.encoding=UTF-8`，参数会被拆成 `-Dfile` 和 `.encoding=UTF-8` 两段，第二次运行直接抛 `ClassNotFoundException: /encoding=UTF-8`。原因在于 PowerShell 对原生命令参数的拆分规则，加一组引号就正常。

## 四、跑通：initialize → tools/list → tools/call 的真实报文

只有 Server 不够，验证「能不能被真客户端驱动」得自己写一个客户端。下面这份 `McpClient.java` 用 `ProcessBuilder` 把 Server 拉成子进程，用独立线程抽走 stderr，主线程按行收发报文，每一步都打印原始行：

```java
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * 极简 MCP 客户端：把 McpServer 作为子进程拉起，逐行收发 JSON-RPC 报文。
 * 运行：java -Dfile.encoding=UTF-8 McpClient.java
 */
public class McpClient {

    static PrintStream out;

    public static void main(String[] args) throws Exception {
        out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");

        // 客户端自己拉起 server 子进程，这是 stdio 传输的典型形态
        ProcessBuilder builder = new ProcessBuilder("java", "-Dfile.encoding=UTF-8", "McpServer.java");
        builder.directory(new File(System.getProperty("user.dir")));
        Process server = builder.start();

        // 子进程的 stderr 是日志通道，单独用一个线程抽出来
        Thread stderrPump = new Thread(() -> {
            try (BufferedReader err = new BufferedReader(
                    new InputStreamReader(server.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = err.readLine()) != null) out.println("[server:stderr] " + line);
            } catch (IOException ignored) {
            }
        });
        stderrPump.setDaemon(true);
        stderrPump.start();

        BufferedWriter toServer = new BufferedWriter(
                new OutputStreamWriter(server.getOutputStream(), StandardCharsets.UTF_8));
        BufferedReader fromServer = new BufferedReader(
                new InputStreamReader(server.getInputStream(), StandardCharsets.UTF_8));

        out.println("===== 第 1 步：initialize 握手 =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":"
                + "{\"protocolVersion\":\"2025-06-18\","
                + "\"capabilities\":{\"roots\":{\"listChanged\":true}},"
                + "\"clientInfo\":{\"name\":\"mini-client\",\"version\":\"0.1\"}}}");
        receive(fromServer);

        out.println("===== 第 2 步：initialized 通知（无应答） =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");

        out.println("===== 第 3 步：tools/list =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}");
        receive(fromServer);

        out.println("===== 第 4 步：tools/call read_file_meta（白名单内，正常） =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":"
                + "{\"name\":\"read_file_meta\",\"arguments\":{\"path\":\"notes.txt\"}}}");
        receive(fromServer);

        out.println("===== 第 5 步：tools/call query_orders（业务查询） =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":"
                + "{\"name\":\"query_orders\",\"arguments\":{\"status\":\"PAID\",\"minAmount\":100}}}");
        receive(fromServer);

        out.println("===== 第 6 步：tools/call read_file_meta（越权路径，工具执行错误） =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":"
                + "{\"name\":\"read_file_meta\",\"arguments\":{\"path\":\"../secret.txt\"}}}");
        receive(fromServer);

        out.println("===== 第 7 步：tools/call 未知工具（协议错误） =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":"
                + "{\"name\":\"read_file\",\"arguments\":{\"path\":\"notes.txt\"}}}");
        receive(fromServer);

        out.println("===== 第 8 步：调用未声明的方法（协议错误） =====");
        send(toServer, "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"resources/list\",\"params\":{}}");
        receive(fromServer);

        out.println("===== 第 9 步：关闭 stdin，server 应自行退出 =====");
        toServer.close();
        boolean exited = server.waitFor(5, TimeUnit.SECONDS);
        out.println("server 进程已退出=" + exited + "，exit code=" + server.exitValue());
    }

    static void send(BufferedWriter toServer, String payload) throws IOException {
        out.println("client -> " + payload);
        toServer.write(payload);
        toServer.newLine();
        toServer.flush();
    }

    static void receive(BufferedReader fromServer) throws IOException {
        out.println("server -> " + fromServer.readLine());
    }
}
```

客户端总共发了 8 条请求/通知：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`(白名单内) → `tools/call`(订单查询) → `tools/call`(越权路径) → `tools/call`(未知工具) → `resources/list`(未声明方法)，最后关闭进程的 stdin 触发优雅退出。在 `D:\temp\mcp-server-java\` 下运行：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
java '-Dfile.encoding=UTF-8' McpClient.java | Out-File -FilePath out.txt -Encoding utf8
```

下面是 `out.txt` 的完整内容，一行没删（`[server:stderr]` 是日志通道，其余是协议报文）：

```text
===== 第 1 步：initialize 握手 =====
client -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{"listChanged":true}},"clientInfo":{"name":"mini-client","version":"0.1"}}}
[server:stderr] [server] started, protocol=2025-06-18, data_root=D:\temp\mcp-server-java\data
[server:stderr] [server] initialize from {"name":"mini-client","version":"0.1"}, requested protocol=2025-06-18
server -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"mini-mcp-server","version":"0.1.0"},"instructions":"本 Server 只声明 tools 能力；read_file_meta 的 path 必须位于 data/ 目录内。"}}
===== 第 2 步：initialized 通知（无应答） =====
client -> {"jsonrpc":"2.0","method":"notifications/initialized"}
===== 第 3 步：tools/list =====
client -> {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
[server:stderr] [server] notification notifications/initialized（通知不回应答）
server -> {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"read_file_meta","description":"读取 data/ 目录内某个文件的元信息：字节大小、最后修改时间、是否为目录。只返回元信息，不返回文件内容。","inputSchema":{"type":"object","properties":{"path":{"type":"string","description":"相对 data/ 目录的文件路径，例如 notes.txt；不能使用 .. 或绝对路径"}},"required":["path"]}},{"name":"query_orders","description":"查询内存中的订单表。可按订单状态和最低金额过滤，返回订单号、状态、金额、下单时间，以及命中订单的金额合计。","inputSchema":{"type":"object","properties":{"status":{"type":"string","description":"按订单状态过滤，取值必须来自枚举","enum":["PAID","SHIPPED","REFUNDED","CREATED"]},"minAmount":{"type":"number","description":"只返回金额大于等于该值的订单"},"limit":{"type":"integer","description":"最多返回几条，1 到 20，默认 5"}}}}]}}
===== 第 4 步：tools/call read_file_meta（白名单内，正常） =====
client -> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file_meta","arguments":{"path":"notes.txt"}}}
[server:stderr] [server] tools/call name=read_file_meta arguments={"path":"notes.txt"}
server -> {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"path=notes.txt\nsize_bytes=156\nlast_modified=2026-10-19T06:41:48.330934Z\nis_directory=false"}],"isError":false}}
===== 第 5 步：tools/call query_orders（业务查询） =====
client -> {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"query_orders","arguments":{"status":"PAID","minAmount":100}}}
[server:stderr] [server] tools/call name=query_orders arguments={"status":"PAID","minAmount":100}
server -> {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"命中 2 条，展示前 2 条：\n- SO20261019002 | PAID | CNY 3580.50 | 2026-10-19T10:03:07\n- SO20261019001 | PAID | CNY 199.00 | 2026-10-19T09:12:31\n命中订单金额合计：CNY 3779.50"}],"isError":false}}
===== 第 6 步：tools/call read_file_meta（越权路径，工具执行错误） =====
client -> {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_file_meta","arguments":{"path":"../secret.txt"}}}
[server:stderr] [server] tools/call name=read_file_meta arguments={"path":"../secret.txt"}
server -> {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"权限拒绝：path 必须位于 data/ 目录内，收到 ../secret.txt"}],"isError":true}}
===== 第 7 步：tools/call 未知工具（协议错误） =====
client -> {"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"notes.txt"}}}
[server:stderr] [server] tools/call name=read_file arguments={"path":"notes.txt"}
server -> {"jsonrpc":"2.0","id":6,"error":{"code":-32602,"message":"Unknown tool: read_file"}}
===== 第 8 步：调用未声明的方法（协议错误） =====
client -> {"jsonrpc":"2.0","id":7,"method":"resources/list","params":{}}
server -> {"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found: resources/list"}}
===== 第 9 步：关闭 stdin，server 应自行退出 =====
[server:stderr] [server] stdin EOF, exit
server 进程已退出=true，exit code=0
```

逐段看几个关键点。

第 1 步的应答里，`protocolVersion` 原样返回了客户端请求的版本，这是规范要求的行为；`capabilities` 里只有 `tools`，意味着后面客户端调 `resources/list` 就是越界调用。`instructions` 是可选字段，我把「路径限制在 data/」写进去，客户端可以把它拼进系统提示。

第 2 步是通知，没有 `id`，所以 Server 只往 stderr 记了一行就不作声。把这份输出和第 3 步的应答位置对照着看：`notification` 那行出现在 `tools/list` 请求之后，只是因为父子进程两个流各自缓冲、顺序不保证，并不代表 Server 回了应答——`server ->` 那一行永远是延迟到第 3 步的请求应答。

第 3 步的 `tools/list` 是全文最值得细读的一行。两个工具的 `description` 和 `inputSchema` 会被客户端翻译成模型的工具定义，也就是说**模型能看到的工具说明书只有这一份字段**。`query_orders` 的 `status` 我特意写了 `enum`，把四个合法值直接告诉模型，而不是等它传错了再报错。

第 4 步和第 5 步是正常调用：`content[0].text` 里是我拼好的多行文本，注意报文本身仍是单行——`\n` 是转义后的字面量。第 5 步返回的 `isError:false` 是显式的，没有省略。

第 6 步是工具执行错误：越权路径没有让 Server 抛异常，而是 `isError:true` + 一段能读懂的中文原因。这条错误会被客户端作为 tool result 喂回模型，模型有机会换成合法路径重试。第 7 步是协议错误：工具名不存在属于结构性错误，模型改不了，所以走 `-32602`，客户端拿到后通常直接中断这轮循环。

第 8 步验证了能力声明的约束力：`resources/list` 是规范里存在的方法，但这个 Server 只声明了 `tools`，于是回 `-32601 Method not found`。第 9 步是我对规范里 stdio 关闭流程的实现：客户端关闭子进程 stdin，Server 读到 EOF 后退出，`exit code=0`。规范也说明这只是 SHOULD 级别，客户端不强杀进程而是先关输入流（[Lifecycle: Shutdown](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#shutdown)）。

## 五、补两个实验：版本协商与坏参数

第一个问题是版本协商到底有没有用。我用同一个客户端脚手架换成 `protocolVersion: "2026-07-28"`（也就是 modern 时代的版本号）再跑一次：

```text
----- A：客户端请求 2026-07-28，看版本协商 -----
client -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"mini-client","version":"0.1"}}}
[server:stderr] [server] initialize from {"name":"mini-client","version":"0.1"}, requested protocol=2026-07-28
[server:stderr] [server] 客户端请求 2026-07-28，本 Server 只支持 2025-06-18，按规范回退为 2025-06-18
server -> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"mini-mcp-server","version":"0.1.0"},"instructions":"本 Server 只声明 tools 能力；read_file_meta 的 path 必须位于 data/ 目录内。"}}
```

Server 没有报错，也没有假装支持，而是按规范回了自己支持的版本。真实客户端此时的正确反应是：如果它认识 `2025-06-18` 就继续用，不认识就断开并提示用户。

第二个问题值得警惕：模型给的参数经常对不上 schema。我构造了两种典型情况，还有一行被污染的非 JSON 输入：

```text
----- B：query_orders 传了枚举以外的值 -----
client -> {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"query_orders","arguments":{"status":"paid"}}}
server -> {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"参数错误：status 只能取 [PAID, SHIPPED, REFUNDED, CREATED]，收到 paid"}],"isError":true}}
----- C：read_file_meta 完全不传参数 -----
client -> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_file_meta"}}
server -> {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"参数错误：path 必填，且必须是字符串。"}],"isError":true}}
----- D：stdin 上混入一行非 JSON -----
client -> this is not json
[server:stderr] [server] parse error: 非法字面量，位置 0
server -> {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error","data":"非法字面量，位置 0"}}
```

B 里模型把状态写成小写 `paid`——真实模型很容易这么干。错误信息里我把合法取值原样列出来，模型下一轮照抄就能改对。C 是请求里根本没给 `arguments` 字段（Server 侧落到空对象），我按 `isError` 返回而不是让 `NullPointerException` 崩掉整条连接。D 是最严重的一种：客户端污染了协议流，Server 无法确定 `id`，只能按 JSON-RPC 规范回一个 `id:null` 的 `-32700 Parse error`，把 `data` 里带上具体位置，便于对端排查。

本文用到的错误码都来自 JSON-RPC 2.0 规范与 MCP 的工具错误约定：

| 错误码 | 含义 | 本文触发场景 |
| --- | --- | --- |
| -32700 | Parse error（解析失败） | stdin 上出现非 JSON 行 |
| -32600 | Invalid Request | 报文不是 JSON 对象、缺 `method` |
| -32601 | Method not found | 调用未声明的方法，如 `resources/list` |
| -32602 | Invalid params | 未知工具名、`tools/call` 缺 `name` |
| -32603 | Internal error | Server 内部未捕获异常 |

## 六、接进真实 Agent：它怎么被加载，和 Function Calling 怎么分工

要让支持 MCP 的客户端加载这个 Server，需要提供的是**一条启动命令**，而不是一个网络地址：客户端按配置在本地启动子进程（通常是 `java -Dfile.encoding=UTF-8 McpServer.java`，工作目录设为 `D:\temp\mcp-server-java\`），然后按行读写它的 stdin/stdout。不同客户端的配置文件位置和字段名各不相同，具体格式我在本机没有验证（**未确认**），但无论哪个客户端，协议层要做的事都是本文第 4 步的那几条消息。

加载之后，应用侧的循环是这样的：

```text
1. client 发 initialize → 拿到 server 声明的能力与 protocolVersion
2. client 发 notifications/initialized
3. client 发 tools/list → 得到工具清单
4. client 把每个工具的 name/description/inputSchema 翻译成模型的工具定义
5. 模型返回 tool_calls → client 翻译成 tools/call 发给 server
6. server 返回 content → client 把它作为工具结果写回模型上下文
7. 模型给出最终回答或下一轮 tool_calls
```

和「直接在应用里写 Function Calling」相比，差别不在模型侧，而在工具的**定义位置与执行位置**：

| 方案 | 工具定义写在哪 | 工具在哪执行 | 新增一个工具的代价 |
| --- | --- | --- | --- |
| 应用内 Function Calling | 应用代码里的 schema | 应用进程 | 改应用代码并重新发布 |
| MCP Server | Server 的 `tools/list` | Server 进程 | 改 Server，应用侧零改动 |

代价是链路变长了：多一个进程、多一层协议。所以调试时要从两端同时看——Server 侧的 stderr 日志、客户端侧的原始报文，和本文第四节的输出形态一致。反过来，它的收益也真实：公司内部系统只要按 MCP 实现一次 Server，所有支持 MCP 的客户端都能接，不必为每个应用重写一遍工具定义。

## 七、生产化要点：日志、错误、超时、校验

**日志只走 stderr。** 这不是风格选择，规范写得很清楚：stdout 上只能出现合法 MCP 消息。我的实现从 `FileDescriptor.out` 和 `FileDescriptor.err` 分流，避免了「随手 `System.out.println` 一行调试信息导致客户端 JSON 解析失败」这类事故。

**错误分两层，且要在团队内统一。** 协议错误走 `error` 字段，工具执行错误走 `result` + `isError:true`。规范把 `unknown tools` 和 `invalid arguments` 一起列在协议错误里；我把「参数取值错误」划到了 `isError` 一侧，因为这类错误模型能自己修。这个判断有主观成分，一旦定下来就要在代码里一致执行，最怕的是一半接口用 `error`、一半用 `isError`，客户端维护两套解析逻辑。

**超时与取消要预留。** 规范要求实现为所有发出的请求设置超时，超时后发取消通知而不是无限等（[Lifecycle: Timeouts](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#timeouts)）；2026-07-28 的 stdio 传输页里取消通知的报文名是 `notifications/cancelled`。**本文的 Server 是单线程串行处理，没有实现取消处理**（未实现）：工具都是毫秒级的内存操作，取消没有意义；一旦接上数据库、网络类的耗时工具，就必须把工具执行放到独立线程，并在收到取消通知后中断长任务。

**输入校验放在 Server 侧。** 我的 `read_file_meta` 做了三层：`normalize()` 后比前缀（挡 `..` 穿越）、`toRealPath()` 后再比一次前缀（挡符号链接）、目录不存在直接返回可读的错误。这里保留的是路径维度的最小校验；授权、scope、人工确认的完整设计见本专栏的 MCP 安全边界那篇。

**工具描述与 schema 要写成给模型看的样子。** 三个经验：`description` 里把边界用自然语言说清楚（我在 `read_file_meta` 的描述里直接写了「只返回元信息，不返回文件内容」）；能用 `enum`、`required`、数值范围表达的约束全部写进 `inputSchema`，别指望模型自己记住；工具宁可拆小，一个工具干一件事，校验逻辑才写得清楚。

**并发模型要提前想。** stdio 是单条双向流，所以「一个连接内串行、每个连接一个 Server 进程」是最省心的实现，也是我这里的做法。要让同一个 Server 服务多个客户端，就得考虑 Streamable HTTP 传输，那是另一套连接与鉴权模型，本文没有覆盖（未验证）。

## 八、常见坑：五个真实踩到的问题

**1. 把日志打到 stdout，协议流被污染。** 这是最经典的错误。症状不是 Server 报错，而是客户端解析第一条「报文」就失败。判断方法很简单：把 Server 的 stdout 原样抓下来，只要有一行不是合法 JSON，就是这条。

**2. schema 和模型给的参数对不上。** 模型可能把小写状态传进枚举、把 `"100"` 当成字符串传进 `number`、把该传 `path` 的地方传成 `file`。对策是双管齐下：schema 里约束能表达的尽量表达，Server 里对类型和取值做二次检查，并把合法取值写进错误信息。

**3. 忘记返回 `content` 结构。** 规范要求 `tools/call` 的结果是 `{"content":[{"type":"text","text":"..."}],"isError":false}`。直接返回一个字符串或者 `{"result":"..."}`，客户端拿不到 `content[].text`，模型就看不到工具结果——现象是「工具明明执行了，模型却说没有拿到数据」。我第一版就是这么写的，因为本地测试只看 Server 侧日志，看不到客户端消费端的行为。

**4. Windows 下把 JVM 参数直接写进 PowerShell。** `java -Dfile.encoding=UTF-8 McpServer.java` 会被拆成两个参数，报 `ClassNotFoundException: /encoding=UTF-8`。加引号写成 `java '-Dfile.encoding=UTF-8' McpServer.java` 即可。

**5. 中文乱码，误以为是协议问题。** Windows 下 JDK 11 的默认字符集不一定是 UTF-8，日志重定向到文件后很容易读到乱码，看起来像「报文坏了」。我的处理是在 Server 和 Client 两端都显式用 UTF-8 构造 `PrintStream`，并在 PowerShell 里把输出编码统一成 UTF-8 再重定向，这样文件里读到的就是干净的中文。

## 九、面试视角怎么答

如果面试被问到「你怎么理解 MCP」，按下面的层次回答会比背概念稳：

被问「MCP 和 Function Calling 什么关系」时，先说位置：Function Calling 是模型能力，发生在模型和应用之间；MCP 是应用与工具进程之间的协议。再接一句「模型输出 tool_calls，应用作为 client 把它翻译成 `tools/call`，Server 执行并返回 `content`」把接力讲完。

被问「为什么错误要分两层」时，答「结构性错误模型改不了，走 JSON-RPC error；可修正的参数错误走 `result` + `isError:true`，让模型看得到原因」，再补一句「我用的是一个有意偏离规范分类的取舍，团队要统一」。

被问「stdio 和 HTTP 怎么选」时，答「本地工具、单机、进程级隔离用 stdio 最省事，代价是一个连接一个进程；远程多客户端、需要鉴权就上 Streamable HTTP」，并说明后者的授权链路是另一层设计。

被问「有什么是你踩过的坑」时，`content` 结构、stdout 污染、Windows JVM 参数这三条任选一条讲清现象和定位方法，比背规范条目更有说服力。

## 小结

- MCP 的 stdio 传输就是「一行一条 JSON-RPC 2.0 报文」，最小可用面是 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`，不依赖任何 SDK 也能实现。
- 实现 Server 的三个硬约束：stdout 只放协议报文（日志走 stderr）、报文必须单行（序列化时转义换行）、通知不回应答（按 `id` 是否存在判断）。
- 能力声明是有约束力的：只声明 `tools`，调 `resources/list` 就会拿到 `-32601`；版本对不上时按规范回退到自己支持的版本。
- 错误分两层，`isError` 是留给模型自我修正的通道；参数校验必须在 Server 侧做，不能指望模型自觉。
- 别忘了 MCP 已经在演进：`2026-07-28` 之后不再有 `initialize` 握手，版本与能力改为随每个请求放在 `_meta` 里，新实现要面对 modern 与 legacy 并存的局面。

如果要继续往下走，我建议的顺序是：先按本文的手写实现跑通一遍，再把同一个 Server 用官方 SDK 重写一次做对照——两版报文一致，说明你真正理解了协议；再考虑给它加上真实的服务端数据源和耗时任务的取消支持。

## 参考资料

- [MCP Specification 2025-06-18: Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [MCP Specification 2025-06-18: Transports（stdio）](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)
- [MCP Specification 2025-06-18: Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Specification 2025-06-18: Ping](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/ping)
- [MCP Specification 2026-07-28: Versioning and Compatibility（modern / legacy）](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP Specification 2026-07-28: stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)
- [JEP 330: Launch Single-File Source-Code Programs](https://openjdk.org/jeps/330)
