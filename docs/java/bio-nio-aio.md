---
title: "BIO、NIO、AIO 到底差在哪？从阻塞方式到代码模型一次理清"
description: "从阻塞方式到代码模型一次理清 BIO、NIO、AIO：最小 TCP 回显示例对比三种 IO 的线程模型与适用场景。"
shortTitle: "BIO / NIO / AIO"
date: 2026-10-02
category:
  - Java 基础
tag:
  - Java
  - 网络编程
  - BIO
  - NIO
  - AIO
order: 4
---


> 示例环境：JDK 17.0.12，Windows 11。三个 TCP 回显示例只使用 JDK 标准库，均已在本地完成编译和回显验证。

很多人第一次背 BIO、NIO、AIO，记住的是三句话：

> BIO 一连接一线程，NIO 用一个线程处理多个连接，AIO 是异步的，所以 AIO 最快。

这三句话有对有错。它们描述了三种常见使用方式，却把不同层面的概念混在了一起。

先给结论：

- **BIO** 的典型模式，是一个线程在 `accept`、`read` 或 `write` 上等待到操作完成。
- **NIO** 的核心，是通过 `Channel`、`Buffer` 和 `Selector` 获取一批连接的“就绪事件”，再用少量线程处理事件。
- **AIO** 的核心，是提交 I/O 请求后立即返回，操作完成时由回调或 `Future` 通知应用。

它们不是“旧、新、更新”的简单替换，也没有脱离场景的绝对性能排名。下面先把术语拆开，再看三套最小代码。

## 一、阻塞和同步，说的不是一回事

理解三种模型前，必须先分清两组词。

| 维度 | 它回答的问题 | 典型判断方式 |
| --- | --- | --- |
| 阻塞与非阻塞 | 调用线程会不会一直等结果 | 方法是否会占住当前线程 |
| 同步与异步 | 调用方怎样获得最终结果 | 当前调用直接返回结果，还是稍后收到完成通知 |

**阻塞 I/O（Blocking I/O）** 的调用线程会停在原地，直到操作完成或失败。例如 `InputStream.read()` 没有读到数据时，调用线程通常会等待。

**非阻塞 I/O（Non-blocking I/O）** 在操作暂时无法完成时会立即返回。例如非阻塞 `SocketChannel.read()` 暂时没有数据时可以返回 `0`，由调用方决定下一步做什么。

**同步 I/O（Synchronous I/O）** 强调调用方参与结果获取。它可能一直等待，也可能轮询或选择就绪事件，但最终结果由当前调用链路处理。

**异步 I/O（Asynchronous I/O）** 提交请求后，调用方不站在旁边等数据搬运完成。系统在操作完成后调用回调，或者让 `Future` 进入完成状态。

所以会出现两个容易混淆的事实：

1. NIO 中的 `Selector.select()` 本身可以阻塞，但 `read()` 和 `write()` 通常以非阻塞方式处理已经就绪的连接。
2. AIO 看起来没有阻塞，不代表系统里没有线程。操作系统或 JDK 仍然要安排线程、事件或内核机制搬运数据，只是这部分不由业务线程直接等待。

一句话概括就是：**阻塞与非阻塞看“线程是不是卡在这里”，同步与异步看“最终结果怎样回到调用方”。**

## 二、BIO：一个线程跟着一次 I/O 走

BIO 通常指传统 `java.io` 流模型，以及基于 `ServerSocket`、`Socket` 的经典网络编程方式。

它最直接的写法是：

1. 主线程在 `ServerSocket.accept()` 等待新连接。
2. 每接收一个连接，把连接交给一个线程或线程池任务。
3. 处理线程在 `read()` 上等待数据，读完后调用 `write()` 回写。

下面的服务端会把客户端发送的内容原样返回：

```java
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class BioEchoServer {
    private static final int PORT = 9001;

    public static void main(String[] args) throws IOException {
        ExecutorService workers = Executors.newFixedThreadPool(10);
        try (ServerSocket server = new ServerSocket(PORT)) {
            System.out.println("BIO echo server listening on " + PORT);
            while (true) {
                Socket socket = server.accept();
                workers.submit(() -> handle(socket));
            }
        } finally {
            workers.shutdown();
        }
    }

    private static void handle(Socket socket) {
        try (socket;
             InputStream in = socket.getInputStream();
             OutputStream out = socket.getOutputStream()) {
            byte[] buffer = new byte[1024];
            int length;
            while ((length = in.read(buffer)) != -1) {
                out.write(buffer, 0, length);
                out.flush();
            }
        } catch (IOException e) {
            System.err.println("BIO connection error: " + e.getMessage());
        }
    }
}
```

这里有两个等待点：

- `server.accept()` 等新连接。
- `in.read(buffer)` 等客户端发数据。

使用固定大小线程池时，正在处理的连接数受线程数限制。连接大量存在但多数时间没有数据时，线程会停在 `read()` 上，内存和线程切换成本都会增加。

BIO 的优点是代码直观、调试简单、顺序逻辑容易理解。连接数量不多，或者请求处理时间较短时，它并没有什么问题。

## 三、NIO：用一个 Selector 看一批连接是否就绪

Java NIO 的核心抽象不是单一的“非阻塞”，而是三件套：

- `Channel`：双向数据通道。
- `Buffer`：读写数据时使用的缓冲区。
- `Selector`：集中观察多个通道的事件。

`Selector` 关心的不是“这个连接已经完成了整段业务”，而是通道是否出现了可接受、可读、可写等事件。应用线程拿到就绪事件后，再去执行实际读写。

下面是一个最小 NIO 回显服务：

```java
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SelectionKey;
import java.nio.channels.Selector;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.util.Iterator;

public class NioEchoServer {
    private static final int PORT = 9002;

    public static void main(String[] args) throws IOException {
        try (ServerSocketChannel server = ServerSocketChannel.open();
             Selector selector = Selector.open()) {
            server.bind(new InetSocketAddress(PORT));
            server.configureBlocking(false);
            server.register(selector, SelectionKey.OP_ACCEPT);
            System.out.println("NIO echo server listening on " + PORT);

            ByteBuffer buffer = ByteBuffer.allocate(1024);
            while (true) {
                selector.select();
                Iterator<SelectionKey> keys = selector.selectedKeys().iterator();
                while (keys.hasNext()) {
                    SelectionKey key = keys.next();
                    keys.remove();
                    if (!key.isValid()) {
                        continue;
                    }
                    if (key.isAcceptable()) {
                        accept(server, selector);
                    } else if (key.isReadable()) {
                        read((SocketChannel) key.channel(), buffer);
                    }
                }
            }
        }
    }

    private static void accept(ServerSocketChannel server, Selector selector) throws IOException {
        SocketChannel client = server.accept();
        if (client == null) {
            return;
        }
        client.configureBlocking(false);
        client.register(selector, SelectionKey.OP_READ);
    }

    private static void read(SocketChannel client, ByteBuffer buffer) {
        buffer.clear();
        try {
            int length = client.read(buffer);
            if (length == -1) {
                client.close();
                return;
            }
            if (length == 0) {
                return;
            }

            buffer.flip();
            while (buffer.hasRemaining()) {
                if (client.write(buffer) == 0) {
                    throw new IOException("outbound buffer is full");
                }
            }
        } catch (IOException e) {
            System.err.println("NIO connection error: " + e.getMessage());
            close(client);
        }
    }

    private static void close(SocketChannel client) {
        try {
            client.close();
        } catch (IOException ignored) {
        }
    }
}
```

这段代码的关键不在 `while (true)`，而在 `selector.select()`。

连接建立后，服务端把它注册为 `OP_READ`。只有当某个通道出现可读事件时，代码才会调用对应连接的 `read()`。于是一个事件循环线程可以观察大量连接，而不需要为每个空闲连接保留一个等待线程。

不过，NIO 也带来了更多状态：

- 一次 `read()` 不一定恰好读到一条完整业务消息，需要自己处理半包和粘包。
- 一次 `write()` 也不一定把缓冲区全部写完，生产实现通常要为连接维护待写队列和 `OP_WRITE`。
- 编码器、解码器、心跳、超时、断线重连和背压，都需要业务层或框架层处理。

因此，NIO 的收益主要是“少量线程管理大量连接”，代价是编程和状态管理复杂度更高。

## 四、AIO：提交请求，完成后再回调

AIO 是日常交流中的叫法，在 Java 中对应 NIO.2 提供的异步通道，例如：

- `AsynchronousServerSocketChannel`
- `AsynchronousSocketChannel`
- `AsynchronousFileChannel`

这些类位于 `java.nio.channels`，并没有一个叫作 `java.aio` 的包。理解 AIO 时，应该抓住“操作完成通知”，不要把类名和某个固定内核实现绑死。

异步通道有两种取结果方式：`Future` 和 `CompletionHandler`。下面的服务使用回调，连续读取客户端数据并回写：

```java
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousServerSocketChannel;
import java.nio.channels.AsynchronousSocketChannel;
import java.nio.channels.CompletionHandler;

public class AioEchoServer {
    private static final int PORT = 9003;
    private static final int BUFFER_SIZE = 1024;

    public static void main(String[] args) throws IOException, InterruptedException {
        AsynchronousServerSocketChannel server = AsynchronousServerSocketChannel.open();
        server.bind(new InetSocketAddress(PORT));
        System.out.println("AIO echo server listening on " + PORT);
        acceptNext(server);
        Thread.currentThread().join();
    }

    private static void acceptNext(AsynchronousServerSocketChannel server) {
        server.accept(null, new CompletionHandler<AsynchronousSocketChannel, Void>() {
            @Override
            public void completed(AsynchronousSocketChannel client, Void attachment) {
                acceptNext(server);
                readNext(client, ByteBuffer.allocate(BUFFER_SIZE));
            }

            @Override
            public void failed(Throwable error, Void attachment) {
                error.printStackTrace();
            }
        });
    }

    private static void readNext(AsynchronousSocketChannel client, ByteBuffer buffer) {
        buffer.clear();
        client.read(buffer, buffer, new CompletionHandler<Integer, ByteBuffer>() {
            @Override
            public void completed(Integer length, ByteBuffer data) {
                if (length < 0) {
                    close(client);
                    return;
                }
                if (length == 0) {
                    readNext(client, data);
                    return;
                }

                data.flip();
                writeFully(client, data);
            }

            @Override
            public void failed(Throwable error, ByteBuffer data) {
                close(client);
            }
        });
    }

    private static void writeFully(AsynchronousSocketChannel client, ByteBuffer buffer) {
        client.write(buffer, buffer, new CompletionHandler<Integer, ByteBuffer>() {
            @Override
            public void completed(Integer written, ByteBuffer data) {
                if (data.hasRemaining()) {
                    writeFully(client, data);
                } else {
                    readNext(client, ByteBuffer.allocate(BUFFER_SIZE));
                }
            }

            @Override
            public void failed(Throwable error, ByteBuffer data) {
                close(client);
            }
        });
    }

    private static void close(AsynchronousSocketChannel client) {
        try {
            client.close();
        } catch (IOException ignored) {
        }
    }
}
```

三个类放入 `src` 目录后，可以用下面的命令编译和启动其中一个服务：

```powershell
javac -encoding UTF-8 -Xlint:all -d out src\*.java
java -cp out BioEchoServer
```

把类名依次换成 `NioEchoServer` 和 `AioEchoServer`，端口分别为 `9002` 和 `9003`。本机客户端发送 `hello` 后，三种服务都返回 `hello`。

这里的 `accept`、`read` 和 `write` 都会立即返回一个待完成的操作。完成后，JDK 在相应的线程上下文中回调 `completed`，失败时回调 `failed`。

从业务代码看，等待被移除了；从整个系统看，线程、事件循环或内核异步机制仍然存在。

此外，AIO 的底层实现与操作系统和 JDK 实现有关。Windows 的异步 I/O 可以依托 IOCP 等完成机制；在部分 Unix/Linux 平台上，socket 异步通道也可能由 JDK 内部的事件和线程机制支撑。**API 层是异步的，不代表所有平台都使用完全相同的内核异步 I/O 路径。**

## 五、把三种模型放在一张表里

| 维度 | BIO | NIO | AIO |
| --- | --- | --- | --- |
| 核心抽象 | 流、Socket | Channel、Buffer、Selector | 异步 Channel、回调、Future |
| 等待位置 | 当前线程等待一次 I/O 完成 | Selector 等待一批连接就绪 | 调用立即返回，完成后通知 |
| 编程模型 | 同步阻塞为主 | 同步非阻塞、I/O 多路复用为主 | 异步完成通知 |
| 常见线程模型 | 一连接一线程或线程池 | 少量事件线程加工作线程 | 回调线程或异步线程池 |
| 代码复杂度 | 低 | 较高 | 较高，且回调链路更分散 |
| 典型场景 | 连接少、逻辑简单 | 大量空闲连接、长连接服务 | 支持良好的异步文件或网络场景 |
| 主要风险 | 线程数量和上下文切换 | 半包、背压和状态管理 | 平台差异、调试和生态成熟度 |
| 常见框架或机制 | Servlet 阻塞模型、普通 Socket | Netty、Selector、epoll | NIO.2 异步通道、IOCP |

需要注意，表格描述的是典型模型，不是语言级规则。

“一连接一线程”是 BIO 最常见的组织方式，不代表所有 BIO 代码都必须这样做；NIO 也不需要每个项目都手写 `Selector`，Netty 等框架会封装事件循环和缓冲区管理。

## 六、几个常见误区

### 1. NIO 一定比 BIO 快吗？

不一定。连接少、消息处理简单时，BIO 的线程模型更直观，额外抽象更少。NIO 的优势通常出现在连接多、连接活跃度不均衡、需要长连接复用的场景。

“更快”至少涉及吞吐量、延迟、连接规模和资源占用，不能只根据 API 类型下结论。

### 2. 非阻塞就是一次调用立刻完成吗？

不是。非阻塞只表示暂时做不了时不会把线程一直占住。`Selector.select()` 仍会等待事件；`read()` 返回 `0` 也只表示当前没有读到数据。

### 3. AIO 一定优于 NIO 吗？

不一定。异步 API 可以减少业务线程的等待，但会引入回调拆分、上下文传递、资源生命周期和平台差异。一个模型是否合适，取决于操作系统支持、协议复杂度、团队维护方式和框架生态。

### 4. 用了 Netty，就等于直接使用 NIO 吗？

不能这样简单等同。Netty 建立在 Java NIO 等能力之上，同时封装了事件循环、`ByteBuf`、编解码器、连接管理和背压。业务开发面对的是框架抽象，不是裸 `Selector`。

### 5. 异步模型没有线程吗？

有。异步减少的是业务调用线程的等待，并不消灭数据搬运和事件处理所需的工作。理解资源成本时，应看整个 JDK、操作系统或框架的线程和事件模型。

## 七、实际项目里怎么选

可以先按下面的顺序判断：

1. **连接数少、协议简单、希望快速上线**：优先使用 BIO 或现成的阻塞式框架。
2. **连接数多、长连接多、空闲连接占比高**：考虑 NIO，并优先评估 Netty 等成熟框架。
3. **已有平台强依赖完成通知，且文件或网络操作适合异步化**：可以评估 AIO，但要先验证目标操作系统、JDK 版本和现有框架的支持情况。
4. **普通 Web 业务**：通常不需要手写 I/O 模型。先看 Spring MVC、WebFlux、Tomcat、Netty 或公司基础框架已经提供了什么。

我会把选择标准概括成四个问题：

- 同时存在多少连接，其中多少连接经常活跃？
- 业务逻辑是短请求，还是长连接上的持续事件？
- 团队能否维护非阻塞状态机或异步回调链路？
- 目标平台和框架是否已经验证过对应的 I/O 模型？

如果答案还不清楚，不要先追求“更高级”的模型。先写清楚协议和连接行为，再做压测和资源观察。

## 八、面试可以继续追问什么

准备面试时，可以沿着下面三个方向继续深挖：

1. `select`、`poll` 和 `epoll` 在事件通知方式上有什么差异？
2. 为什么 Netty 在高并发网络服务中常用 NIO 风格的事件循环，而不是把所有业务都交给 AIO 回调？
3. Java AIO 的 `Future` 和 `CompletionHandler` 各适合怎样的调用链？回调中为什么不能随意阻塞？

回答时先讲线程模型和资源边界，再谈性能。性能数字只有在明确连接数、消息大小、机器配置和测试方法后才有意义。

## 总结

总结一下：

1. BIO 的典型模式是线程跟着一次阻塞 I/O 走，代码简单，但连接数增长时线程成本明显。
2. NIO 通过 Channel、Buffer 和 Selector 管理一批连接的就绪事件，适合大量长连接，但状态管理更复杂。
3. AIO 通过回调或 Future 获得完成通知，业务线程不再直接等待操作完成，但底层实现和平台生态需要单独评估。
4. 三者没有脱离场景的绝对优劣。选型应同时考虑连接规模、协议复杂度、操作系统、框架生态和维护成本。

实际选型时，我会先判断连接行为和团队维护边界，再决定是否需要 NIO 或 AIO。普通业务优先复用成熟框架，只有明确需要控制线程模型或事件链路时，才深入裸 API。

## 参考

- [Java 17 java.io](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/io/package-summary.html)
- [Java 17 java.nio](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/nio/package-summary.html)
- [Java 17 Selector](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/nio/channels/Selector.html)
- [Java 17 AsynchronousSocketChannel](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/nio/channels/AsynchronousSocketChannel.html)
