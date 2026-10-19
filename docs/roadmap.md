---
icon: signpost
title: 学习路线
article: false
description: Java 后端打底、Agent 应用探路——一条从 Java 基础到分布式与 Agent 开发的完整学习路线，12 个阶段逐项拆解，每阶段配知识点清单、推荐资料、验收标准和常见坑。
---

# 学习路线 👣

这条路线是**一份公开的学习台账**：从 Java 基础一路到 Agent 应用开发，每个阶段都拆成可勾选的知识点，配上本站已发布的文章、该看什么资料、以及学完该能答出什么。

**怎么用这条路线：**

1. 按阶段顺序走，别跳级——阶段一、二没吃透，阶段四的 Spring 只会变成背注解
2. 每个阶段先看「核心知识点」清单，逐条找资料学；学完做一遍「验收标准」里的自问
3. 「配套文章」里有链接的，是我已经写完的实测文章；标 `待写` 的是排期中的选题
4. 卡住时看「常见坑」，多数人在同一处摔过

## 阶段速览

| 阶段 | 主题 | 一句话目标 |
|------|------|-----------|
| 一 | Java 基础与面向对象 | 语法到 OOP，能写出结构清晰的类 |
| 二 | 集合框架 | 说清每种集合的底层结构与选型 |
| 三 | 并发编程 | 看懂锁、线程池、JMM，能写出安全代码 |
| 四 | JVM | 会读内存模型，能定位 OOM 和 GC 问题 |
| 五 | 网络与 IO | 从 TCP 到 NIO、Netty、零拷贝 |
| 六 | MySQL | 索引、事务、锁、日志，能治慢查询 |
| 七 | Redis 与 NoSQL | 数据结构、缓存治理、持久化与高可用 |
| 八 | Spring 全家桶 | IoC/AOP/事务/Boot 原理全打通 |
| 九 | 消息队列与分布式 | 可靠投递、分布式事务、限流熔断 |
| 十 | 工程化与部署 | Linux、Docker、CI/CD、监控告警 |
| 十一 | 项目实战 | 把前面所有东西串成可讲的项目 |
| 十二 | Agent / LLM 应用 | 第二条主线：从调用模型到多 Agent 编排 |

> 求职阶段单独放在文末（八股自测 + 简历 + 投递），它是前十二个阶段的**出口**。

---

## 阶段一 · Java 基础与面向对象

**目标**：把语法写熟，理解封装/继承/多态的**实现机制**，而不是会用三个关键字。这一阶段的标志是——能解释 `==` 和 `equals` 在内存层面发生了什么。

**核心知识点**

- [x] `==` 与 `equals`：引用比较 vs 内容比较，为什么要重写 hashCode（[文章](./java/equals-and-double.html)）
- [x] 常用类库：String 不可变、StringBuilder 与 StringBuffer、包装类缓存（[Scanner 的 nextLine 跳行](./java/scanner-nextline.html) 是这类细节踩坑的典型）
- [ ] 面向对象：封装/继承/多态、接口与抽象类的取舍、方法重写与重载
- [ ] 泛型：通配符、类型擦除、泛型方法与泛型类
- [ ] 反射与注解：Class 对象、动态调用、自定义注解 + 运行时处理
- [ ] 异常体系：受检/非受检、try-with-resources、异常链
- [ ] 日期时间 API：`LocalDateTime` 与旧的 `Date/SimpleDateFormat`（后者线程不安全）

**配套文章**：✅ [== 和 equals 到底有什么区别](./java/equals-and-double.html) ｜ ✅ [Scanner nextLine() 为什么跳行](./java/scanner-nextline.html) ｜ `待写`：泛型与反射、注解实战

**推荐资料**

- 《Java 核心技术 卷 I》——语法与类库，当字典查比通读更有效
- 《Effective Java》——每一条都在教「为什么这么写」
- JDK 源码：`java.lang`、`java.util` 包直接读

**验收标准**

- 能画出对象在堆栈中的分布，讲清 `==` 为什么对 String 有时为 true
- 能写出一个自定义注解 + 反射处理的完整小例子
- 能说出 String 为什么不可变、这带来什么好处

**常见坑**

- 只看视频不动手：看完「面向对象」觉得自己会了，动手写类时连继承和组合都分不清
- 把 `equals` 重写了却忘了 `hashCode`，一进 HashSet 就出问题

---

## 阶段二 · 集合框架

**目标**：集合是面试的绝对高频，也是日常用得最多的工具。这一阶段要求**说清每种集合的底层数据结构**，而不是背 API。

**核心知识点**

- [x] ArrayList 与 LinkedList：数组 vs 链表，随机访问与增删的真实成本（[文章](./java/arraylist-vs-linkedlist.html)）
- [x] HashMap：哈希定位、扩容、树化、并发下的问题（[文章](./interview/hashmap-core.html)）
- [ ] LinkedHashMap / TreeMap：访问顺序、LRU 实现、红黑树与范围查询
- [ ] ConcurrentHashMap：JDK 7 分段锁 → JDK 8 CAS + synchronized 的演进
- [ ] 集合的 fail-fast 与 fail-safe：`modCount`、迭代器删除的正确姿势
- [ ] hashCode 与 equals 契约、对象作为 key 的坑

**配套文章**：✅ [ArrayList 和 LinkedList 怎么选](./java/arraylist-vs-linkedlist.html) ｜ ✅ [HashMap 的核心结构：put、扩容与树化](./interview/hashmap-core.html) ｜ ✅ [八股自测 20 题](./interview/quiz.html) ｜ `待写`：ConcurrentHashMap 源码、TreeMap 与红黑树

**推荐资料**

- 《Java 核心技术 卷 I》集合章节 + JDK 源码（`HashMap`、`ConcurrentHashMap`）
- 美团技术博客《Java 8 系列之重新认识 HashMap》——扩容与树化的经典图解

**验收标准**

- 白板画出 HashMap 的 `put` 流程和扩容流程，能说出「容量为什么必须是 2 的幂」
- 能解释为什么 `HashSet` 去重依赖 `hashCode` 和 `equals` 两个方法
- 能说清 ConcurrentHashMap 为什么比给 `HashMap` 加 `synchronized` 快

**常见坑**

- 背结论不跑代码：HashMap 树化阈值「8 和 64」背下来了，但说不清 64 是干什么的
- 在遍历中直接 `remove`，抛 `ConcurrentModificationException` 还不知道为什么

---

## 阶段三 · 并发编程

**目标**：这是后端面试的**分水岭**。目标是能看懂锁、线程池、内存模型，能写出线程安全的代码，而不是「加个 synchronized 就完事」。

**核心知识点**

- [x] 线程池：7 个参数、执行流程、拒绝策略、队列选型（[文章](./interview/thread-pool.html)）
- [x] synchronized：对象头、锁升级路径、偏向锁的存废（[文章](./interview/synchronized-lock-upgrade.html)）
- [x] ThreadLocal：结构、内存泄漏、在线程池中的串数据（[文章](./interview/threadlocal-thread-pool.html)）
- [x] CompletableFuture：组合、异常、超时（[文章](./interview/completable-future.html)）
- [ ] JMM：原子性、可见性、有序性；`volatile` 的双重语义与内存屏障
- [ ] CAS 与原子类：ABA 问题、`Atomic` 家族、LongAdder 分段思想
- [ ] AQS 与 ReentrantLock：state、CLH 队列、公平与非公平、Condition
- [ ] 线程生命周期与协作：`wait/notify` 与 `Condition` 的区别
- [ ] 并发工具：CountDownLatch、CyclicBarrier、Semaphore、读写锁

**配套文章**：✅ [线程池核心参数与执行流程](./interview/thread-pool.html) ｜ ✅ [synchronized 锁升级](./interview/synchronized-lock-upgrade.html) ｜ ✅ [ThreadLocal 与线程池](./interview/threadlocal-thread-pool.html) ｜ ✅ [CompletableFuture 的异常和超时处理](./interview/completable-future.html) ｜ `待写`：volatile 与 JMM、AQS 源码

**推荐资料**

- 《Java 并发编程的艺术》——AQS 与锁的入门首选
- 《Java 并发编程实战》——讲「怎么用对」，比讲原理更重要
- JDK 源码：`AbstractQueuedSynchronizer`、`ThreadPoolExecutor`

**验收标准**

- 能说清 `volatile` 保证什么、不保证什么，并用代码复现可见性问题
- 能画出线程池任务提交的判断顺序，并解释无界队列为什么让 `maximumPoolSize` 失效
- 能自己写一个基于 AQS 的简单同步器

**常见坑**

- 用 `Executors.newFixedThreadPool` 图方便，队列无界，任务堆积直接 OOM
- 线程池里用 ThreadLocal 不清理，下一个任务读到上一个任务的脏数据
- 以为 `synchronized` 是「重量级」的旧观念——JDK 6 之后它是可升级的

---

## 阶段四 · JVM

**目标**：从「会写 Java」到「知道 Java 怎么跑」。要求能读懂内存布局，能拿工具定位真实的 OOM、GC 和 CPU 飙高问题。

**核心知识点**

- [ ] 运行时内存区域：堆、栈、方法区/元空间、程序计数器、直接内存
- [ ] 对象创建与内存布局：对象头、指针压缩、逃逸分析与栈上分配
- [ ] 垃圾回收：可达性分析、GC Roots、分代假说、三色标记
- [ ] 收集器：Serial / ParNew / CMS / G1 / ZGC 的取舍与停顿特征
- [ ] 类加载机制：双亲委派、类加载器、打破双亲委派的场景
- [x] OOM 定位实战：堆转储、MAT 分析、引用链排查（[文章](./interview/jvm-heap-oom.html)）
- [ ] 诊断工具：`jps`/`jstat`/`jmap`/`jstack`/Arthas，GC 日志解读
- [ ] 常用参数：`-Xms/-Xmx`、`-XX:+HeapDumpOnOutOfMemoryError`、GC 日志开关

**配套文章**：✅ [Java 堆 OOM：从复现到定位](./interview/jvm-heap-oom.html) ｜ `待写`：内存区域与对象布局、G1 与 ZGC 取舍、Arthas 排查手册

**推荐资料**

- 《深入理解 Java 虚拟机（第 3 版）》周志明——中文 JVM 的标杆，读两遍
- JVM 规范（The Java Virtual Machine Specification）——遇到争议查规范
- Arthas 官方文档——线上排查的瑞士军刀

**验收标准**

- 能画出堆内存分代结构，说清对象从 Eden 到老年代的完整路径
- 拿到一份 heap dump 能定位到占用最大的对象及其引用链
- 能解释「为什么元空间取代了永久代」

**常见坑**

- 只背「GC 算法有四种」，遇到线上 Full GC 频繁却无从下手——不会看 GC 日志
- 把 `jstack` 当万能药，其实要先分清是 GC 问题还是死锁/自旋问题

---

## 阶段五 · 网络与 IO

**目标**：补上大多数自学路线会跳过的一段。目标是能说清一次网络请求的完整路径，理解 BIO/NIO/AIO 的本质区别，认识 Netty 解决什么问题。

**核心知识点**

- [ ] TCP/IP 基础：三次握手、四次挥手、滑动窗口、拥塞控制
- [ ] HTTP/HTTPS：报文结构、状态码语义、TLS 握手、HTTP/2 多路复用
- [x] BIO / NIO / AIO：阻塞与非阻塞的本质、Selector 多路复用（[文章](./java/bio-nio-aio.html)）
- [x] 零拷贝：`mmap`、`sendfile`、`transferTo` 的真实收益（[文章](./backend/zero-copy.html)）
- [ ] Netty：Reactor 模型、EventLoop、ChannelPipeline、粘包拆包
- [ ] 序列化：Java 原生序列化的问题、Protobuf / JSON 的取舍

**配套文章**：✅ [BIO、NIO、AIO 的区别](./java/bio-nio-aio.html) ｜ ✅ [什么是零拷贝](./backend/zero-copy.html) ｜ `待写`：TCP 三次握手与常见追问、Netty 入门实战

**推荐资料**

- 《UNIX 网络编程》——NIO 的根在这里，选读 IO 模型章节
- 《Netty 实战》+ Netty 官方文档
- 《图解 HTTP》/ MDN Web 文档——HTTP 部分够用

**验收标准**

- 能画出 BIO 与 NIO 在「一个连接一个线程 vs 一个线程管多连接」上的差异图
- 能说清 `transferTo` 相比传统读写少了哪几次数据拷贝和上下文切换
- 能写出一个最简 Netty 服务端并解释 pipeline 上各 handler 的顺序

**常见坑**

- 跳过 IO 模型直接学 Netty，结果只会抄代码，说不清自己为什么用 Netty
- 把「异步」当成「更快」——异步解决的是资源占用，不是延迟

---

## 阶段六 · MySQL

**目标**：后端最常被问、也最容易被问倒的一块。要求是**能治慢查询**，而不只是背「索引失效的十种情况」。

**核心知识点**

- [x] 索引与最左前缀：联合索引的连续前缀约束（[文章](./backend/mysql-leftmost-prefix.html)）
- [x] 索引失效：常见写法的定位与 explain 验证（[文章](./backend/mysql-index-failure.html)）
- [x] 事务与隔离级别：RR/RC 下的 ReadView 差异（[文章](./backend/mysql-readview-rr-rc.html)）
- [x] 快照读与当前读：MVCC 与加锁读的边界（[文章](./backend/mysql-snapshot-vs-current-read.html)）
- [ ] 锁：行锁/表锁/间隙锁/临键锁、死锁的成因与排查
- [ ] 日志体系：redo log、undo log、binlog 的分工与两阶段提交
- [ ] 执行计划：`explain` 各列含义、`rows` 估算、`Extra` 关键信息
- [ ] 慢查询治理：慢日志、`pt-query-digest`、索引重建、分页优化
- [ ] 分库分表：垂直/水平拆分、ShardingSphere 使用边界
- [ ] 主从复制与读写分离、数据一致性的取舍

**配套文章**：✅ 索引两篇 + 事务两篇（见上）｜ ✅ [八股自测 20 题](./interview/quiz.html) ｜ `待写`：锁与死锁排查、redo/undo/binlog、执行计划实战、分库分表

**推荐资料**

- 《MySQL 实战 45 讲》林晓斌——事务与索引章节值得反复读
- 《高性能 MySQL》——优化与运维视角
- MySQL 官方文档 InnoDB 章节（权威，但要有目标地查）

**验收标准**

- 拿到一条慢 SQL，能用 `explain` 判断问题在索引、排序还是回表
- 能画出 RR 隔离级别下快照读与当前读的执行差异，并解释幻读到底防住了没有
- 能说清一条更新语句从执行到 binlog 落盘的完整链路

**常见坑**

- 背索引失效清单但不做实验：不同数据分布下优化器可能给出不同计划
- 以为 RR 就完全没幻读——MVCC 只挡快照读，当前读照样有

---

## 阶段七 · Redis 与 NoSQL

**目标**：缓存是后端的性能命门。目标是能说清数据结构底层实现、能治缓存三大问题、能设计分布式锁。

**核心知识点**

- [x] 五种数据结构与底层编码：int/embstr/raw、listpack、skiplist（[文章](./backend/redis-data-structures.html)）
- [x] 缓存穿透 / 击穿 / 雪崩：成因与各自解法（[文章](./backend/redis-cache-three-problems.html)）
- [x] 缓存与数据库的一致性、延迟双删、逻辑过期（[文章](./backend/redis-cache-three-problems.html)）
- [x] NoSQL 与 SQL 的选型依据（[文章](./backend/sql-vs-nosql.html) / [为什么 NoSQL 快](./backend/nosql-why-faster.html)）
- [ ] 持久化：RDB 与 AOF、混合持久化、恢复点取舍
- [ ] 分布式锁：SETNX、Redisson 看门狗、RedLock 的争议
- [ ] 高可用：主从复制、哨兵、Cluster 槽位与迁移
- [ ] 内存治理：淘汰策略、大 key/热 key 排查、`MEMORY` 命令
- [ ] 常见踩坑：`keys *` 阻塞、Pipeline 与批量的取舍

**配套文章**：✅ [Redis 五种数据结构与应用场景](./backend/redis-data-structures.html) ｜ ✅ [缓存穿透 / 击穿 / 雪崩](./backend/redis-cache-three-problems.html) ｜ ✅ [SQL 与 NoSQL 怎么选](./backend/sql-vs-nosql.html) ｜ ✅ [为什么 NoSQL 更快](./backend/nosql-why-faster.html) ｜ `待写`：持久化、分布式锁、Cluster

**推荐资料**

- 《Redis 设计与实现》黄健宏——数据结构底层的必读
- Redis 官方文档 + `redis.io/docs` 的 command 参考
- 《Redis 深度历险》——实战场景与踩坑

**验收标准**

- 能说清 ZSet 底层跳表与哈希表各自负责什么，复杂度分别是多少
- 能针对「热点 key 过期打穿数据库」给出两种以上方案并说明取舍
- 能讲清 Redisson 看门狗续期的机制和它解决的具体问题

**常见坑**

- 缓存和数据库的双写顺序靠感觉：先删缓存还是先更库，说不清为什么
- 用 `keys *` 在生产上排查，直接把 Redis 阻塞住

---

## 阶段八 · Spring 全家桶

**目标**：从「会用注解」到「知道注解背后发生了什么」。要求能讲清 IoC 容器、Bean 生命周期、AOP 代理、事务失效场景。

**核心知识点**

- [ ] IoC 与 DI：容器的启动流程、`BeanDefinition`、依赖注入的三种方式
- [ ] Bean 生命周期：实例化、属性填充、初始化、销毁、循环依赖与三级缓存
- [ ] AOP：JDK 动态代理与 CGLIB、切面顺序、`@Transactional` 为什么失效
- [ ] 事务：传播行为、隔离级别、回滚规则、嵌套事务的实际边界
- [ ] Spring MVC：请求链路、参数绑定、拦截器与过滤器
- [x] Spring Boot 自动装配：`spring.factories` → `.imports` 的演进（[文章](./spring/auto-configuration.html)）
- [x] API 版本控制：Spring Boot 4.1 的新能力（[文章](./spring/springboot-api-versioning.html)）
- [ ] 启动优化与配置体系：profile、`@ConfigurationProperties`、条件装配
- [ ] 常见扩展点：`BeanPostProcessor`、`ApplicationListener`、自定义 Starter

**配套文章**：✅ [Spring Boot 自动装配原理](./spring/auto-configuration.html) ｜ ✅ [Spring Boot 4.1 的 API 版本控制](./spring/springboot-api-versioning.html) ｜ `待写`：IoC 与 Bean 生命周期、事务失效场景、自定义 Starter

**推荐资料**

- 《Spring 揭秘》——中文资料里讲容器设计最好的一本
- Spring 官方文档 Core Container 章节
- 源码：`refresh()` 方法的 12 个步骤逐行走一遍

**验收标准**

- 能讲清三级缓存怎么解决循环依赖，以及它解决不了哪种循环依赖
- 能列出至少三种 `@Transactional` 失效场景并说明原因
- 能自己写一个自定义 Starter，理解条件装配如何生效

**常见坑**

- 只用过 `@Autowired`，被问「循环依赖怎么解决」就卡住
- 事务失效了只会加 `try-catch` 绕过去，不知道是自调用导致代理失效

---

## 阶段九 · 消息队列与分布式

**目标**：从单体走向分布式。目标是理解 MQ 解决什么问题、分布式事务的几种方案边界、限流熔断的落地方式。

**核心知识点**

- [ ] MQ 基础：解耦、异步、削峰；RocketMQ 与 Kafka 的定位差异
- [ ] 可靠投递：消息丢失的三种场景（生产/存储/消费）与各自对策
- [ ] 幂等与重复消费：业务幂等的实现方式
- [ ] 顺序消息、事务消息、延时消息的实现原理
- [ ] 分布式事务：2PC/TCC、本地消息表、最大努力通知、Seata 的使用边界
- [ ] 分布式 ID：雪花算法、号段模式、时钟回拨问题
- [ ] 限流熔断降级：Sentinel 的流控规则、熔断策略、热点参数
- [ ] 服务治理：注册中心（Nacos）、配置中心、网关（Spring Cloud Gateway）
- [ ] 分布式锁：Redis 与 ZooKeeper 两种实现的取舍

**配套文章**：全部 `待写`（选题池：RocketMQ 可靠投递、幂等设计、Sentinel 流控、分布式 ID 对比、Seata 边界）

**推荐资料**

- RocketMQ / Kafka 官方文档（先读「设计」章节，再读 API）
- 《凤凰架构》周志明（在线免费）——分布式架构的整个拼图
- Sentinel、Nacos、Seata 官方文档

**验收标准**

- 能说清「消息重复消费」为什么必然发生，以及业务侧应该怎么兜住
- 能对比 TCC 与本地消息表的适用场景，说出各自最痛的地方
- 能设计一套限流方案：阈值怎么定、被限的请求怎么办

**常见坑**

- 引入 MQ 就以为万事大吉，没考虑消费幂等和消息堆积
- 分布式事务硬啃 Seata，忘了九成业务用「本地消息表 + 幂等」就够

---

## 阶段十 · 工程化与部署

**目标**：让代码**能跑在别人的机器上**。目标是掌握 Linux 常用操作、容器化、日志与监控、自动化部署。

**核心知识点**

- [ ] Linux 常用：文件、权限、进程、网络排查（`netstat`/`ss`/`top`/`df`）
- [ ] Git 协作：分支模型、rebase 与 merge 的取舍、Code Review 习惯
- [ ] Maven / Gradle：依赖管理、BOM、多模块构建、冲突排查
- [ ] Docker：镜像与分层、Dockerfile 优化、网络与数据卷、Compose 编排
- [x] CI/CD：GitHub Actions 构建与自动部署（[文章](./projects/vuepress-blog.html) 里有完整实践）
- [ ] 日志：Logback 配置、结构化日志、链路追踪（traceId）
- [ ] 监控告警：Prometheus + Grafana、Spring Boot Actuator、健康检查
- [ ] 接口测试：单元测试、MockMvc、Postman/curl 验证习惯
- [ ] 接口文档：OpenAPI/Swagger 的规范用法

**配套文章**：✅ [从 0 搭建 VuePress 博客并自动化部署](./projects/vuepress-blog.html)（CI/CD 实践）｜ `待写`：Docker 部署 Java 应用、Linux 排查命令手册

**推荐资料**

- 《鸟哥的 Linux 私房菜》——基础部分查手册用
- Docker 官方 Get Started + 《Docker 实践》
- Spring Boot Actuator、Prometheus 官方文档

**验收标准**

- 能把一个 Spring Boot 应用打成镜像、用 Compose 起一套「应用 + MySQL + Redis」
- 能用 Linux 命令定位「端口被占 / 磁盘满 / 进程挂了」三类常见事故
- 能写出一个带构建、测试、部署三段的流水线

**常见坑**

- 本地跑通就认为完成，换个环境全是路径和版本问题
- 不打日志或只打 `System.out`，线上出问题只能靠猜

---

## 阶段十一 · 项目实战

**目标**：把前十个阶段的东西**串起来**，产出能写进简历、能被追问的项目。学习项目要诚实定位、自建项目要有自己的设计取舍。

**核心知识点**

- [x] 需求与设计：从一句话需求拆到表结构和接口（[VuePress 博客项目复盘](./projects/vuepress-blog.html)）
- [x] CI/CD 落地：从提交到上线全自动（同上）
- [ ] 黑马点评：Redis 缓存、秒杀、分布式锁（[简历包装参考](./interview/heima-comment-resume.html)）
- [ ] 黑马商城：订单、库存、支付链路与一致性（[简历包装参考](./interview/heima-mall-resume.html)）
- [ ] 黑马头条：学习项目的正确定位（[简历包装参考](./interview/heima-toutiao-resume.html)）
- [ ] 独立项目：自己选题，从架构设计写到上线运维
- [ ] 复盘方法论：问题 → 方案 → 量化结果，每个亮点都要能被追问三轮

**配套文章**：✅ [从 0 搭建 VuePress 博客并自动化部署](./projects/vuepress-blog.html) ｜ ✅ 三篇项目简历包装（见上）｜ `待写`：项目复盘专栏（逐项目：需求 → 设计 → 实现 → 优化）

**推荐资料**

- 你要做的项目涉及的技术，回头翻对应阶段的文章
- 优秀开源项目源码（如 mall、ruoyi）——学分层与工程结构

**验收标准**

- 每个写进简历的亮点，都能讲清「为什么这么做、还有什么方案、量化结果是多少」
- 能画出项目的整体架构图，说清一次请求从入口到落库的完整路径
- 项目能实际部署运行，不是只在自己 IDE 里跑通

**常见坑**

- 项目抄完就写进简历，被追问「你负责哪部分」当场哑火
- 亮点没有量化数据（QPS、耗时），等于没做过优化

---

## 阶段十二 · Agent / LLM 应用

**目标**：这是本栈的第二条主线——**Java 后端打底，Agent 应用探路**。目标是理解 Agent 的工程结构，能用 Java/Spring 生态把模型能力接进真实系统。

**核心知识点**

- [x] AI Agent 入门：概念、边界、新手先学什么（[文章](./agent/ai-agent-intro.html)）
- [x] 最小 Agent 循环：步数上限、重复调用检测、错误熔断（[文章](./agent/minimal-agent-loop.html)）
- [x] Function Calling：参数校验与失败处理（[文章](./agent/function-calling-validation.html)）
- [x] MCP：接入本地工具、安全边界（[文章](./agent/mcp-local-tools.html) / [安全边界](./agent/mcp-security.html)）
- [x] Agent Skills：工程化的能力封装（[文章](./agent/agent-skills.html)）
- [x] A2A 与 MCP 的边界：Agent 间协作协议（[文章](./agent/a2a-vs-mcp.html)）
- [x] 多 Agent 架构：分工、通信、失败处理（[文章](./agent/multi-agent-architecture.html)）
- [x] 记忆：短期/长期记忆与上下文管理（[文章](./agent/agent-memory.html)）
- [x] 评测：怎么判断 Agent 变好了（[文章](./agent/agent-evaluation.html)）
- [x] Spring AI 工具调用执行链（[文章](./agent/springai-tool-calling.html)）｜ [Spring AI 与 LangChain4j 对比](./agent/springai-vs-langchain4j.html)
- [x] RAG：Java 手写最小 RAG（[文章](./agent/java-minimal-rag.html)）
- [x] 上下文工程：上下文预算、压缩、分层注入与按需检索（[文章](./agent/context-engineering.html)）
- [x] 工作流编排：状态图、条件边、检查点与人工介入（[文章](./agent/workflow-orchestration.html)）
- [x] MCP Server 实现：按规范手写协议面并跑通完整交互（[文章](./agent/mcp-server-java.html)）
- [x] Agentic RAG：查询改写、混合召回、重排与纠错循环（[文章](./agent/agentic-rag.html)）
- [x] Agent 可观测性：Span 树、指标与成本账本（[文章](./agent/agent-observability.html)）
- [ ] 框架级编排落地：LangGraph4j / Spring AI 工作流（要求本机真跑，不是抄文档）
- [ ] 生产化补齐：限流与降级、模型路由与回退、工具描述与提示词调优

**配套文章**：✅ 上列 18 篇（详见 [Agent 探索专栏](./agent/)）｜ `待写`：框架级编排落地、模型路由与降级

**推荐资料**

- Anthropic《Building Effective Agents》——把 Agent 拆成工作流与自主循环的经典文章
- MCP 官方规范 + Spring AI 官方参考文档
- 各模型厂商的 Function Calling 文档（对比着看，格式差异才是真坑）

**验收标准**

- 能画出一个 Agent 的完整循环图，标出每一步的失败点和兜底策略
- 能说清 MCP 与 Function Calling 的关系——为什么前者不是后者的替代品
- 能给出 Agent 评测的基本方法：任务集、通过率、失败归因

**常见坑**

- 一上来就搭多 Agent，单 Agent 的循环、工具、记忆都没调明白
- 只 demo 不评测：改完提示词「感觉变好了」，没有任何指标支撑

---

## 出口 · 求职与面试

**目标**：把十二个阶段的积累**翻译成一份简历和一场面试**。技术是底子，表达是出口。

**核心知识点**

- [x] 八股自测：20 题覆盖高频考点（[试题](./interview/quiz.html)）
- [x] 简历写法：整体框架（[文章](./interview/java-backend-resume.html)）
- [x] 项目经历包装：三个项目的写法参考（[黑马点评](./interview/heima-comment-resume.html) / [黑马商城](./interview/heima-mall-resume.html) / [黑马头条](./interview/heima-toutiao-resume.html)）
- [x] 投递前自查：命名、链接、追问准备（[资源包](./interview/resume.html)）
- [ ] 高频算法：数组、字符串、链表、二叉树、动态规划（按题单刷）
- [ ] 答题话术：原理 → 场景 → 取舍，三层结构回答
- [ ] 反问环节、薪资沟通、offer 比较

**配套文章**：✅ [八股自测 20 题](./interview/quiz.html) ｜ ✅ [简历资源包](./interview/resume.html)（含结构模板与投递清单）｜ `待写`：算法题单、面试话术模板

**验收标准**

- 简历上每个技术关键词都能讲 5 分钟以上，经得起两轮追问
- 八股自测 18 题以上流畅答出
- 至少完成一次模拟面试（同学互面也算）

---

## 后续更新计划

这条路线会随学习进度持续补：**每完成一个阶段，就回这里勾掉对应项**，并把该阶段的文章补进「配套文章」。

近期排期（与仓库根目录的「LoongStack-迭代升级规划」同步）：

- `待写` 选题优先级：并发补齐（volatile/AQS）→ MySQL 锁与日志 → Spring 事务 → IO 与 Netty → 分布式
- 每个阶段补齐后，写一篇**阶段总结文章**，把该阶段的知识点串成一条线
- 阶段导读图（每阶段一张知识地图）后续补进本页

> 路线不追求一次写全，追求**每一步都有记录**。日拱一卒，功不唐捐。
