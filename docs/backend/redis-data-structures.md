---
title: Redis 常用数据结构与应用场景
icon: database
date: 2026-10-18
category:
  - 后端
tag:
  - Redis
  - 中间件
order: 1
star: true
---

# Redis 常用数据结构与应用场景

> 状态：骨架，待填充。以下为写作大纲与要点提示。

## 核心问题（面试怎么问）

- 五大基础结构 + 底层编码分别是什么？
- 每种结构适合什么业务场景？
- ZSet 怎么实现排行榜？底层跳表原理？
- 对象和编码的映射关系（object encoding）？

## 写作大纲

### 1. String

- 底层：SDS（简单动态字符串），预分配 + 惰性释放
- 场景：缓存对象、计数器、分布式锁 setnx

### 2. Hash

- 场景：购物车、对象属性级更新
- 编码：listpack（小）/ hashtable（大）

### 3. List

- 底层：quicklist（双向链表 + listpack 节点）
- 场景：最新消息列表、简单队列

### 4. Set

- 场景：标签、共同关注（sinterstore）、抽奖去重
- 编码：intset / listpack / hashtable

### 5. ZSet

- 场景：排行榜、延时队列（score 存时间戳）
- 底层：listpack（小）/ 跳表 + 哈希表
- 跳表为什么不用红黑树：范围查询 + 实现简单

## 待补充

- [ ] 配表：结构与编码映射表
- [ ] 命令示例：每个结构 3~5 个核心命令
- [ ] 跳表演进图解
