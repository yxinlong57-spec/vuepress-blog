---
title: "Function Calling 参数为什么校验失败：从 Schema、类型到错误信息的完整排查"
shortTitle: "Function Calling 参数校验"
date: 2026-10-13
category:
  - Agent
tag:
  - Function Calling
  - 参数校验
  - AI Agent
order: 9
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK 单文件实验，无第三方依赖
> 说明：实验中的 JSON 解析器是只支持平铺对象的教学实现，用于把校验逻辑摊开；真实项目用 Jackson 或 Gson 解析，用 JSON Schema 库（如 everit-json-schema、networknt json-schema-validator）做校验。校验链的分层结论与具体库无关。

**目录**

- 问题现象：模型"按格式返回了"，工具却拒绝执行
- 先分清校验发生在哪一层
- 实测：七类典型失败 payload
- 错误信息怎么写，模型才能自我修正
- Schema 设计的六个预防点
- 小结

## 问题现象：模型"按格式返回了"，工具却拒绝执行

接 Function Calling 时，几乎每个开发者都会撞上这一类报错：模型明明返回了 `tool_calls`，`arguments` 看起来也是 JSON，但服务端一执行就失败——要么反序列化类型对不上，要么业务逻辑拿到一个没法用的值。

先给结论，排查顺序和文章结构都按这个来：

1. **模型不保证遵守 Schema。** 主流厂商文档都写明了这一点：schema 是"强烈提示"，不是约束。校验必须发生在你的服务端，而不是寄希望于模型自觉。
2. **失败发生在不同层，处理方式完全不同。** 解析层失败（不是合法 JSON）、schema 层失败（缺字段、类型错、枚举错）、业务层失败（值合法但语义不成立），三者的修复路径不一样。
3. **校验错误不应该直接抛给用户。** 把结构化错误喂回模型，让它自我修正，一轮之内大概率能修好——这个结论我后面用实验验证。

## 先分清校验发生在哪一层

一次工具调用的参数从模型到执行，要经过四道关口：

```text
模型生成文本
  → 第 1 层：JSON 解析（arguments 是字符串，必须先解析成对象）
  → 第 2 层：Schema 校验（必填、类型、枚举、范围、多余字段）
  → 第 3 层：业务校验（日期不能是过去、城市必须在服务范围）
  → 工具执行
```

排查时最常见的错误，是把所有失败混为一谈。第 1 层失败说明模型的输出根本没按协议走（提示词或模型能力问题）；第 2 层失败说明 schema 和模型理解有偏差（schema 设计问题）；第 3 层失败则是工具自身的领域规则。三层的信息要分别记录，否则会反复在错误的地方改提示词。

我用一个 `get_weather` 工具做实验，schema 定义如下：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `city` | string | 是 | 无 |
| `days` | integer | 否 | 1 至 7 |
| `unit` | string | 否 | 枚举：`celsius` / `fahrenheit` |
| （其他字段） | — | — | 不允许，additionalProperties=false |

## 实测：七类典型失败 payload

我写了一个纯 JDK 的校验器（约 150 行，核心逻辑见下文），对 7 个 payload 逐一执行校验链。以下是本机实测输出：

```text
===== 逐个排查：7 个 payload 的校验结果 =====
--- P1: {"city": "北京", "days": 3, "unit": "celsius"}
校验通过
--- P2: {"city": "北京", "days": "3"}
校验失败: [字段 [days] 类型错误：期望 integer，实际 string，收到值 3]
--- P3: {"days": 3}
校验失败: [缺少必填字段 [city]，类型应为 string]
--- P4: {"city": "北京", "unit": "摄氏"}
校验失败: [字段 [unit] 取值 摄氏 不在枚举 [celsius, fahrenheit] 中]
--- P5: {"city": "北京", "format": "json"}
校验失败: [字段 [format] 不在工具 get_weather 的参数列表中，请移除]
--- P6: {"city": "北京", "days": 10}
校验失败: [字段 [days] 不能大于 7，收到 10]
--- P7: 北京未来3天天气
解析层失败: arguments 不是 JSON 对象: 北京未来3天天气
```

逐个分析，这七类正好覆盖真实项目里最常见的失败模式：

- **P2 类型错误：`"days": "3"`。** 这是最高发的一类。模型对"数字"和"数字字符串"的区分不稳定，尤其在中文提示词里。注意我的校验器选择了**拒绝而不是默默转型**——`"3"` 转 `3` 看起来方便，但 `"3.5"`、`"三"` 转不转？容忍边界一旦模糊，错误会在更下游爆炸。严格的类型检查把问题暴露在调用现场。
- **P3 缺必填字段。** 模型"忘"了 `city`，通常是因为用户输入里城市信息不明确，模型选择跳过而不是追问。schema 层面无解，要靠错误信息引导模型下一轮补上或向用户追问。
- **P4 枚举值漂移。** 用户说"摄氏度"，模型就填了 `摄氏`。枚举约束写得越短越标准（`celsius` 而不是 `摄氏度`），模型越容易命中；反过来，把枚举值设计成自然语言词，等于邀请模型自由发挥。
- **P5 schema 外字段。** 模型"好心"加了 `format` 字段。`additionalProperties: false` 能拦住它——如果不拦，这个字段被静默忽略，模型会以为它生效了，后续行为更难预测。
- **P6 超出取值范围。** 用户说"未来十天"，模型如实填了 10，但工具只支持 7 天。这类错误的正确处理不是让模型硬猜，而是错误信息里带上边界值，让模型决定是截断还是告知用户。
- **P7 解析层失败。** 模型直接输出了自然语言。这在开启 `tool_choice: required` 后很少见，但在流式输出截断、超长参数、小模型上是真实存在的。它属于第 1 层，不该进入 schema 校验。

核心校验逻辑如下（解析器从略，关键是错误信息的组织方式）：

```java
static List<String> validate(ToolSchema schema, Map<String, Object> args) {
    List<String> errors = new ArrayList<>();

    // 未知字段
    if (!schema.allowAdditional) {
        Set<String> known = new HashSet<>();
        for (Field f : schema.fields) known.add(f.name);
        for (String key : args.keySet()) {
            if (!known.contains(key)) {
                errors.add("字段 [" + key + "] 不在工具 " + schema.name
                        + " 的参数列表中，请移除");
            }
        }
    }

    for (Field f : schema.fields) {
        Object v = args.get(f.name);
        if (v == null) {
            if (f.required) errors.add("缺少必填字段 [" + f.name + "]，类型应为 " + f.type);
            continue;
        }
        // 类型检查：integer 不接受字符串 "3"，number 接受 integer（JSON 的合理放宽）
        String actual = v instanceof String ? "string"
                : v instanceof Boolean ? "boolean"
                : (v instanceof Long) ? "integer" : "number";
        boolean typeOk = f.type.equals(actual)
                || (f.type.equals("number") && actual.equals("integer"));
        if (!typeOk) {
            errors.add("字段 [" + f.name + "] 类型错误：期望 " + f.type
                    + "，实际 " + actual + "，收到值 " + v);
            continue;
        }
        // 枚举与范围
        if (f.enumValues != null && !f.enumValues.isEmpty()
                && !f.enumValues.contains(String.valueOf(v))) {
            errors.add("字段 [" + f.name + "] 取值 " + v + " 不在枚举 " + f.enumValues + " 中");
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (f.min != null && d < f.min) errors.add("字段 [" + f.name + "] 不能小于 " + f.min + "，收到 " + v);
            if (f.max != null && d > f.max) errors.add("字段 [" + f.name + "] 不能大于 " + f.max + "，收到 " + v);
        }
    }
    return errors;
}
```

注意错误信息的四个要素全部保留：**哪个字段、期望什么、实际收到什么、合法取值是什么**。这不是写给最终用户看的，是写给模型看的——下一节验证它的作用。

## 错误信息怎么写，模型才能自我修正

校验失败后最差的处理是抛一个 `400 Bad Request` 给调用方，然后结束。更好的做法是把结构化错误作为工具的执行结果喂回模型，让它在下一轮修正参数重试。关键问题是：错误信息写到什么程度，模型才修得动？

我做了个实验：MockLLM 第一轮返回一个集三种错误于一身的 payload（`days` 是字符串、`unit` 用中文、多传 `format` 字段），校验器把错误列表完整喂回，第二轮看模型能否修正。实测：

```text
===== 自我修正实验：校验错误喂回模型 =====
[round 1] 模型返回 arguments: {"days": "3", "unit": "摄氏", "city": "北京", "format": "json"}
[round 1] 校验失败，错误将喂回模型: [字段 [format] 不在工具 get_weather 的参数列表中，请移除, 字段 [days] 类型错误：期望 integer，实际 string，收到值 3, 字段 [unit] 取值 摄氏 不在枚举 [celsius, fahrenheit] 中]
[round 2] 模型返回 arguments: {"city": "北京", "days": 3, "unit": "celsius"}
[round 2] 校验通过，执行工具
[round 2] get_weather(city=北京, days=3, unit=celsius)
模型总调用次数: 2
```

一轮修正到位。这个 Mock 是确定性的，但它演示的机制在真实模型上成立的前提是错误信息满足三个条件：

1. **定位到字段。** "参数错误"没法修，"字段 [days] 类型错误"可以修。
2. **给出合法值。** 枚举错误带上完整枚举列表，范围错误带上上下界。模型不知道你的边界，只能靠你告诉它。
3. **一次返回全部错误。** 如果每轮只报第一个错，模型修一个冒一个，重试次数线性上涨。我的校验器收集了所有错误一次性返回，round 2 才能一次通过。

需要配套一个重试上限（比如 3 次），否则模型在某些系统性错位上会无限重试——这和上一篇 Agent 循环里的错误熔断是同一个设计思想。

## Schema 设计的六个预防点

排查到最后你会发现，大部分参数校验失败可以在 schema 设计阶段预防：

1. **枚举值用机器友好的短词。** `celsius` 优于 `摄氏度`；如果必须支持中文枚举，同时在校验层做归一化映射，并把映射规则写进字段描述。
2. **字段描述里写示例。** `"city": "城市名，如 北京"` 比 `"city": "城市"` 的出错率低一个量级，尤其对小模型。
3. **能不嵌套就不嵌套。** 嵌套层级越深，模型生成正确结构的概率越低。扁平的 5 个字段通常优于嵌套的 3 层对象。
4. **必填字段尽量少。** 每个必填字段都是模型的一次失败机会。可选字段给默认值，比强制模型生成更稳。
5. **范围约束写进 schema 而不是只在代码里检查。** `days: 1-7` 如果只在校验代码里限制，模型要到报错才知道边界；写进 schema 的 `minimum/maximum`，部分厂商会把它纳入模型的生成约束。
6. **服务端永远再校验一遍。** schema 给模型的只是提示，第 2 层的校验逻辑不可省略。这一条是底线。

## 小结

- 模型不保证遵守 schema，服务端校验是必选项，问题只在于校验发生在哪一层、错误信息怎么组织。
- 按"解析层 → schema 层 → 业务层"分层排查，不要在解析层失败时改 schema，也不要在 schema 层失败时改提示词硬赌。
- 错误信息写给模型看：定位字段、给出合法值、一次报全；配上重试上限，大部分参数错误能在一两轮内自我修正。
- 最好的排查是不需要排查：枚举短词、字段示例、扁平结构、少必填、范围进 schema，能在设计阶段消掉一大半失败。
