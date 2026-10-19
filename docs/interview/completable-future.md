---
title: "CompletableFuture 的异常和超时怎么处理？get/join、exceptionally/handle、orTimeout 一次实测"
description: "get/join、exceptionally/handle、orTimeout 一次实测：CompletableFuture 异常传递与超时处理的正确姿势。"
shortTitle: "CompletableFuture 异常与超时"
date: 2026-10-15
category:
  - 面经手册
tag:
  - Java
  - 并发
  - CompletableFuture
  - 超时
order: 4
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK，无第三方依赖
> 说明：文中的线程名、异常类型和耗时都是本机跑出来的真实输出。`orTimeout`/`completeOnTimeout` 从 JDK 9 起提供，本篇在 JDK 11 下验证。

**目录**

- 先给结论：链路上的三件事
- 每个阶段跑在哪个线程
- 异常怎么在链路上传播
- get() 和 join() 抛的异常不一样
- exceptionally 和 handle 的区别
- orTimeout：把慢任务变成失败任务
- 不传线程池会发生什么
- 写业务代码时的几条建议
- 边界
- 小结

## 先给结论：链路上的三件事

`CompletableFuture` 用起来顺手，坑大多集中在三个地方：

1. **阶段跑在哪个线程**：`thenApply` 这类"非 async"的阶段，跑在**完成上一个阶段的线程**里；只有 `*Async` 才保证提交到你指定的线程池。
2. **异常怎么传播**：某一环抛异常，它**后面依赖它的阶段会被直接跳过**，异常一路传到最后。取结果时 `get()` 包成 `ExecutionException`，`join()` 包成 `CompletionException`，两者不一样。
3. **超时怎么做**：`orTimeout` 到点让这个 future 以 `TimeoutException` **失败**，但它**不会打断**还在跑的那个任务。

下面逐条实测。

## 每个阶段跑在哪个线程

```java
CompletableFuture.supplyAsync(() -> { log("supplyAsync 返回 21"); return 21; }, pool)
        .thenApply(x -> { log("thenApply 翻倍"); return x * 2; })
        .thenApply(String::valueOf)
        .get();
```

```text
    [biz-pool] supplyAsync 返回 21
    [biz-pool] thenApply 翻倍
  结果 = 42
```

`thenApply` 跑在 `biz-pool` 上——它跟着上一个阶段所在的线程走。把中间换成 `thenApplyAsync`：

```text
    [biz-pool] supplyAsync 返回 1
    [biz-pool] thenApplyAsync 加 1
  结果 = 2
```

这里因为线程池就是 `biz-pool`，看起来一样；区别在于**语义**：非 async 的阶段"由完成者顺带执行"，如果上游在你调用它之前就已经完成了，非 async 阶段会**在你的调用线程里同步执行**；`thenApplyAsync` 则无论如何都丢到线程池。要做耗时的后续处理，用 `*Async` 并显式传线程池，行为才可预期。

## 异常怎么在链路上传播

```java
CompletableFuture<String> bad = CompletableFuture
        .supplyAsync(() -> { throw new IllegalStateException("下单接口超时"); }, pool)
        .thenApply(s -> { log("这里不会执行"); return s + "!"; });

try { bad.get(); }  catch (ExecutionException e) { /* ... */ }
try { bad.join(); } catch (CompletionException e) { /* ... */ }
```

```text
  get() 抛 ExecutionException，cause = java.lang.IllegalStateException: 下单接口超时
  join() 抛 CompletionException，cause = java.lang.IllegalStateException: 下单接口超时
```

注意 `"这里不会执行"` 那行没有打印：上游抛异常后，下游 `thenApply` 被**跳过**，异常直接传给终端操作。这是 CompletableFuture 的核心用法——**中间不必每个阶段都做异常处理，异常会自然流到最后的兜底那里**。

## get() 和 join() 抛的异常不一样

同样一个异常，两个取结果的方法给出的类型不同：

| 方法 | 异常类型 | 原因 | 特点 |
| --- | --- | --- | --- |
| `get()` | `ExecutionException` | 受检异常，包裹原始异常在 `cause` | 必须在方法上声明或 try/catch |
| `join()` | `CompletionException` | 非受检异常 | 不用 try/catch，适合 lambda 链 |
| `get(timeout, unit)` | 超时抛 `TimeoutException` | 是 `ExecutionException` 之外的独立类型 | 超时与失败能分开处理 |

需要区分"任务失败"和"等待超时"时，用 `get(timeout, unit)`：超时给 `TimeoutException`，任务自身失败仍是 `ExecutionException`。`join()` 更适合在链式代码里直接把异常往外抛。

## exceptionally 和 handle 的区别

```text
  exceptionally 结果 = exceptional 兜底: java.lang.RuntimeException: 库存服务不可用
  handle(正常) 结果 = handle 正常: 正常值
  handle(异常) 结果 = handle 兜底: java.lang.RuntimeException: 查询失败
```

区别在这：

- `exceptionally(fn)` 只在**上游失败**时执行，`fn` 收异常、返回一个**同类型的兜底值**；上游成功时它不做任何事。
- `handle(fn)` **成功失败都执行**，`fn` 收 `(结果, 异常)` 两个参数，二者必有一个为 null，返回一个新类型的值，可以顺手做类型转换。

结论：只是"失败时给个默认值"，用 `exceptionally`；既要处理成功结果又要处理异常（或要转换类型），用 `handle`。注意上面 `handle` 收到异常时，异常是**原始异常**（`java.lang.RuntimeException`），没有再被包一层——这点和 `get()`/`join()` 不同。

## orTimeout：把慢任务变成失败任务

```java
CompletableFuture.runAsync(() -> { sleep(2000); }, pool)
        .orTimeout(300, TimeUnit.MILLISECONDS);
```

```text
  等待 305 ms 后失败，cause = java.util.concurrent.TimeoutException
```

300ms 后 future 以 `TimeoutException` 结束，`get()` 只等了约 305ms 就抛了，没白等那 2 秒。**但有个关键点**：`orTimeout` 只是把 **future 标记为失败**，它**不会中断**那个还在睡 2000ms 的任务——任务线程照跑，只是结果被丢弃。要真正打断，得让任务本身响应中断（比如循环里检查 `Thread.interrupted()`），或者改用能取消的组合方式。

如果超时后想给个**默认值而不是失败**，用 `completeOnTimeout(defaultValue, time, unit)`；想区分"超时"和"业务失败"，`handle` 里判断异常类型即可。

## 不传线程池会发生什么

```text
    [ForkJoinPool.commonPool-worker-19] 默认线程池
```

不传线程池时，默认用的是 **`ForkJoinPool.commonPool()`**，线程名是 `commonPool-worker-N`。这有两个隐患：

- `commonPool` 的并行度约等于 `CPU 核心数 - 1`，而且**全 JVM 共享**。在上面跑阻塞的 IO 任务，会占满它，拖慢其他也在用它的代码。
- 一旦某个阻塞任务占住线程，你的异步就没并发可言了。

所以**给 IO 密集任务显式传自己的业务线程池**，是底线而不是优化。

## 写业务代码时的几条建议

- **异步任务一定传自己的线程池**，别用 `commonPool` 跑 IO。
- **终端统一处理异常**：链路上让异常自然传播，最后用 `exceptionally` 或 `handle` 兜底，不要每个阶段都 try/catch。
- **需要区分超时与失败就用 `get(timeout, unit)`**；只要"到点即失败"就用 `orTimeout`，但要清楚它不打断任务。
- **`allOf` 聚合多个任务时**，任一失败会导致整体失败，且 `allOf` 完成后各子任务的异常不会自动冒出来——要逐个 `handle` 收集。
- **不要在 Web 请求线程上无脑 `join()` 长时间任务**，那等于把异步改回了同步阻塞。

## 边界

- 线程名、耗时均为一次本机运行记录，不做性能基准；`orTimeout` 的"不打断底层任务"是 JDK 实现语义，可用任务里加中断检查来验证。
- 各阶段"跑在哪个线程"取决于上游完成时机，非 async 阶段可能落在调用线程，文章只说明了两种情况的语义，未逐一压测。
- `allOf` 的异常收集建议属于常见用法，未在本次实验里单独跑样例。

## 小结

- 非 async 阶段跟着"完成上一个阶段的线程"跑；要可预期用 `*Async` 并传自己的线程池。
- 中间阶段抛异常会被下游跳过，异常流到终端；`get()` 抛 `ExecutionException`，`join()` 抛 `CompletionException`。
- `exceptionally` 只兜失败的默认值，`handle` 成功失败都能处理并可转换类型。
- `orTimeout` 让 future 到点以 `TimeoutException` 失败，但不打断底层任务；要默认值用 `completeOnTimeout`。
- 不传线程池会落到全 JVM 共享的 `ForkJoinPool.commonPool`，跑阻塞任务要显式传业务线程池。
