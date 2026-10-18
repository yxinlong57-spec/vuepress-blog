---
title: "Java Scanner 的 nextLine() 为什么会跳过一行？把输入光标一次讲明白"
shortTitle: "Scanner nextLine 跳行"
date: 2026-10-04
category:
  - Java 基础
tag:
  - Java
  - Scanner
  - 控制台输入
order: 2
---


## 快速认识

先看这段很常见的代码：

```java
Scanner scanner = new Scanner(System.in);

System.out.print("请输入年龄：");
int age = scanner.nextInt();

System.out.print("请输入姓名：");
String name = scanner.nextLine();
```

输入 `18`，按回车，再输入 `小李`。打印 `name` 时，它很可能是空字符串。

原因不在于 `nextLine()` “坏了”，而在于 `nextInt()` 只读取整数这个 token。它读到 `18` 后停下，没有把后面的换行一起消费。紧接着调用 `nextLine()`，读到的是当前行剩下的换行，所以返回空字符串。

输入内容的实际位置可以看成：

```text
18\n小李\n
^^
nextInt() 读取到这里后停止
```

![Scanner 读取光标轨迹](/images/java/scanner-nextline/01-Scanner光标轨迹.png)

修复方式取决于输入格式：

```java
// 方式一：年龄和姓名分两行输入
int age = scanner.nextInt();
scanner.nextLine();          // 消费年龄行剩下的换行
String name = scanner.nextLine();
```

```java
// 方式二：统一按行读取
int age = Integer.parseInt(scanner.nextLine().trim());
String name = scanner.nextLine();
```

方式一需要明确输入约定，方式二对“年龄和姓名分两行”的规则更清楚。下面把光标位置、`next` 和 `nextLine` 的差异，以及更稳的写法拆开讲。

## 拓展

### 一、先理解 Scanner 读取的是 token，不是整行

`Scanner` 默认使用空白作为分隔符。`next()`、`nextInt()`、`nextDouble()` 这类方法读取的是 token。

比如输入：

```text
18 小李
```

`nextInt()` 会读取 `18`，遇到空格后停止。此时空格和后面的 `小李` 还在输入流里。

而 `nextLine()` 读取的是从当前位置开始，到行分隔符之前的内容，并把行分隔符消费掉。

两者的侧重点不同：

| 方法 | 读取单位 | 是否消费行尾 |
| --- | --- | --- |
| `next()` | 下一个 token | 通常会跳过 token 间的空白，但不一定消费整行 |
| `nextInt()` | 下一个整数 token | 读取数字后通常停在分隔符前 |
| `nextLine()` | 当前行剩余内容 | 消费当前行，返回行尾前的内容 |

这就是 `nextInt()` 后直接 `nextLine()` 容易拿到空字符串的原因。

![next 与 nextLine 的读取差异](/images/java/scanner-nextline/02-next与nextLine对比.png)

### 二、用一个固定字符串复现问题

为了不受手动输入影响，可以把 `Scanner` 直接连接到固定文本：

```java
Scanner scanner = new Scanner("18\n小李\n");

int age = scanner.nextInt();
String name = scanner.nextLine();

System.out.println("age=" + age + ", name=[" + name + "]");
```

输出是：

```text
age=18, name=[]
```

输入流中的读取过程是：

```text
原始内容：18\n小李\n

nextInt()：
- 跳过开头没有空白
- 读取 18
- 遇到 \n 停止
- \n 仍留在输入流

nextLine()：
- 从 \n 前面开始读
- 遇到 \n 结束
- 返回 \n 前面的内容
- 结果是空字符串
```

在 `nextInt()` 后面加一次 `nextLine()`：

```java
Scanner scanner = new Scanner("18\n小李\n");

int age = scanner.nextInt();
scanner.nextLine();
String name = scanner.nextLine();

System.out.println("age=" + age + ", name=[" + name + "]");
```

输出变成：

```text
age=18, name=[小李]
```

这里的额外 `nextLine()` 不是为了“读姓名”，而是为了把年龄行末尾的换行消费掉。真正的姓名由下一次 `nextLine()` 读取。

### 三、next() 连续读取后，nextLine() 也可能返回空

这个问题不只出现在 `nextInt()` 后面。

```java
Scanner scanner = new Scanner("Java Scanner\n第二行\n");

System.out.println(scanner.next());      // Java
System.out.println(scanner.next());      // Scanner
System.out.println(scanner.nextLine());  // 空字符串
System.out.println(scanner.nextLine());  // 第二行
```

前两次 `next()` 读取的是两个 token。它们已经把第一行的可见文字读完了，但光标仍停在第一行末尾。第一次 `nextLine()` 读到的是剩下的换行；第二次才读取下一行。

如果一段输入本来按行组织，从第一句开始就用 `nextLine()` 读取，通常比交替使用 `next()` 和 `nextLine()` 更容易推理。

### 四、额外调用一次 nextLine() 并不适用于所有输入

额外调用 `nextLine()` 能修好“年龄和姓名分两行”的情况：

```text
18
小李
```

但如果用户输入的是：

```text
18 小李
```

再看这段代码：

```java
int age = scanner.nextInt();
scanner.nextLine();
String name = scanner.nextLine();
```

`nextInt()` 读取 `18` 后，额外调用的 `nextLine()` 会把当前行剩下的 ` 小李` 一起消费掉。后面的 `name` 仍然拿不到姓名。

所以“补一个 `nextLine()`”只是针对一种输入约定，不是所有问题的统一修复。代码最好明确要求用户怎么输入，或者统一按行读取，再由程序自己拆分。

### 五、统一按行读取通常更容易控制

如果每次输入都按行提交，可以先读取整行，再决定怎么解析：

```java
Scanner scanner = new Scanner(System.in);

System.out.print("请输入年龄：");
String ageLine = scanner.nextLine().trim();
int age = Integer.parseInt(ageLine);

System.out.print("请输入姓名：");
String name = scanner.nextLine();
```

这个写法的好处是，年龄行的边界很清楚。`trim()` 会去掉输入前后多余的空格；`Integer.parseInt` 负责把字符串转成整数。

如果输入不是数字，`Integer.parseInt` 会抛出 `NumberFormatException`。可以先把异常处理写清楚：

```java
try {
    int age = Integer.parseInt(ageLine);
    System.out.println("age=" + age);
} catch (NumberFormatException e) {
    System.out.println("年龄必须是整数：" + ageLine);
}
```

初学阶段不要为了“看起来健壮”把异常全部吞掉。至少要告诉用户哪一行输入不合法，方便继续修改。

### 六、如果需要反复要求输入

命令行输入经常需要循环校验。下面这个例子会在用户输入整数之前一直提示：

```java
Scanner scanner = new Scanner(System.in);
int age;

while (true) {
    System.out.print("请输入年龄：");
    String line = scanner.nextLine().trim();

    try {
        age = Integer.parseInt(line);
        break;
    } catch (NumberFormatException e) {
        System.out.println("输入的不是整数，请重新输入。");
    }
}

System.out.print("请输入姓名：");
String name = scanner.nextLine();
System.out.println("age=" + age + ", name=" + name);
```

这里没有使用 `nextInt()`，所以不存在“数字后面还留着换行”的问题。循环只负责校验当前行，读取规则保持一致。

如果确实要继续使用 `nextInt()`，另一种校验写法是：

```java
while (!scanner.hasNextInt()) {
    System.out.println("输入的不是整数，请重新输入。");
    scanner.nextLine();
}

int age = scanner.nextInt();
scanner.nextLine(); // 清掉当前行剩余内容
String name = scanner.nextLine();
```

这里的 `scanner.nextLine()` 有两个职责可能同时出现：非法 token 行需要丢掉，当前行的尾部也需要丢掉。写之前要先说明输入格式，否则很难判断哪一次清理才是正确的。

### 七、几个常见误区

**误区一：以为 `nextLine()` 一定会返回有内容的行。**

它返回的是当前位置到行尾之间的剩余内容。当前位置已经在行尾时，结果自然可能是空字符串。

**误区二：只记住“多写一次 nextLine”。**

这句话只在特定输入格式下成立。先确定是 token 读取还是整行读取，再决定要不要清理。

**误区三：把不同输入方法当成同一套规则。**

`nextInt()`、`nextDouble()`、`next()` 都有自己的停止位置。混用后出现空字符串、少读一行或多读一行，通常都是光标位置没有想清楚。

**误区四：在多个 Scanner 之间反复切换。**

同一个 `System.in` 被多个 `Scanner` 读取时，可能会出现缓冲区互相抢输入的情况。一个输入流程优先复用同一个 `Scanner`。

### 八、练习题

**练习一：预测输出**

```java
Scanner scanner = new Scanner("20\n小王\nJava\n");
int age = scanner.nextInt();
String name = scanner.nextLine();
String course = scanner.nextLine();

System.out.println("[" + name + "]");
System.out.println("[" + course + "]");
```

先判断 `name` 和 `course` 各是什么，再运行代码验证。

**练习二：修复输入**

把练习一改成“年龄和姓名分两行输入时，结果正确”的版本。再改成“整行读取年龄和姓名”的版本，比较两种写法的适用边界。

**练习三：处理一行两个信息**

输入 `18 小李`，要求一次读完整行，再用 `split("\\s+")` 拆分。分别处理：

1. 正常输入。
2. 缺少姓名。
3. 年龄不是数字。

这道题的重点不是写最短代码，而是让输入规则和错误提示一致。

**练习四：观察 next 和 nextLine**

输入：

```text
Java Scanner
第二行
```

连续调用两次 `next()`，再调用一次 `nextLine()`。打印每次结果，并画出光标从第一行 token 之间移动到第二行的轨迹。

### 九、B站和练习资源怎么用

先看一个短的 `next()` 与 `nextLine()` 对比视频，再自己用固定字符串运行。不要只盯着“怎么修”，要能看到每次方法调用后剩下了什么。

推荐按这个顺序：

1. B站搜索“Java Scanner nextLine 跳过一行”，找到解释输入流光标位置的视频。
2. 搜索“Java next 和 nextLine 的区别”，补充 token 和整行读取的区别。
3. 搜索“Java Scanner 循环输入”，学习如何校验非法输入。
4. 到 HackerRank 或牛客完成一道需要同时读取整数和字符串的题目。
5. 回到本地代码，把“分两行输入”和“同一行输入”两种格式都跑一遍。

可直接打开这些入口：

- [B站：Scanner nextLine 跳过一行](https://search.bilibili.com/all?keyword=Java%20Scanner%20nextLine%20%E8%B7%B3%E8%BF%87%E4%B8%80%E8%A1%8C)
- [B站：next 和 nextLine 的区别](https://search.bilibili.com/all?keyword=Java%20next%20nextLine%20%E5%8C%BA%E5%88%AB)
- [Oracle：Scanner API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Scanner.html)
- [HackerRank：Java Stdin and Stdout II](https://www.hackerrank.com/challenges/java-stdin-stdout/problem)
- [牛客：在线编程练习](https://www.nowcoder.com/exam/oj)

最后记住一个判断方法：`next()` 和 `nextInt()` 读的是 token，`nextLine()` 读的是当前位置到行尾的内容。遇到跳行时，不要急着背修复模板，先把输入内容按照分隔符写出来，标出每一步方法调用后光标停在哪里，答案通常会自己出现。
