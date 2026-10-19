---
icon: signpost
title: 学习路线
article: false
---

# 学习路线 👣

一条从 Java 基础到 Agent 应用的完整路线，每个阶段配套本站专栏文章，边学边补，持续推进。

## 阶段一：Java 基础与集合

- [x] [== 和 equals 到底有什么区别](./java/equals-and-double.html)
- [x] [Scanner nextLine() 为什么跳行](./java/scanner-nextline.html)
- [x] [ArrayList 和 LinkedList 怎么选](./java/arraylist-vs-linkedlist.html)
- [ ] 泛型、反射、注解的原理与实战

## 阶段二：集合与并发

- [x] [HashMap 的核心结构：put、扩容与树化](./interview/hashmap-core.html)
- [ ] ConcurrentHashMap 源码
- [x] [线程池核心参数与执行流程](./interview/thread-pool.html)
- [x] [synchronized 锁升级](./interview/synchronized-lock-upgrade.html)
- [ ] volatile、CAS 与内存可见性 / AQS
- [x] [ThreadLocal 与线程池：串数据与内存泄漏](./interview/threadlocal-thread-pool.html)
- [x] [CompletableFuture 的异常和超时处理](./interview/completable-future.html)

## 阶段三：JVM

- [ ] 运行时内存区域
- [ ] 垃圾回收算法与收集器
- [ ] 类加载机制
- [x] [Java 堆 OOM：从复现到定位](./interview/jvm-heap-oom.html)

## 阶段四：Spring 全家桶

- [ ] IoC 容器与 Bean 生命周期
- [ ] AOP 与动态代理
- [ ] 事务传播与失效场景
- [x] [Spring Boot 自动装配原理](./spring/auto-configuration.html)
- [x] [Spring Boot 4.1 的 API 版本控制](./spring/springboot-api-versioning.html)

## 阶段五：MySQL 与 Redis

- [x] [MySQL 索引：最左前缀原则](./backend/mysql-leftmost-prefix.html) / [索引失效定位](./backend/mysql-index-failure.html)
- [x] [MySQL 事务：RR 与 RC 的 ReadView](./backend/mysql-readview-rr-rc.html) / [快照读与当前读](./backend/mysql-snapshot-vs-current-read.html)
- [ ] MySQL 锁与日志体系
- [x] [Redis 五种数据结构与应用场景](./backend/redis-data-structures.html) / [缓存穿透 / 击穿 / 雪崩](./backend/redis-cache-three-problems.html)
- [ ] Redis：持久化、分布式锁
- [x] [什么是零拷贝](./backend/zero-copy.html) / [SQL 与 NoSQL 怎么选](./backend/sql-vs-nosql.html)

## 阶段六：消息队列与分布式

- [ ] RocketMQ / Kafka 基础与可靠投递
- [ ] 分布式事务、分布式 ID
- [ ] 限流、熔断与降级

## 阶段七：实战项目

- [x] [从 0 搭建 VuePress 博客并自动化部署](./projects/vuepress-blog.html)
- [ ] Spring Boot + Redis 完整练手项目（规划中）

## 阶段八：Agent / LLM 应用

- [x] [AI Agent 入门：新手先学什么](./agent/ai-agent-intro.html)
- [x] [MCP 接入本地工具](./agent/mcp-local-tools.html) / [MCP 安全边界](./agent/mcp-security.html)
- [x] [A2A 与 MCP 边界](./agent/a2a-vs-mcp.html)
- [x] [手写最小 Agent 循环](./agent/minimal-agent-loop.html)
- [x] [Spring AI 工具调用执行链](./agent/springai-tool-calling.html)
- [x] [Java 手写最小 RAG](./agent/java-minimal-rag.html)
- [ ] Agent 编排实战（Spring AI / LangGraph4j）
- [ ] 多 Agent 协作项目落地

---

> 路线会随学习进度持续更新，完成一项勾一项，进度可视化。
