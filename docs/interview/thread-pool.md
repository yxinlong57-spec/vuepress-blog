---
title: Java 线程池核心参数与执行流程
icon: gears
date: 2026-10-18
category:
  - 面试
tag:
  - Java
  - 并发编程
order: 2
---

# Java 线程池核心参数与执行流程

> 状态：骨架，待填充。以下为写作大纲与要点提示。

## 核心问题（面试怎么问）

- 七个核心参数分别是什么？
- 任务提交后的执行流程？
- 为什么不建议用 Executors 直接创建？
- 拒绝策略有哪几种？实际项目怎么选？

## 写作大纲

### 1. 七个核心参数

- corePoolSize、maximumPoolSize、keepAliveTime、unit
- workQueue、threadFactory、handler

### 2. 执行流程

```text
提交任务
  → 核心线程未满？创建核心线程
  → 满了？入队
  → 队列满？创建非核心线程（不超过 max）
  → 都满？执行拒绝策略
```

### 3. 四种拒绝策略

- AbortPolicy（默认，抛异常）/ CallerRunsPolicy / DiscardPolicy / DiscardOldestPolicy

### 4. 为什么禁用 Executors

- FixedThreadPool / SingleThreadPool：无界队列 → OOM
- CachedThreadPool：无界线程数 → 资源耗尽

### 5. 实践要点

- 参数怎么估：CPU 密集 vs IO 密集
- 动态线程池思路（配置中心调参）

## 待补充

- [ ] 配图：执行流程图
- [ ] 源码：execute 三步走 + addWorker 关键行
- [ ] 面试参考话术
