---
title: "Agent 的记忆工程：上下文窗口、短期会话和长期记忆到底怎么分工"
description: "上下文窗口、短期会话和长期记忆到底怎么分工：Agent 记忆工程的分层设计。"
shortTitle: "Agent 记忆工程"
date: 2026-10-05
category:
  - Agent
tag:
  - AI Agent
  - 记忆
  - 上下文窗口
order: 10
---


> 资料与实验说明：LangChain/LangGraph OSS 文档以 2026-10-05 可访问内容为准；Java 示例使用 Windows 11、Oracle JDK 17.0.12 和 JDK 标准库运行。示例只模拟状态边界，不替代框架的 checkpoint 或 store 实现。

**目录**

- 上下文窗口不是记忆系统
- 短期记忆为什么必须绑定 thread
- 长期记忆为什么会跨会话
- 语义、经历和规则不是同一种记忆
- 写入、检索和删除分别难在哪里
- 用 Java 小模型验证 thread 与用户隔离
- Java 后端应该怎么映射这套状态
- 测评记忆系统时不能只看回答
- 参考资料

## 上下文窗口不是记忆系统

多轮对话里最常见的“失忆”现象是这样的：用户上一轮说自己在维护订单服务，下一轮换了一个 API 请求，服务端没有把上一轮的消息放进模型输入，回答就回到了通用状态。上下文窗口变大以后，单次请求确实能装入更多历史，但窗口仍然是本次推理的工作区。它不会自动跨 session 保存，不会区分两个用户，也不会因为某条事实过期就删除它。

长上下文还会带来另一组问题。历史越多，输入 token 越贵，首 token 延迟越高；旧版本的需求、已经撤销的指令和过期数据会和新信息一起进入模型，增加干扰。把整个会话一直塞进 prompt，只适合很短的交互和明确的验证场景，不能代替数据分层。

我倾向于先把 Agent 记忆拆成四层，再决定用什么数据库：

| 层 | 保存什么 | 生命周期 |
| --- | --- | --- |
| 模型上下文 | 当前请求真正看到的 messages、工具结果和系统提示 | 一次请求或一次运行 |
| thread 短期状态 | 当前会话的消息、步骤状态、待审批动作和中间结果 | 一个 thread/session |
| 长期记忆 | 跨 session 复用的事实、偏好、经历和规则 | 由业务和隐私策略决定 |
| 治理与检索 | namespace、权限、TTL、更新、删除、召回和评测 | 跟随整条数据生命周期 |

先判断数据属于哪一层，比先给所有内容建向量索引更重要。向量库只是检索工具，不能替应用回答“这条信息属于谁、什么时候写入、什么时候失效”。

## 短期记忆为什么必须绑定 thread

短期记忆的作用域通常是 thread 或 session。它保存的是当前会话继续运行所需的消息历史和状态，而不是全局事实。LangGraph 把短期记忆放进 agent state，再通过 checkpointer 持久化。

checkpointer 会在每个 super-step 保存状态快照。这样图运行中断后可以从最近的检查点恢复，也能支持人工审批、故障恢复和查看过去状态。`thread_id` 是 checkpoint 检索的重要键。没有稳定的 thread 标识，系统很难判断一次恢复应该接到哪条会话上。

这里有一个容易忽略的工程问题：`thread_id` 能定位会话，不能单独承担身份隔离。如果客户端的请求里可以随便传 `thread_id`，或者查询时只按 thread 查而不带租户和用户条件，A 用户就有可能恢复 B 用户的上下文。服务端应该从已认证主体推导 `tenant_id` 和 `user_id`，再把它们作为存储键和授权条件的一部分。

短期记忆还需要压缩策略。历史太长时，可以裁剪、摘要，或者把稳定事实转存到长期记忆，再删除原消息。摘要不是无损复制，必须保留来源、版本和更新时间，后续出现冲突时才有依据判断哪条信息更新。`InMemorySaver` 这类内存实现适合本地测试，进程重启或水平扩容后无法保证状态，不能作为生产持久化方案。

## 长期记忆为什么会跨会话

长期记忆跨 session 和 thread 共享，用来保存下一次交互仍然需要的事实、偏好和经历。LangGraph Store 把长期记忆保存为 JSON 文档，用 namespace 组织层级，用 key 定位具体文档。namespace 往往包含用户或组织 ID，例如：

```text
tenant-a / user-1 / profile / language
tenant-a / user-1 / profile / answer_style
tenant-a / user-1 / project-42 / preference
```

namespace 设计会直接影响权限和删除。把租户、用户和应用类型放进 namespace，查询时才有稳定的过滤边界；只在文档内容里写一个 `userId` 字段，容易在检索阶段漏掉隔离条件。

长期记忆常见的两种形态是 profile 和 collection。

profile 通常是一份持续更新的 JSON 风格画像，适合语言偏好、常用技术栈、稳定的工作习惯这类事实。读取简单，但并发写入时要做版本控制，否则两个请求可能互相覆盖。

collection 保存多条独立文档或事实记录，召回率通常更高，适合经历、历史决策和项目笔记。它也要处理重复、冲突、更新和删除。文档越多，检索结果越依赖过滤、重排和时间权重。

长期记忆的召回范围和 RAG 有交集，但不能画等号。RAG 更强调从知识库检索相关内容并放进当前上下文；长期记忆还要负责什么时候写入、写入谁的 namespace、如何更新旧事实、用户删除请求怎样传播到所有副本。向量检索只是其中一个检索步骤。

写入时机也有取舍：

| 方式 | 优点 | 代价 |
| --- | --- | --- |
| Hot path 主链路写入 | 新事实即时可见，逻辑路径清楚 | 增加主链延迟，失败时要和当前回复一起处理 |
| Background 后台写入 | 不阻塞回答，适合批量抽取 | 需要确定触发频率、幂等键和失败补偿 |

后台写入不能只靠定时扫描“看起来像事实”的文本。至少要限制触发条件、去重、校验租户和用户、记录来源，并让错误写入可以撤回。

## 语义、经历和规则不是同一种记忆

Agent 记忆经常被写成一个泛化的“记忆库”，但语义、经历和程序性规则的生命周期差别很大。

语义记忆保存事实，例如“用户主要使用 Java”“这个项目采用 PostgreSQL”。它适合 profile，也可以按独立事实存进 collection。语义记忆和 semantic search 是两回事，前者是内容类别，后者是检索方法。

经历记忆保存发生过的事件，例如“上周排查过订单超时”“这次部署失败是因为证书过期”。它可以帮助 Agent 形成更贴近上下文的例子，但很容易过期，也包含敏感信息。写入前要判断是否必要，召回时还要带时间和来源。

程序性记忆保存规则、提示和 Agent 执行逻辑。它可以影响工具选择、输出格式和任务步骤。把网页里的任意一句话写成程序性记忆，等同于让外部文本修改系统行为。规则应进入受版本控制、可测试的 prompt 或代码配置，不能只靠向量检索命中就生效。

这三种记忆的删除和审计要求也不同。事实要能纠正和覆盖，经历要能按时间清理，程序性规则要能回滚到上一版本。混成一个集合以后，更新一条偏好可能影响过去的经历检索，删除一次会话也可能留下无法定位的向量副本。

## 写入、检索和删除分别难在哪里

写入阶段要先解决“值不值得记”。一条记忆至少要有内容、来源、作用域、写入时间、置信度和版本。来源可以是用户明确表达的偏好，也可以是 Agent 从对话中抽取的事实，但两者不能使用相同信任级别。工具返回内容或其他用户生成内容，不应直接变成高置信度的程序性规则。

检索阶段会先过滤候选，再做语义召回和重排。过滤条件要包含租户、用户、namespace、状态和有效期，不能先全库检索再在应用层筛掉越权结果。召回结果还需要控制数量、时间窗口和 token 预算。对于相互冲突的记忆，可以按更新时间、来源可信度和用户确认状态排序，并把冲突暴露给后续决策。

更新和删除比插入更麻烦。一个用户提出“忘记我之前说的数据库偏好”时，系统需要定位 profile 中的字段、collection 中的文档、对应的 embedding、缓存、checkpoint 里的历史消息，以及下游导出文件。删除记录要能证明传播结果，而不是只删主表。软删除可以保留审计，但查询、检索和导出都必须尊重删除状态。

并发写入还会带来 read-modify-write 竞态。两个请求同时更新 profile 时，后写入的内容可能覆盖先写入的字段。常见处理方式是版本号、乐观锁、事务内更新或事件队列；跨数据库操作则用 outbox 或补偿任务保证最终一致。

## 用 Java 小模型验证 thread 与用户隔离

下面的示例不依赖 LangGraph，只用 JDK 标准库模拟两个存储：checkpoint 按 `tenant + user + thread` 保存短期状态，long-term store 按 `tenant + user + namespace + key` 保存跨会话记忆。它想验证的是一组边界，而不是实现框架。

```java
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class AgentMemoryDemo {
    private static final class CheckpointStore {
        private final Map<String, List<String>> states = new LinkedHashMap<>();

        private static String key(String tenantId, String userId, String threadId) {
            return tenantId + "\u0000" + userId + "\u0000" + threadId;
        }

        void append(String tenantId, String userId, String threadId, String turn) {
            states.computeIfAbsent(key(tenantId, userId, threadId), ignored -> new ArrayList<>())
                    .add(turn);
        }

        List<String> read(String tenantId, String userId, String threadId) {
            return List.copyOf(states.getOrDefault(key(tenantId, userId, threadId), List.of()));
        }

        int deleteUser(String tenantId, String userId) {
            String prefix = tenantId + "\u0000" + userId + "\u0000";
            int before = states.size();
            states.keySet().removeIf(key -> key.startsWith(prefix));
            return before - states.size();
        }
    }

    private static final class LongTermStore {
        private final Map<String, String> memories = new LinkedHashMap<>();

        private static String key(
                String tenantId,
                String userId,
                String namespace,
                String memoryKey) {
            return tenantId + "\u0000" + userId + "\u0000" + namespace + "\u0000" + memoryKey;
        }

        void put(
                String tenantId,
                String userId,
                String namespace,
                String memoryKey,
                String value) {
            memories.put(key(tenantId, userId, namespace, memoryKey), value);
        }

        String get(
                String tenantId,
                String userId,
                String namespace,
                String memoryKey) {
            return memories.get(key(tenantId, userId, namespace, memoryKey));
        }

        int deleteUser(String tenantId, String userId) {
            String prefix = tenantId + "\u0000" + userId + "\u0000";
            int before = memories.size();
            memories.keySet().removeIf(key -> key.startsWith(prefix));
            return before - memories.size();
        }
    }

    private static void printRead(String label, List<String> state) {
        System.out.printf("%s -> %s%n", label, state.isEmpty() ? "[]" : state);
    }

    public static void main(String[] args) {
        CheckpointStore checkpoints = new CheckpointStore();
        LongTermStore longTerm = new LongTermStore();

        String tenant = "team-a";
        String user = "user-1";
        String threadA = "thread-100";
        String threadB = "thread-101";

        checkpoints.append(tenant, user, threadA, "user: 先看一下订单服务");
        checkpoints.append(tenant, user, threadA, "assistant: 已读取当前线程上下文");
        printRead("thread A state", checkpoints.read(tenant, user, threadA));
        printRead("new thread B state", checkpoints.read(tenant, user, threadB));

        longTerm.put(tenant, user, "profile", "language", "Java");
        longTerm.put(tenant, user, "profile", "answer_style", "short");
        System.out.println(
                "thread B profile -> language="
                        + longTerm.get(tenant, user, "profile", "language")
                        + ", style="
                        + longTerm.get(tenant, user, "profile", "answer_style"));

        System.out.println(
                "other user profile -> "
                        + longTerm.get(tenant, "user-2", "profile", "language"));

        int deletedCheckpoints = checkpoints.deleteUser(tenant, user);
        int deletedMemories = longTerm.deleteUser(tenant, user);
        System.out.printf(
                "delete user -> checkpointKeys=%d, memoryKeys=%d%n",
                deletedCheckpoints, deletedMemories);
        printRead("thread A after delete", checkpoints.read(tenant, user, threadA));
        System.out.println(
                "profile after delete -> "
                        + longTerm.get(tenant, user, "profile", "language"));
    }
}
```

运行命令：

```powershell
javac -encoding UTF-8 .\AgentMemoryDemo.java
java '-Dfile.encoding=UTF-8' AgentMemoryDemo
```

本机输出：

```text
thread A state -> [user: 先看一下订单服务, assistant: 已读取当前线程上下文]
new thread B state -> []
thread B profile -> language=Java, style=short
other user profile -> null
delete user -> checkpointKeys=1, memoryKeys=2
thread A after delete -> []
profile after delete -> null
```

输出里的几个边界可以直接对应到设计：

- 同一个 `thread_id` 能读到本线程之前的状态，新 thread 的短期状态为空。
- 长期 profile 属于用户，不绑定某一个 thread，所以新 thread 仍然能读到。
- 查询另一个用户时返回 `null`，说明调用方必须给存储层提供正确的用户边界。
- 删除用户时，短期状态和长期记忆分别按前缀清理；实际系统还要继续删除向量、缓存和备份副本。

这段代码没有数据库、并发控制、TTL、加密、审计或向量检索，适合用来验证键设计，不适合直接放进生产。

## Java 后端应该怎么映射这套状态

Java 服务通常已经有 Redis、MySQL 或 PostgreSQL，可以把 Agent 状态当成有生命周期和权限边界的数据来设计。

| Agent 层 | 常见后端映射 | 需要额外处理的字段 |
| --- | --- | --- |
| 当前 prompt | 请求内临时结构 | token 预算、裁剪顺序、脱敏 |
| thread 短期状态 | Redis、PostgreSQL、专门 checkpoint store | `tenant_id`、`user_id`、`thread_id`、版本、过期时间 |
| 长期记忆 | JSONB、文档数据库、独立 memory service | namespace、key、来源、置信度、更新版本 |
| 向量召回 | 向量库或数据库向量扩展 | 过滤条件、embedding 版本、删除状态 |
| 写入管道 | 事务表、消息队列或 outbox | 幂等键、重试次数、失败死信 |
| 删除与审计 | 服务层编排加审计表 | 传播范围、保留期限、操作者 |

`thread_id` 可以是 checkpoint 的主检索键，租户和用户则要来自认证上下文，并在存储层和检索层都参与过滤。比如一张 checkpoint 表可以有多列联合唯一键，一张 memory 表可以用 `tenant_id + user_id + namespace + key` 表示文档位置。SQL 层不要接受客户端直接传来的 `tenant_id` 作为唯一隔离依据。

长期记忆的更新最好走服务接口，而不是让 Agent 直接写数据库。服务接口负责格式校验、版本冲突、权限检查和审计。对于写操作，幂等键可以避免网络重试产生多条相同经历；对于异步抽取，消息的 `event_id` 和记忆版本可以避免重复写入。

还要把 checkpoint 和长期 store 分开看。checkpoint 解决恢复和运行历史，长期 store 解决用户下一次还会不会读到这条信息。把两者都塞进一个 `messages` 数组，恢复时会把不再需要的旧内容重新送回模型，删除时也很难定位。

## 测评记忆系统时不能只看回答

只看最终回答质量，很难判断记忆系统是否可靠。模型可能没召回记忆却猜中了答案，也可能召回了一条越权信息但最终措辞看起来正常。更可复核的评测至少要覆盖下面这些场景：

| 评测项 | 可观察指标 |
| --- | --- |
| 召回准确性 | 正确记忆的命中率和无关记忆比例 |
| 隔离与越权 | 跨租户、跨用户、跨 thread 的负向用例是否全部拦住 |
| 新鲜度 | 更新后旧事实是否还能被召回，时间权重是否符合预期 |
| 删除传播 | checkpoint、store、向量索引、缓存和导出中的记录是否清除 |
| 冲突处理 | 多条矛盾记忆的排序、来源和用户确认是否清楚 |
| 成本与延迟 | prompt token、检索耗时、写入耗时和缓存命中率 |
| 回答可解释性 | 能否指出这次回答使用了哪条记忆和什么版本 |

测试数据可以用几个固定的租户和用户，构造“同一事实更新”“两个用户使用相同用户名”“删除后重建 thread”“后台写入失败重放”等场景。记录召回清单和过滤条件，而不是只记录最终回答。这样出现回归时，才能知道是抽取错了、检索错了，还是最终 prompt 把正确记忆挤掉了。

记忆工程最终要落回数据治理。上下文窗口负责本次推理，thread 状态负责会话恢复，长期 store 负责跨会话复用，权限和评测负责让这些信息在正确的范围内被读写。把这四层分开，比把“大上下文”当成万能记忆更接近可维护的系统。

## 参考资料

- [LangChain Memory Overview](https://docs.langchain.com/oss/python/concepts/memory)
- [LangGraph Add Memory](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [LangGraph Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)
- [LangGraph Stores](https://docs.langchain.com/oss/python/langgraph/stores)
- [CoALA: Cognitive Architectures for Language Agents](https://arxiv.org/abs/2309.02427)
