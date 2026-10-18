---
title: HashMap 源码解析：从 put 到 resize
icon: table
date: 2026-10-18
category:
  - 面试
tag:
  - Java
  - 源码阅读
  - 集合
order: 1
star: true
---

# HashMap 源码解析：从 put 到 resize

> 状态：骨架，待填充。以下为写作大纲与要点提示。

## 核心问题（面试怎么问）

- put 一个元素的完整流程？
- 为什么容量是 2 的幂？
- 扩容为什么是 2 倍？rehash 做了什么优化？
- JDK 7 和 8 的区别？为什么改成尾插？

## 写作大纲

### 1. 底层结构

- 数组 + 链表 + 红黑树（JDK 8），树化阈值 8、退化阈值 6
- Node 节点的关键字段：hash、key、value、next

### 2. put 流程

- 计算 hash：`(h = key.hashCode()) ^ (h >>> 16)`
- 定位桶 → 空桶直接放入 / 链表尾插 / 树节点插入
- 链表长度 ≥ 8 且数组长度 ≥ 64 时树化

### 3. 扩容 resize

- 默认容量 16，负载因子 0.75，扩容为 2 倍
- JDK 8 优化：`hash & oldCap` 判断高低位，无需重新计算 hash
- 链表保持相对顺序（尾插），避免 JDK 7 头插在并发下成环

### 4. 常见追问

- 为什么树化阈值是 8？泊松分布
- null key 存哪？bucket 0
- 线程不安全的表现，ConcurrentHashMap 怎么解决

## 待补充

- [ ] 配图：put 流程图
- [ ] 代码片段：putVal 核心源码 + 注释
- [ ] 面试参考话术（30 秒版 + 3 分钟版）
