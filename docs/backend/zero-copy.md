---
title: "什么是零拷贝？别被“零”字骗了：一次讲透完整链路"
shortTitle: "零拷贝"
date: 2026-10-03
category:
  - 存储与 IO
tag:
  - IO
  - 零拷贝
  - 操作系统
order: 6
---


> 实验环境：JDK 17.0.12、Windows 11、AMD Ryzen 7 7840H、16 GB 内存。文中的 Java 示例已在本地编译运行。实验只用于观察 API 差异，不代表所有操作系统都会走同一条零拷贝路径。

## 快速认识

很多人第一次听到“零拷贝”，会以为数据从磁盘到网卡完全没有复制。真正被优化掉的，通常是数据在内核空间和用户空间之间来回搬运的那几次 CPU 拷贝。

### 一句话结论

零拷贝（Zero-copy）是一类减少数据复制、减少 CPU 参与和减少用户态/内核态切换的优化技术的统称。它不等于整个链路零复制，更不等于换一个 API 就一定更快。

### 先记住这几点

- **传统文件转网络发送**通常要经过页缓存、用户缓冲区和 Socket 缓冲区，典型情况下有 4 次复制和 4 次上下文切换。
- **`sendfile`、`mmap + write`、`splice`** 优化的位置不同：有的去掉用户缓冲区，有的减少内核内复制，有的通过页引用传递数据。
- **Java 的 `FileChannel.transferTo()` 是提示，不是保证。** 操作系统可能走高效路径，也可能回退到普通读写循环；Windows 上的实现尤其不能直接等同于 Linux 的 `sendfile`。
- **零拷贝最适合大块、无需修改的数据搬运**，例如静态文件服务、日志传输和消息队列的磁盘到网络转发。如果还要加密、压缩、改字段，优势可能消失。

如果你只是想弄清楚“零”到底省掉了什么，到这里已经够了。下面继续拆传统路径、常见实现和本次 Java 实验。

## 拓展

### 1. 传统 `read + write` 到底复制了几次

假设一个进程把磁盘文件发送给客户端，代码通常写成：

```java
byte[] buffer = new byte[8192];
int length;
while ((length = input.read(buffer)) != -1) {
    output.write(buffer, 0, length);
}
```

在 Linux 的典型文件转 Socket 场景中，数据路径接近下面这样：

| 阶段 | 数据动作 | 谁在搬运 | 是否经过用户空间 |
| --- | --- | --- | --- |
| 1 | 磁盘到页缓存 | DMA | 否 |
| 2 | 页缓存到用户缓冲区 | CPU | 是 |
| 3 | 用户缓冲区到 Socket 缓冲区 | CPU | 是 |
| 4 | Socket 缓冲区到网卡 | DMA | 否 |

同时，`read()` 和 `write()` 各自涉及用户态与内核态切换。按这个模型计算，常见说法是“4 次复制、4 次上下文切换”。但具体次数会受到缓存命中、协议栈实现、网卡能力和操作系统版本影响，不能把它当成跨平台定律。

真正昂贵的部分不一定是“复制”三个字本身，而是：

1. CPU 要参与搬运，消耗内存带宽和时钟周期。
2. 用户缓冲区和内核缓冲区都要占内存。
3. 用户态和内核态频繁切换。
4. 大文件传输时，这些成本会随吞吐量放大。

### 2. 零拷贝的三条常见路线

#### `mmap + write`

`mmap` 把文件页映射到进程地址空间。应用拿到一块看似在用户空间的地址，实际访问时仍可能触发页错误并从页缓存取数据。

它的价值是省掉“页缓存到用户缓冲区”的显式复制，但调用 `write()` 时，数据仍可能要从页缓存进入 Socket 缓冲区。映射本身也有页表、缺页和 TLB 成本。

#### `sendfile`

Linux 的 `sendfile(2)` 可以在两个文件描述符之间传输数据。文件到 Socket 的典型路径中，用户态不再提供中间缓冲区。

在 Linux 2.4 及之后的内核和具备 scatter-gather DMA 能力的网卡上，Socket 缓冲区可以保存指向页缓存的描述信息，网卡再通过 DMA 从这些页收集数据。这样，内核页缓存到 Socket 缓冲区的那次 CPU 复制也可能被省掉。

这就是“零拷贝”最常见的语境：**用户空间不再参与复制，但磁盘、页缓存和网卡之间仍然可能发生数据移动。**

#### `splice`

`splice(2)` 通过管道在两个文件描述符之间移动数据，Linux 可以借助页引用减少复制。它常出现在代理、管道转发和对性能敏感的文件/网络链路中，但接口限制和平台差异也比较明显。

### 3. 三种路径放在一起比较

| 方案 | 是否经过用户缓冲区 | 主要省掉的动作 | 典型优势 | 主要限制 |
| --- | --- | --- | --- | --- |
| 传统 `read + write` | 是 | 无 | 通用、容易修改数据 | CPU 拷贝和上下文切换较多 |
| `mmap + write` | 否，使用映射 | 页缓存到用户缓冲区的复制 | 可按页访问文件 | 缺页、页表、TLB 成本；仍可能写入 Socket 缓冲区 |
| `sendfile` | 否 | 用户缓冲区往返；部分实现还省掉内核内复制 | 文件到 Socket 的高效转发 | 不适合边传边修改；平台语义有差异 |
| `splice` | 否 | 部分内核内复制 | 适合管道和特定 Linux 链路 | 依赖管道，接口和平台限制较多 |

这张表描述的是常见机制，不是所有实现都必须按表格发生。文件系统、内核版本、网卡、协议和是否启用 TLS 都会改变路径。

### 4. Java 里的零拷贝入口

Java 标准库没有提供一个名为 `ZeroCopy` 的类。更常见的入口是 `FileChannel`：

```java
public static long copyWithTransferTo(Path source, Path target) throws IOException {
    long start = System.nanoTime();
    try (FileChannel in = FileChannel.open(source, StandardOpenOption.READ);
         FileChannel out = FileChannel.open(
                 target,
                 StandardOpenOption.CREATE,
                 StandardOpenOption.TRUNCATE_EXISTING,
                 StandardOpenOption.WRITE)) {
        long position = 0;
        long size = in.size();
        while (position < size) {
            long transferred = in.transferTo(position, size - position, out);
            if (transferred <= 0) {
                throw new IOException("transferTo made no progress at position " + position);
            }
            position += transferred;
        }
    }
    return System.nanoTime() - start;
}
```

`transferTo()` 的关键点有三个：

1. 一次调用不保证传完全部字节，返回值可能小于请求长度。
2. 返回值可能是 `0`。循环里如果不断累加 `0`，就可能卡死，因此要显式检查是否取得进展。
3. 它“可能”让操作系统直接在文件系统缓存和目标通道之间传输数据，但 Java API 不承诺一定使用某一种内核机制。

另外，`MappedByteBuffer` 做的是内存映射，适合按页访问和随机读取；`transferTo()` 更适合顺序搬运。两者都可能减少用户态参与，但不能互相替代。

### 5. 本地实验：API 差异不是零拷贝证明

实验使用 64 MiB 文件，分别执行：

- `BufferedInputStream + BufferedOutputStream`
- `FileChannel.transferTo()`

本机四次运行结果如下：

| 次数 | 流复制 | `transferTo` |
| ---: | ---: | ---: |
| 1 | 163.23 ms | 85.06 ms |
| 2 | 137.99 ms | 83.21 ms |
| 3 | 149.49 ms | 89.43 ms |
| 4 | 136.00 ms | 76.86 ms |
| 5，加入零返回保护后 | 144.40 ms | 94.93 ms |

这组数据说明 `transferTo()` 在当前环境里减少了用户态循环和缓冲区搬运，整体更快。它不能证明：

- 每次 `transferTo()` 都走了 Linux `sendfile`。
- Windows 的实现与 Linux 完全相同。
- 在所有文件大小、缓存状态和机器上都保持同样比例。
- 性能差异全部来自“零拷贝”，磁盘缓存和 Java 调用路径也会影响结果。

要确认内核实际路径，需要在 Linux 上用 `strace`、`perf` 或系统跟踪工具观察系统调用和页复制行为；只看 Java 方法的耗时不够。

### 6. 最常见的 6 个误区

1. **零拷贝就是一次复制都没有。**  
   通常只是避免用户态与内核态之间的数据复制，DMA 和必要的内核内复制仍可能存在。

2. **`transferTo()` 保证零拷贝。**  
   Java 文档说的是“许多操作系统可以”直接传输，不是所有平台、所有调用都保证。

3. **零拷贝一定更快。**  
   小文件、页缓存已经命中、需要复杂转换时，额外抽象可能抵消收益。

4. **零拷贝可以顺便做 TLS 加密。**  
   数据要加密，就必须被读取和处理；除非使用内核 TLS 等专门能力，否则普通用户态 TLS 会重新引入数据访问。

5. **内存映射等于 `sendfile`。**  
   `mmap` 解决地址空间映射，重点在访问方式；`sendfile` 解决文件描述符之间的传输，重点在搬运路径。

6. **只在代码里写了一个高效 API，就等于系统已经优化。**  
   还需要确认文件是否命中页缓存、对象存储网络是否成为瓶颈、是否存在多余序列化，以及目标操作系统是否支持预期路径。

### 7. 项目里怎么选

可以先按数据是否需要修改来判断：

| 场景 | 优先考虑 | 原因 |
| --- | --- | --- |
| 静态文件、图片、日志原样发送 | `sendfile` 或 `FileChannel.transferTo()` | 数据不需要经过用户态处理 |
| 文件随机访问、按页处理 | `mmap` | 映射后可以按页读取 |
| 代理、管道、文件到网络转发 | `splice` 或成熟框架的零拷贝抽象 | 适合减少内核内搬运 |
| 发送前加密、压缩、改字段 | 普通缓冲区或流式处理 | 数据必须被读取和修改 |
| Kafka、Netty 等框架内部传输 | 使用框架提供的文件区域能力 | 先理解框架版本和平台行为，不自己伪造零拷贝 |

实际项目里，我建议先测量瓶颈。如果 CPU 拷贝和上下文切换不是主要耗时，先优化磁盘、网络、序列化或批量大小，通常更直接。

### 8. 面试可以继续追问什么

1. `read + write`、`sendfile` 和 `mmap + write` 分别省掉了哪一次复制？
2. `FileChannel.transferTo()` 为什么不能直接宣称“绝对零拷贝”？
3. Kafka、Netty 或 Web 服务器为什么喜欢文件到网络的零拷贝？启用 TLS 后会发生什么变化？

回答时先说“减少了哪一段路径”，再说“哪个条件不满足时会退化”，最后才谈性能。

### 总结

总结一下：

1. 零拷贝不是整个链路零复制，核心目标是减少 CPU 参与、用户态缓冲区往返和上下文切换。
2. `mmap`、`sendfile` 和 `splice` 解决的问题不同，不能用一句“系统调用更快”概括。
3. Java 的 `FileChannel.transferTo()` 可能利用操作系统的零拷贝能力，但 API 层不提供跨平台保证。
4. 当前本地实验中 `transferTo` 比流复制更快，但证据只适用于这台机器和这组数据，不能替代系统级跟踪。

如果让我做选择，我会先确认数据能否原样传输，再确认目标系统和框架是否支持高效路径。只有搬运成本确实是瓶颈，零拷贝才是值得优先处理的优化项。

### 参考

- [Java 17 `FileChannel`](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/nio/channels/FileChannel.html)
- [Linux `sendfile(2)`](https://man7.org/linux/man-pages/man2/sendfile.2.html)
- [Linux `mmap(2)`](https://man7.org/linux/man-pages/man2/mmap.2.html)
- [Linux `splice(2)`](https://man7.org/linux/man-pages/man2/splice.2.html)
