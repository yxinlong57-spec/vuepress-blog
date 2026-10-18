---
title: "Java 堆 OOM 怎么复现又怎么定位？从 HeapDumpOnOutOfMemoryError 到 jmap -histo:live"
shortTitle: "Java 堆 OOM 定位"
date: 2026-10-16
category:
  - 面经手册
tag:
  - JVM
  - OOM
  - jmap
  - Heap Dump
order: 5
---


> 环境：Windows 11、OpenJDK 11.0.32.1（Temurin），纯 JDK，无第三方依赖，用 JDK 自带的 `jmap`
> 说明：文中 PID、堆占用、OOM 消息和 heap dump 都是本机跑出来的真实输出；为演示把堆限制在 96MB / 256MB，生产上的数字不同，但排查路径一致。

**目录**

- 先给结论：OOM 要分"复现"和"定位"两步
- 复现：把堆限小，用强引用一直累加
- 定位一：进程还活着时用 jmap -histo:live
- 怎么读 jmap 直方图
- 定位二：让 OOM 自己留下现场（heap dump）
- 从"哪个类最多"到"哪段代码在泄漏"
- OOM 的常规排查顺序
- 边界
- 小结

## 先给结论：OOM 要分"复现"和"定位"两步

遇到 `java.lang.OutOfMemoryError: Java heap space`，光看报错那一行没用——它只告诉你"堆用完了"，不告诉你是谁在用。我的做法固定成两步：

1. **复现**：把堆限制到一个小值（`-Xmx`），用强引用持续累积对象，直到堆耗尽。可控、可重复。
2. **定位**：进程活着时用 `jmap -histo:live` 看"哪个类型的对象占的字节最多"；同时用 `-XX:+HeapDumpOnOutOfMemoryError` 存下堆快照，进一步用 MAT 之类的工具看引用链。

下面把两步都跑一遍，用真实输出说明每一行在看什么。

## 复现：把堆限小，用强引用一直累加

程序很简单：先强引用挂住一批 1MB 数组，再不停地加，直到抛 OOM。

```java
static final List<byte[]> HOLD = new ArrayList<>();

for (int i = 0; i < holdMb; i++) HOLD.add(new byte[1024 * 1024]);   // 先占住一部分
// ...（此处留出存活窗口，供 jmap 观察）
while (true) HOLD.add(new byte[1024 * 1024]);                        // 一直加，直到堆耗尽
```

用 `-Xmx96m` 运行：

```text
最大堆 -Xmx = 96 MB
已强引用占用约 20 MB，当前堆 used = 43 MB
继续分配，直到堆耗尽 ...
  已追加 10 MB，used = 61 MB
  已追加 20 MB，used = 81 MB
java.lang.OutOfMemoryError: Java heap space
Dumping heap to ...\oom-heap.hprof ...
Heap dump file created [52087339 bytes in 0.045 secs]
捕获 java.lang.OutOfMemoryError: Java heap space
累计追加 27 MB 后堆耗尽。
```

两个细节值得留意：

- **"used 43MB" 就敢报 96MB 堆的 OOM**。堆里不止有 `HOLD` 的 20MB，还有 JVM 自身、字符串常量、类元数据之外各类临时对象；G1 在大对象（1MB 数组是 humongous 对象）和碎片上更早触顶，所以**"used 远小于 max 却 OOM"是常事**，不能拿 `used/max` 反推"还有多少余量"。
- 我 catch 了 OOM 只为打印这行继续输出；**真实代码不该 catch OOM**，那时 JVM 状态已不可靠，正确的做法是让它崩、让 `-XX:+HeapDumpOnOutOfMemoryError` 留下现场。

## 定位一：进程还活着时用 jmap -histo:live

换一个"占住内存但保持存活"的运行（`-Xmx256m`，先占 120MB，然后 `holdMs<=0` 时进程常驻），在另一个窗口执行：

```text
num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:          3524      126044344  [B (java.base@11.0.32.1)
   2:           141         143048  [C (java.base@11.0.32.1)
   3:           980         119136  java.lang.Class (java.base@11.0.32.1)
   4:          2010         108632  [Ljava.lang.Object; (java.base@11.0.32.1)
   5:          3274          78576  java.lang.String (java.base@11.0.32.1)
```

第一行就是答案：`[B` 有 3524 个实例、合计 **126 044 344 字节（约 120MB）**，占了压倒性的多数。`[B` 是 `byte[]`，正好对应程序里的 `new byte[1024*1024]`。

几个命令上的注意：

- `jmap -histo:live <pid>` 带 `:live` 会**先触发一次 Full GC（Stop-The-World）**，只统计存活对象——数据更准，但会卡住进程。生产上先用不带 `:live` 的 `jmap -histo` 看一眼（不触发 GC），确认后再谨慎使用带 `:live` 的版本。
- 直方图按 **bytes 降序**排，所以第一行通常就是"谁在吃内存"；**别只看 #instances 那一列**，小对象数量多不代表占用大。
- 同一份信息也可以用 `jcmd <pid> GC.class_histogram` 拿，效果类似。

## 怎么读 jmap 直方图

直方图里的类名是 JVM 内部签名，不认这些前缀就容易看漏：

| 签名 | 对应类型 | 说明 |
| --- | --- | --- |
| `[B` | `byte[]` | 字节数组，缓存、序列化缓冲、文件读写的常客 |
| `[C` | `char[]` | 字符数组，`String` 的底层存放 |
| `[I` | `int[]` | 整型数组 |
| `[Ljava.lang.Object;` | `Object[]` | 对象数组，集合的底层 |
| `java.util.HashMap$Node` | HashMap 的桶节点 | 数量暴涨常意味着 map 在无限增长 |

拿到"是 `byte[]` 占大头"之后，还要回答下一个问题：**这些 byte[] 是谁的**。直方图只给类型分布，给不出引用链——所以需要 heap dump。

## 定位二：让 OOM 自己留下现场（heap dump）

在启动参数里加上：

```text
java -Xmx96m -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=D:\dump\heap.hprof -cp . OomDemo
```

OOM 触发时 JVM 会自动把整个堆写到 `heap.hprof`：

```text
java.lang.OutOfMemoryError: Java heap space
Dumping heap to ...\oom-heap.hprof ...
Heap dump file created [52087339 bytes in 0.045 secs]
```

96MB 的堆写出了约 49.7MB 的 dump 文件（比 max 小，因为 dump 的是**存活对象**，不含已经被回收的部分）。拿到这个文件，就可以用 MAT（Eclipse Memory Analyzer）打开：看 **Dominator Tree** 找"实际占内存最多的对象"，再用 **Path to GC Roots** 看"到底谁在强引用它，为什么回收不掉"。这一步才是把"byte[] 占了 120MB"追到"某张缓存 map 无限增长"的关键。

生产环境建议常年开着 `-XX:+HeapDumpOnOutOfMemoryError`（注意配 `-XX:HeapDumpPath` 到一个有空间、可落盘的目录），出事那一刻的现场比事后重启值钱得多。

## 从"哪个类最多"到"哪段代码在泄漏"

演示里 OOM 的源头一眼可见（就一个 `HOLD` 列表）。真实系统里，定位一般是这条链路：

1. 直方图锁定"哪个类型占最多字节"（比如 `[B` 或某个业务类）。
2. 打开 heap dump，用 Dominator Tree 找最大的支配对象，确认是集合、缓存、还是某个大对象。
3. Path to GC Roots 看引用链：是静态集合、ThreadLocal、还是监听器没摘。
4. 回到代码找对应的数据结构，核对"只增不减"的地方。
5. 修完再压测复现，确认 `used` 能在长时间运行后回落。

这份流程对"内存泄漏"（对象持续增长不释放）和"内存溢出"（一次性申请过大）都适用，区别只在第 4 步是改数据结构还是改单次分配的规模。

## OOM 的常规排查顺序

- 先看报错**具体是哪种** OOM：`Java heap space`（堆）、`GC overhead limit exceeded`（回收太慢）、`Metaspace`（元空间/类太多）、`unable to create new native thread`（线程太多/栈太大）、`Direct buffer memory`（堆外直接内存）。类型不同，方向完全不同。
- 判断是堆内还是堆外：`jstat -gcutil <pid>` 看堆内各区；堆外内存要看 NMT（`-XX:NativeMemoryTracking=summary` + `jcmd <pid> VM.native_memory`）。
- 判断是"泄漏"还是"峰值"：长时间运行 `used` 只涨不跌 → 泄漏；周期性峰值冲高后回落 → 容量或瞬时压力问题，先调容量或限流。

## 边界

- `jmap -histo:live` 会 STW，生产上要权衡；本文在本地进程上执行，没有延迟敏感性。
- 直方图只给类型分布，**给不出引用链**；要追"谁在引用"必须靠 heap dump + MAT（本文只生成了 dump，没有在文章里展开 MAT 界面）。
- 文章用的是 `byte[]` 这种最直白的大对象；真实泄漏对象往往是业务类，`[B` 只是它的底层载体，需要顺着引用链找。
- 96MB/256MB 是小堆演示，`used 远小于 max 就 OOM` 的现象在大堆上可能减弱，但思路不变。

## 小结

- OOM 要分两步：**复现**（限小堆 + 强引用累积）和**定位**（先看类型分布，再追引用链）。
- `jmap -histo:live <pid>` 能直接指出"谁占的字节最多"，实测第一行是 `[B` 120MB；带 `:live` 会 STW，生产慎用。
- 直方图里的 `[B`/`[C`/`[I`/`[Ljava.lang.Object;` 分别是 byte[]/char[]/int[]/Object[]。
- 加 `-XX:+HeapDumpOnOutOfMemoryError` 能在 OOM 瞬间留下 heap dump，配合 MAT 才能回答"这些对象被谁引用、为什么回收不掉"。
- `used` 远小于 `-Xmx` 也可能 OOM，不要用占用比例反推余量；先确认 OOM 的具体类型再决定方向。
