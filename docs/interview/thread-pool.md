---
title: "线程池的 7 个核心参数到底怎么配合？从执行流程到拒绝策略一次讲透"
shortTitle: "线程池核心参数"
date: 2026-10-19
description: "实测四种拒绝策略的真实行为，讲清线程池 7 个核心参数的配合关系、任务提交后的判断顺序、阻塞队列选型，以及 Executors 工厂方法的 OOM 隐患。"
category:
  - 面经手册
tag:
  - Java
  - 并发
  - 线程池
order: 10
---


> 实验环境：Windows 11、OpenJDK 11.0.32.1（Temurin），文中的执行流程和实测输出以 JDK 11 源码为准。`ThreadPoolExecutor.execute` 的主干逻辑从 JDK 8 到目前的 JDK 21 没有实质变化，但具体细节仍以你使用的 JDK 版本源码为准。

被问"线程池有哪些参数"时，背出 7 个名词只能算开场。真正的考点在配合关系：任务进来先找谁、队列满了才会发生什么、为什么无界队列会让 `maximumPoolSize` 形同虚设。很多人把执行顺序记成"先开满最大线程再放队列"，顺序正好反了——队列排在最大线程数前面。

这篇文章先把 7 个参数各自管什么说清，再沿着 `execute()` 的源码走一遍判断顺序，然后用两个本机实测的 demo 看四种拒绝策略和三种阻塞队列的真实行为，最后聊参数估算和面试答法。

## 目录

- 一、七个参数各自管什么
- 二、任务进来以后，execute 按什么顺序判断
- 三、四种拒绝策略：8 个任务塞进 2+4 的池子
- 四、阻塞队列选型：队列决定 maximumPoolSize 有没有用
- 五、为什么不推荐 Executors 工厂方法
- 六、自定义线程池的参数怎么估
- 七、面试怎么答

## 一、七个参数各自管什么

`ThreadPoolExecutor` 最完整的构造函数长这样：

```java
public ThreadPoolExecutor(int corePoolSize,
                          int maximumPoolSize,
                          long keepAliveTime,
                          TimeUnit unit,
                          BlockingQueue<Runnable> workQueue,
                          ThreadFactory threadFactory,
                          RejectedExecutionHandler handler)
```

**corePoolSize（核心线程数）**：池子里常驻的线程数量。默认情况下核心线程创建后即使空闲也不会被回收，除非调用 `allowCoreThreadTimeOut(true)` 且 `keepAliveTime > 0`。线程不是构造时就建好的，默认是任务来了才创建；想提前建好可以用 `prestartAllCoreThreads()` 预热。

**maximumPoolSize（最大线程数）**：池子能开到的上限。超出核心数的部分叫非核心线程，空闲超过 `keepAliveTime` 就会被回收。追问点：这个参数只在**队列满了以后**才起作用，队列不满时它完全不参与决策。

**keepAliveTime + unit（空闲存活时间及单位）**：非核心线程空闲多久后被回收。默认只约束非核心线程；开启 `allowCoreThreadTimeOut(true)` 后对核心线程同样生效——这是面试里经常被反问到的边界。

**workQueue（任务队列）**：存放来不及执行的任务的阻塞队列。选型直接决定整个池子的行为模式，后面第四节专门讲。

**threadFactory（线程工厂）**：负责创建线程。默认的 `Executors.defaultThreadFactory` 创建的是非 daemon、优先级 5、名字为 `pool-N-thread-M` 的线程。生产环境几乎一定要自定义，至少给线程起个能认的名字，否则线上排查时一堆 `pool-3-thread-17` 根本分不清是哪个池子。

**handler（拒绝策略）**：队列满且线程数到达上限后，新任务怎么处理。JDK 内置四种，第三节实测。

七个参数里真正影响"任务会走哪条路"的只有四个：corePoolSize、maximumPoolSize、workQueue、handler。其余三个管生命周期和线程属性。

## 二、任务进来以后，execute 按什么顺序判断

JDK 11 中 `execute()` 的核心逻辑：

![线程池任务执行判断流程](/images/interview/thread-pool/01-execute-flow.svg)

```java
int c = ctl.get();
if (workerCountOf(c) < corePoolSize) {
    if (addWorker(command, true))
        return;
    c = ctl.get();
}
if (isRunning(c) && workQueue.offer(command)) {
    int recheck = ctl.get();
    if (!isRunning(recheck) && remove(command))
        reject(command);
    else if (workerCountOf(recheck) == 0)
        addWorker(null, false);
}
else if (!addWorker(command, false))
    reject(command);
```

翻译成判断顺序，一共四道门：

1. **当前线程数 < corePoolSize**：直接创建核心线程执行任务，任务根本不进队列。哪怕有空闲的核心线程也一样新开——这里不看"有没有闲着的"，只看"数量够不够"。
2. **核心数够了，尝试 `workQueue.offer(command)`**：进队列排队，等空闲线程来取。注意用的是非阻塞的 `offer`，队列满时返回 false 而不是挂起。
3. **队列满了，尝试创建非核心线程**：数量不超过 maximumPoolSize 就开新线程执行。
4. **线程数也到顶了**：交给拒绝策略处理。

记忆锚点是"**核心线程 → 队列 → 最大线程 → 拒绝**"。这个顺序解释了为什么无界队列会让 `maximumPoolSize` 失效：第二步永远成功，第三、四步永远走不到。

第二段代码里还有个容易被忽略的兜底：任务入队成功后会复查一次池状态，如果池子在这期间被 shutdown 了，就把任务从队列里移除并拒绝；如果入队时池里一个线程都没有（比如核心线程被超时回收光了），补一个不带任务的线程去接队列里的活。答题时不用展开，但知道有这层复查能体现读过源码。

## 三、四种拒绝策略：8 个任务塞进 2+4 的池子

JDK 内置四种策略：

| 策略 | 行为 | 适用 |
| --- | --- | --- |
| AbortPolicy（默认） | 抛 `RejectedExecutionException` | 任务不能丢，由调用方决定怎么办 |
| CallerRunsPolicy | 让提交任务的线程自己执行 | 需要天然背压，提交方会被拖慢 |
| DiscardPolicy | 静默丢弃，不抛异常 | 允许丢失的监控、日志类任务 |
| DiscardOldestPolicy | 丢掉队首最老的任务，重试当前任务 | 允许丢旧数据的场景 |

光看定义没感觉，我跑了一个实验：核心 2、最大 4、队列容量 2，提交 8 个各耗时 200ms 的任务。按第二节的顺序推演，task-1、task-2 进核心线程，task-3、task-4 进队列，task-5、task-6 触发非核心线程，task-7、task-8 被拒绝。实测代码里每个任务执行时记录自己的名字，拒绝发生时计数：

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
        2, 4, 0L, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(2),
        handler);   // 四种策略轮流替换
for (int i = 1; i <= 8; i++) {
    final int id = i;
    try {
        pool.execute(() -> {
            executed.add("task-" + id);
            if (Thread.currentThread().getName().equals("main")) {
                ranOnCaller.add("task-" + id);
            }
            Thread.sleep(200);
        });
    } catch (RejectedExecutionException e) {
        rejectedByAbort.incrementAndGet();
    }
}
```

本机真实输出：

```text
=== AbortPolicy ===
被执行的任务: [task-1, task-2, task-3, task-4, task-5, task-6]
执行数: 6 / 8
main 线程捕获 RejectedExecutionException 次数: 2

=== CallerRunsPolicy ===
被执行的任务: [task-1, task-2, task-3, task-4, task-5, task-6, task-7, task-8]
执行数: 8 / 8
由 main(调用方)线程执行的任务: [task-7]

=== DiscardPolicy ===
被执行的任务: [task-1, task-2, task-3, task-4, task-5, task-6]
执行数: 6 / 8

=== DiscardOldestPolicy ===
被执行的任务: [task-1, task-2, task-5, task-6, task-7, task-8]
执行数: 6 / 8
```

和推演完全对得上，但有几个细节值得盯着看：

- **AbortPolicy** 丢的是 task-7、task-8 这两个"新来"的，异常直接抛在调用方（main 线程）的 `execute` 调用上。所以用它时调用方代码必须能接住这个异常，否则提交任务的请求线程会跟着炸。
- **CallerRunsPolicy** 的 8 个任务全执行了，其中 task-7 是 main 线程自己跑的。这里有个反直觉的点：task-8 没有走拒绝——main 执行 task-7 花了 200ms，这期间 worker 消化了队列里的任务，task-8 提交时池子里又有位置了。**CallerRunsPolicy 本身就是减速阀**，调用方被拖慢的这段时间给了池子喘息的空间，这就是"天然背压"的含义。
- **DiscardOldestPolicy** 丢的是 task-3、task-4——它们是被挤掉的队首。注意两个坑：一是"最老"指队首，如果队列换成 `PriorityBlockingQueue`，被丢的会是优先级最高的任务，语义直接拧掉；二是被丢的任务没有任何通知，排查丢失问题时毫无痕迹。

## 四、阻塞队列选型：队列决定 maximumPoolSize 有没有用

三种最常用的队列，行为差异极大：

| 队列 | 容量 | 排队模型 | 对线程池的影响 |
| --- | --- | --- | --- |
| ArrayBlockingQueue | 必须有界 | 单锁数组队列 | 满后触发非核心线程，行为可预期 |
| LinkedBlockingQueue | 默认无界，可指定容量 | 链表，存取两把锁 | 不传容量时 maximumPoolSize 失效 |
| SynchronousQueue | 不存任务 | 直接交接 | 每个任务立刻需要线程，退化为"按需创建" |

无界队列和 SynchronousQueue 的差别，跑一次比背十遍清楚。实验：核心 2、最大 4，提交 10 个各 300ms 的任务，分别配两种队列：

```text
LinkedBlockingQueue(无界): largestPoolSize=2, 被拒绝任务数=0
SynchronousQueue: largestPoolSize=4, 被拒绝任务数=6
```

LinkedBlockingQueue 无界时，10 个任务全塞进队列，线程数永远停在 2——maximumPoolSize=4 一次都没用上，同时也永远不会拒绝。SynchronousQueue 则相反：它不存任务，task-1、task-2 占了核心线程后，task-3 到 task-6 直接逼出 4 个线程，之后每个新任务都找不到空闲线程交接，立刻被拒绝。

选型逻辑：

- **想要可控、可预期的池子，用有界队列**。`ArrayBlockingQueue` 或指定容量的 `LinkedBlockingQueue` 都行，前者单锁实现简单，后者存取分离理论上并发略好。容量估算见第六节。
- **SynchronousQueue 适合"任务必须立刻被处理，处理不了马上失败"的场景**，`newCachedThreadPool` 用的就是它。配合有限的最大线程数可以做出很硬的限流。
- **`LinkedBlockingQueue` 不传容量等于关掉限流**：任务无限堆积，表象是线程池"很稳定"，实际是延迟悄悄上涨，最后堆内存耗尽。
- 顺带提两个：`PriorityBlockingQueue` 是无界的，慎用；`ScheduledThreadPoolExecutor` 内部用的是专用的 `DelayedWorkQueue`，也是无界增长。

## 五、为什么不推荐 Executors 工厂方法

看源码里 `Executors` 几个工厂方法实际创建的东西：

```java
// newFixedThreadPool(n)
new ThreadPoolExecutor(n, n, 0L, TimeUnit.MILLISECONDS,
                       new LinkedBlockingQueue<Runnable>());   // 无界队列

// newCachedThreadPool()
new ThreadPoolExecutor(0, Integer.MAX_VALUE, 60L, TimeUnit.SECONDS,
                       new SynchronousQueue<Runnable>());       // 线程数无上限
```

问题一目了然：

- **FixedThreadPool / SingleThreadExecutor**：队列无界，任务突增时全部堆在堆里，最终 `OutOfMemoryError: Java heap space`。等 OOM 发生时，dump 里躺着几十万个排队的 Runnable。
- **CachedThreadPool / ScheduledThreadPool**：最大线程数设为 `Integer.MAX_VALUE`，任务来得猛时疯狂建线程，最终 `OutOfMemoryError: unable to create native thread`。每条线程默认栈大小 1MB 量级（`-Xss` 控制），几千条线程就能吃光内存或撞系统线程数上限。

阿里巴巴 Java 开发手册把"禁止使用 Executors 创建线程池"列为强制项，原因就这两条。另外工程层面还有一个理由：工厂方法不让你传 ThreadFactory，线上出问题连池子都认不出来。手动 `new ThreadPoolExecutor` 时把 7 个参数写全，本身就是一种设计评审。

## 六、自定义线程池的参数怎么估

没有一个公式能直接给出生产配置，但有一套推理路径。

《Java 并发编程实战》给的经典公式是：

```text
线程数 = CPU 核数 × 期望 CPU 利用率 × (1 + 等待时间 / 计算时间)
```

- **CPU 密集型**：等待时间接近 0，线程数取核数或核数 + 1 就够了，再多只会增加上下文切换。
- **IO 密集型**：线程大部分时间在等数据库、等 RPC 返回，W/C 比值可能是 5、10 甚至更高，线程数可以放大到几十。但这个比值得靠 profiling 或日志统计，不能拍脑袋。

队列容量按延迟预算估：能容忍任务排队多久，决定了队列长度 ≈ 峰值 QPS × 可容忍等待秒数。比如峰值 500 QPS、可容忍 2 秒排队，队列就给 1000 量级。

比公式更重要的是**上线后看真实指标**。`ThreadPoolExecutor` 自带 `getActiveCount()`（活跃线程数）、`getQueue().size()`（排队数）、`getCompletedTaskCount()`（累计完成数），接进监控系统定期上报，跑两周就知道参数该不该调。我见过最常见的错误不是公式用错，而是配完参数从此再没人看过一眼。

拒绝策略按业务选：任务可丢就 Discard 系列但务必打点记录；不可丢优先 CallerRunsPolicy 利用背压减速，或者自定义策略把任务落 MQ、落库稍后重放。

## 七、面试怎么答

"说说线程池的参数和原理"，我建议按这个顺序组织 90 秒的口述：

1. **先报参数**：corePoolSize、maximumPoolSize、keepAliveTime 加 unit、workQueue、threadFactory、handler，一句话带过每个管什么。
2. **马上接执行顺序**：核心线程满 → 进队列 → 队列满才开非核心线程到 max → 都满了走拒绝。强调"队列排在最大线程前面"，这是区分背没背过的分水岭。
3. **主动抛一个坑**：LinkedBlockingQueue 无界时 maximumPoolSize 失效，这也是 Executors 工厂方法被禁用的原因之一，另一个是 CachedThreadPool 线程数无上限。两种分别对应堆 OOM 和线程耗尽 OOM。
4. **给选型落地**：生产用有界队列加自定义 ThreadFactory 加 CallerRunsPolicy 或落库重放，参数先按 CPU/IO 密集公式估，再靠监控调。

被追问时的几个高频点：

- 核心线程会不会被回收？默认不会，`allowCoreThreadTimeOut(true)` 且 keepAliveTime 大于 0 时会。
- CallerRunsPolicy 会不会丢任务？不会，任务在调用方线程执行，副作用是调用方被拖慢形成背压。
- DiscardOldestPolicy 丢谁？丢队首。配优先级队列时丢的是优先级最高的，慎用。
- shutdown 和 shutdownNow？前者不再收新任务但把队列里的跑完，后者中断 worker 并返回队列里没跑的任务。
- execute 和 submit 的区别？execute 只收 `Runnable`，异常会抛到 worker 线程；submit 收 `Runnable`/`Callable` 并返回 `Future`，任务里的异常被封进 `Future`，不调 `get()` 就永远看不到——线上"任务静默消失"有一半是这个坑。
- 参数能不能运行时改？能，`setCorePoolSize` 和 `setMaximumPoolSize` 都是运行时可调的方法，调大核心数时 JDK 会主动补建线程。美团的动态线程池方案本质上就是把这套 setter 接上配置中心，再配合监控告警，让参数调整不用发版。

背参数只能撑过第一轮，把"顺序 + 无界队列的坑 + 拒绝策略的真实行为"讲出细节，这道题才算答完。

## 参考

- [Java 11 ThreadPoolExecutor API](https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)
- [Java 11 Executors API](https://docs.oracle.com/en/java/javase/11/docs/api/java.base/java/util/concurrent/Executors.html)
- JDK 11.0.32.1 源码包中的 `java.base/java/util/concurrent/ThreadPoolExecutor.java`
- Brian Goetz 等《Java 并发编程实战》，第 8 章线程池的使用
