---
title: "ThreadLocal 在线程池里为什么会串数据？一次复现看懂复用和内存泄漏"
shortTitle: "ThreadLocal 与线程池"
date: 2026-10-15
category:
  - 面经手册
tag:
  - Java
  - 并发
  - ThreadLocal
  - 线程池
order: 3
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK，用反射查看线程内部的 ThreadLocalMap
> 说明：演示用一个单线程池保证多个任务落在同一线程上。反射查看 `Thread.threadLocals` 在 JDK 11 会有"illegal reflective access"警告，属预期现象；结论只针对本机实测。

**目录**

- 先给结论：值到底存在哪里
- 复现一：复用同一线程，读到上一个任务的值
- 复现二：key 被回收，value 还挂在原地
- 为什么 Entry 的 key 用弱引用，value 却是强引用
- 为什么"惰性清理"救不了线程池
- 正确做法：try/finally 里 remove
- 常见误区
- 边界
- 小结

## 先给结论：值到底存在哪里

多数人以为 `ThreadLocal` 像一个 `Map`，key 是线程、value 是值。实际正好相反：**值存在线程自己身上**。

- 每个 `Thread` 内部有一个 `ThreadLocalMap` 字段（名字叫 `threadLocals`）。
- 这个 map 的每个 Entry，**key 是 `ThreadLocal` 对象本身（弱引用）**，**value 才是你 `set` 进去的值（强引用）**。
- `ThreadLocal.get()/set()` 做的事，是"拿到当前线程的 map，再以 `this`（这个 ThreadLocal 对象）为 key 存取"。

所以"数据隔离"靠的是**每个线程一份 map**，而不是 ThreadLocal 里存了什么。线程是长期的、被池子复用的，map 就跟着长期存在——这正是串用和泄漏的根源。

## 复现一：复用同一线程，读到上一个任务的值

用单线程池提交两个任务：任务一设置 `user`，任务二什么都不设，直接读。

```java
ThreadLocal<String> user = new ThreadLocal<>();

pool.submit(() -> {                       // 任务一
    user.set("用户A(uid=1001)");
    // 结束时没有 remove
}).get();

pool.submit(() -> {                       // 任务二，复用同一线程
    System.out.println("读到 user = " + user.get());
}).get();
```

实测输出：

```text
[任务1] biz-worker-1 设置 user = 用户A(uid=1001)
[任务2] biz-worker-1 读到 user = 用户A(uid=1001)   <- 这就是串用
```

任务二**什么都没设置**，却读到了任务一的 `用户A(uid=1001)`。因为两个任务跑在同一个 `biz-worker-1` 线程上，而这个线程的 `ThreadLocalMap` 里还留着任务一写入的 Entry。任务二拿到的是**上一个请求残留的身份信息**——在 Web 应用里，这就是"用户 A 的请求里看到了用户 B 的数据"这类事故的典型成因。

## 复现二：key 被回收，value 还挂在原地

串用还算看得见，泄漏更隐蔽。我用反射把 worker 线程的 `ThreadLocalMap` 打开看：先是任务一留下的那条 Entry，然后在一个方法里临时建一个 `ThreadLocal`、`set` 进 1MB 的数组、方法返回后外层不再引用它：

```text
== 反射查看 worker 线程的 ThreadLocalMap ==
  table 长度 = 16，已占用槽位 = 1
    entry: key=java.lang.ThreadLocal@6956de9 , value=用户A(uid=1001)

== 让 key 变 null：value 还在，就构成泄漏 ==
  table 长度 = 16，已占用槽位 = 2
    entry: key=java.lang.ThreadLocal@6956de9 , value=用户A(uid=1001)
    entry: key=null(已被回收) , value=1048576 bytes
```

方法返回后，那个临时 `ThreadLocal` 对象不再被任何地方引用，被 GC 回收了——所以第二条 Entry 的 `key` 变成了 `null(已被回收)`。**可它的 `value`（1MB 数组）还在**，被 Entry 强引用着，而这个 Entry 又被线程的 map 强引用，线程又被线程池强引用。于是这 1MB 在池子还活着的期间都回收不掉。

真实业务里不是 1MB 数组，而是每次请求 set 的上下文对象、`SimpleDateFormat`、用户 session 之类。每个"用完不 remove"的 ThreadLocal，都会在线程的 map 里慢慢攒下一条永不释放的 Entry。

## 为什么 Entry 的 key 用弱引用，value 却是强引用

这是 JDK 里一个刻意的取舍：

- **key 用弱引用**：这样当业务代码不再持有这个 `ThreadLocal` 对象时，它不会因为"被线程的 map 引用着"而永远回收不掉。
- **value 用强引用**：`set` 进去的值本身可能很大，如果也用弱引用，业务代码只要没有别处引用就会被立刻清掉，不符合"我 set 了就得能 get 到"的直觉。

两个选择各自合理，合在一起就埋下一个洞：**key 没了，但 value 还在**，形成一条"key=null 却 value 非空"的僵尸 Entry。这类 Entry 只有等到下一次对该 map 的 `set`/`get`/`remove` 触发清理，或者 map 扩容时 `cleanSomeSlots` 顺带扫到，才会被清掉。

## 为什么"惰性清理"救不了线程池

既然有惰性清理，是不是放着不管也会被回收？在线程池场景下指望不上：

1. 清理是**触发式**的。如果这个线程之后再也不 `set`/`get` 那个 map，僵尸 Entry 就一直躺着。
2. 线程池的线程**长期存活**，map 不会随线程结束而释放。线程不结束，泄漏就不结束。
3. 即便某次操作触发清理，也是**顺带扫一部分槽位**，不保证当下就清干净。

所以"最终会被 GC 清理"对于**长生命周期的池化线程**基本不成立。唯一可靠的办法是自己 `remove`。

## 正确做法：try/finally 里 remove

给每个用到 ThreadLocal 的任务都套上 `try/finally`：

```java
pool.submit(() -> {
    user.set("用户A(uid=1001)");
    try {
        // 使用 user 的业务逻辑
    } finally {
        user.remove();          // 关键：任务结束前清理，把 value 置空并从 map 移除
    }
}).get();
```

`remove()` 做两件事：把当前线程 map 里这个 key 对应的 Entry 的 **value 置为 null**，并**移除这个 Entry**。它清理的就是"当前线程"上的这份数据；下一份任务再进来时，读到的就是干净的状态。

在 Web 场景里，这通常交给框架统一处理：Spring 的 `RequestContextHolder`、事务同步、MDC 日志上下文，都在请求结束时清理。**自己手写 ThreadLocal 时，就要自己负责这对 set/remove 的配对**。

## 常见误区

1. **"线程池会自动帮我清理"**。不会。线程复用是目的，残留是副作用，清理责任在使用方。
2. **"只要线程结束就会释放，泄漏无所谓"**。线程池的线程不结束，泄漏就一直累积。
3. **"用了 `InheritableThreadLocal` 就没问题"**。它只在**线程创建**时把值传给子线程，线程池的线程是复用的，不会为每个任务重新创建，所以同样会串用，也同样是持续的。线程池场景要传上下文，应显式作为参数传递，而不是靠线程继承。
4. **"key 是弱引用 = 不会泄漏"**。key 会被回收恰恰是 value 滞留的原因，弱引用解决的是 key 这一侧，不是 value。

## 边界

- 反射读 `Thread.threadLocals` 在 JDK 11 只是警告；JDK 16+ 因强封装，反射访问 `java.lang.Thread` 的字段需要 `--add-opens java.base/java.lang=ALL-UNNAMED`，生产代码不应依赖这种反射，本文只是用来"证明现象"。
- 文中 `table 长度 = 16` 是 map 的初始容量，不代表泄漏规模；泄漏规模要用连续任务下 `table` 的槽位增长来观察。
- 我展示的是手动 `remove` 的最小修法；是否需要包装成 `AutoCloseable`、是否用 `TransmittableThreadLocal` 解决跨线程传递，取决于业务，不属于本篇范围。

## 小结

- ThreadLocal 的值存在**线程自己**的 `ThreadLocalMap` 里，`key` 是 ThreadLocal（弱引用），`value` 是值（强引用）。
- 线程池复用线程，任务不清理就会**串用**：实测任务二读到了任务一设的 `用户A(uid=1001)`。
- ThreadLocal 对象被回收后，`key=null` 但 `value` 仍被 Entry 强引用，实测 1MB 数组无法释放，构成泄漏。
- 可靠修法是 `try/finally { threadLocal.remove(); }`，惰性清理对长期存活的池化线程靠不住。
