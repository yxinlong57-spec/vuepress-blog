---
title: 面经八股自测 20 题
shortTitle: 八股自测
icon: circle-question
date: 2026-10-19
category:
  - 面经手册
tag:
  - 面试
  - 自测
order: 30
description: Java 后端面试高频 20 题自测，覆盖 HashMap、synchronized、ThreadLocal、线程池、JVM、MySQL、Redis，每题附答案与专栏精讲链接。
---

先自己默答，再点开答案核对。答不出来的题，点题末链接去专栏里把原理吃透——**能讲清原理的八股才是自己的**。

## 集合与并发

**1. HashMap 的默认初始容量和负载因子是多少？为什么是这个组合？**

<details><summary>看答案</summary>

默认容量 16，负载因子 0.75。0.75 是时间与空间成本的折中：太小频繁扩容，太大哈希冲突增多、链表变长。详见 [HashMap 核心结构](./hashmap-core.html)。

</details>

**2. HashMap 的容量为什么必须是 2 的幂？**

<details><summary>看答案</summary>

定位桶时用 `(n - 1) & hash` 替代取模运算——只有 n 是 2 的幂，`&` 才等效于 `%` 且分布均匀，同时扩容时元素只需判断「原位」或「原位 + 旧容量」两个去向。

</details>

**3. 链表什么时候转红黑树？阈值为什么是 8 和 64？**

<details><summary>看答案</summary>

链表长度 ≥ 8 **且**数组容量 ≥ 64 时转红黑树；容量不足 64 时优先扩容。8 来自泊松分布统计——理想哈希下桶中 8 个节点的概率不到千万分之一，出现说明哈希恶化。

</details>

**4. HashMap 为什么线程不安全？JDK 7 和 JDK 8 的问题一样吗？**

<details><summary>看答案</summary>

不一样。JDK 7 头插法在并发扩容时可能形成环形链表导致死循环；JDK 8 改尾插解决了环，但并发 put 仍有数据覆盖、丢失问题。并发场景用 ConcurrentHashMap。

</details>

**5. synchronized 的锁升级路径是什么？**

<details><summary>看答案</summary>

无锁 → 偏向锁 → 轻量级锁 → 重量级锁，只能升不能降。升级驱动力是竞争强度：出现竞争撤销偏向，CAS 自旋失败/等待线程变多膨胀为重量级。详见 [synchronized 锁升级](./synchronized-lock-upgrade.html)。

</details>

**6. 偏向锁什么时候被撤销？现在还用吗？**

<details><summary>看答案</summary>

第二个线程竞争同一把锁时撤销（需要等到全局安全点）。JDK 15 起偏向锁默认关闭（JDK 18 彻底废弃），因为现代应用大多有竞争，偏向的收益覆盖不了撤销成本。

</details>

**7. 轻量级锁的加锁原理是什么？**

<details><summary>看答案</summary>

线程在栈帧中创建锁记录（Lock Record），用 CAS 把对象头 Mark Word 替换为指向锁记录的指针；成功即获得锁，失败则自旋重试，自旋超限膨胀为重量级锁。

</details>

**8. ThreadLocal 为什么会内存泄漏？怎么避免？**

<details><summary>看答案</summary>

ThreadLocalMap 的 Entry 中 key 是弱引用、value 是强引用。key 被 GC 后 value 还在，线程池里线程长期复用导致 value 永远无法回收。用完必须 `remove()`。详见 [ThreadLocal 与线程池的坑](./threadlocal-thread-pool.html)。

</details>

**9. 线程池里用 ThreadLocal 有什么坑？**

<details><summary>看答案</summary>

线程复用导致上一个任务的 ThreadLocal 数据残留，下一个任务读到脏数据。所以「任务开始前 set、finally 里 remove」要成对出现。

</details>

**10. 线程池的核心参数有哪些？execute 的判断顺序是什么？**

<details><summary>看答案</summary>

corePoolSize、maximumPoolSize、keepAliveTime、workQueue、threadFactory、handler。判断顺序：核心线程未满→创建核心线程；已满→入阻塞队列；队列已满→创建非核心线程；达到最大线程数→执行拒绝策略。详见 [线程池核心参数](./thread-pool.html)。

</details>

**11. 四种拒绝策略分别是什么？什么场景用哪个？**

<details><summary>看答案</summary>

AbortPolicy（默认，抛异常，适合不容忍丢任务）；CallerRunsPolicy（提交者自己执行，起反压作用）；DiscardPolicy（静默丢弃，适合可丢失任务）；DiscardOldestPolicy（丢队列最老任务，重试提交）。

</details>

**12. 为什么不推荐用 Executors 的快捷方法建线程池？**

<details><summary>看答案</summary>

`newFixedThreadPool`/`newSingleThreadExecutor` 的队列是无界的（LinkedBlockingQueue，容量 Integer.MAX_VALUE），任务堆积会 OOM；`newCachedThreadPool` 最大线程数无上限，可能创建海量线程。阿里规约要求手动 new ThreadPoolExecutor 并明确每个参数。

</details>

**13. CompletableFuture 的 supplyAsync 和 runAsync 有什么区别？**

<details><summary>看答案</summary>

supplyAsync 有返回值（CompletableFuture&lt;T&gt;），runAsync 无返回值（CompletableFuture&lt;Void&gt;）。都可指定自定义线程池，不指定则用 ForkJoinPool.commonPool。详见 [CompletableFuture 实战](./completable-future.html)。

</details>

**14. thenApply 和 thenCompose 的区别是什么？**

<details><summary>看答案</summary>

thenApply 是映射（T → U），返回嵌套的 CompletionStage 会被自动拆包一层；thenCompose 是扁平化（T → CompletableFuture&lt;U&gt;），用于串联两个异步任务避免 Future 套 Future。类比 Stream 的 map 与 flatMap。

</details>

## JVM

**15. 堆 OOM 怎么定位和排查？**

<details><summary>看答案</summary>

启动参数加 `-XX:+HeapDumpOnOutOfMemoryError` 让 OOM 时自动 dump；用 MAT 打开 dump，看 Dominator Tree 找占用最大的对象及其 GC Roots 引用链，判断是内存泄漏还是真的不够用。详见 [一次堆 OOM 的定位全过程](./jvm-heap-oom.html)。

</details>

## MySQL

**16. 什么是最左前缀原则？**

<details><summary>看答案</summary>

联合索引按定义列从左到右排序存储，查询条件必须从最左列开始连续匹配才能用上索引；跳过某一列，其后的列都用不上索引。详见 [最左前缀原则](../backend/mysql-leftmost-prefix.html)。

</details>

**17. 哪些常见写法会导致索引失效？**

<details><summary>看答案</summary>

跳过联合索引最左列；对索引列使用函数或运算；隐式类型转换（如字符串列用数字查询）；LIKE 以 % 开头；范围条件（&gt;、&lt;、BETWEEN）之后的联合索引列失效。

</details>

## Redis

**18. Redis String 的三种底层编码是什么？**

<details><summary>看答案</summary>

int（整数值）、embstr（短字符串，≤44 字节，一次内存分配）、raw（长字符串）。编码随值变化自动转换，embstr 是只读的，修改会先转 raw。

</details>

**19. ZSet 底层用了什么结构？跳表和哈希表各管什么？**

<details><summary>看答案</summary>

元素少时用 listpack（紧凑省内存）；元素多时用 skiplist + dict：跳表负责按分数范围查询（ZRange 类 O(logN)），哈希表负责按成员查分（ZScore O(1)）。

</details>

**20. 缓存穿透、击穿、雪崩的区别和常用解法？**

<details><summary>看答案</summary>

穿透=查不存在的数据（布隆过滤器/缓存空值）；击穿=热点 key 恰好过期被并发打穿（互斥锁重建/逻辑过期）；雪崩=大量 key 同时过期（过期时间加随机抖动/多级缓存）。详见 [缓存三大问题](../backend/redis-cache-three-problems.html)。

</details>

---

## 评分参考

- 18+ 题流畅答出：八股关基本过了，去抠项目细节
- 12~17 题：主干有了，把错题对应的专栏文章重读一遍
- 12 题以下：先别急着投，按 [学习路线](../roadmap.html) 把对应阶段补齐

> 题库会持续扩充到 100 题，跟着专栏文章更新走。
