---
title: "ArrayList 和 LinkedList 怎么选？别只看“插入删除快慢”"
shortTitle: "ArrayList vs LinkedList"
date: 2026-10-03
category:
  - Java 基础
tag:
  - Java
  - 集合
  - ArrayList
  - LinkedList
order: 3
---


> 环境：JDK 17.0.12，Windows 11。本文的列表实验只使用 JDK 标准库，已经在本机完成编译和两轮运行。

## 快速认识

如果业务代码没有非常明确的节点访问需求，默认先选 `ArrayList`。

`ArrayList` 底层是连续数组，按索引 `get` 很直接，顺序遍历的内存局部性也更好。代价是中间插入或删除通常会搬动后面的元素。

`LinkedList` 底层是双向链表。拿到某个节点以后，改前后指针确实是 O(1)，但按索引查找节点要先从头或尾走一遍，所以 `get(index)` 和 `add(index, value)` 在业务代码里往往没有想象中快。

队列或栈场景也别条件反射地写 `LinkedList`，优先看 `ArrayDeque`。下面是本机实验数据、源码路径和更具体的选择方法。

## 拓展

### 1. 先看源码，别让 Big-O 代替访问路径

`ArrayList.get(int)` 的核心很短：检查索引，然后从数组取元素。

```java
public E get(int index) {
    Objects.checkIndex(index, size);
    return elementData(index);
}
```

`LinkedList.get(int)` 也是先检查索引，但接着调用 `node(index)`：

```java
public E get(int index) {
    checkElementIndex(index);
    return node(index).item;
}
```

`node(index)` 会根据索引靠近头还是尾，从链表的一端开始逐个移动。列表越长、索引越靠中间，查找节点的成本越明显。

头部插入是 LinkedList 更擅长的路径，因为头节点就在手边。可一旦调用 `add(index, element)`，源码还是会先找到目标节点：

```java
public void add(int index, E element) {
    checkPositionIndex(index);
    if (index == size)
        linkLast(element);
    else
        linkBefore(element, node(index));
}
```

所以“LinkedList 插入删除是 O(1)”有一个前提：已经拿到了目标节点，或者操作发生在头尾。按索引插入时，先找节点这一步仍然是 O(n)。

### 2. 用同一套数据比较三类操作

实验代码位于项目实践目录，运行环境为 JDK 17.0.12：

```powershell
javac -encoding UTF-8 -Xlint:all ListChoiceBenchmark.java
java ListChoiceBenchmark
```

列表长度为 100000。随机访问执行 2000 次，头部插入执行 5000 次，迭代遍历对 100000 个元素执行 200 轮。每组先预热 2 轮，再记录 3 轮并输出中位数。

连续两次运行结果如下：

```text
第一次
random access: ArrayList=0.297ms, LinkedList=110.295ms
head insert: ArrayList=1.496ms, LinkedList=0.396ms
iterator traversal: ArrayList=14.350ms, LinkedList=119.941ms

第二次
random access: ArrayList=0.229ms, LinkedList=111.014ms
head insert: ArrayList=1.308ms, LinkedList=0.424ms
iterator traversal: ArrayList=13.827ms, LinkedList=123.490ms
```

这组数字不是为了证明 `ArrayList` 永远更快，而是说明访问模式不同，结果会完全不同。

随机访问时，LinkedList 每次 `get` 都可能走几十万次节点跳转，所以差距最大。头部插入时，ArrayList 需要搬移已有元素，LinkedList 只改头节点的前后关系，后者更快。

但正常迭代时，两者都按顺序走一遍，Big-O 都是 O(n)，ArrayList 仍然领先很多。原因不在循环次数，而在内存访问方式：数组元素连续，CPU 缓存命中率通常更好；链表节点分散，还要不断解引用 `next`。

### 3. 为什么“头部插入快”也不够成为默认理由

如果业务真的频繁从头部插入和删除，LinkedList 的改链操作很轻，这没有问题。但也应该同时看下面几项成本：

- 每个节点都要额外保存 `prev`、`next` 和对象头信息。
- 每次插入都要分配节点对象，给 GC 增加工作。
- 遍历时需要追指针，缓存局部性通常弱于数组。
- 如果之后还要按 index 访问，前面省下的插入时间很容易被查找吃掉。

同一类需求还有更直接的选择。队列和栈优先使用 `ArrayDeque`，它同时支持两端操作，也没有 `LinkedList` 那么多节点对象。需要在遍历过程中反复在当前位置插入时，`ListIterator` 才是 LinkedList 比较合适的场景。

一段很常见的反例是这样写的：

```java
for (int i = 0; i < list.size(); i++) {
    total += list.get(i);
}
```

这段代码对 ArrayList 没问题，对 LinkedList 会把一次顺序访问变成 O(n²)。如果对象类型是 `List`，更要避免用索引循环遍历；增强 for 或迭代器至少不会产生节点查找的二次成本。

### 4. 选型时按操作排序，而不是按类名背结论

| 主要操作 | 优先考虑 | 原因 |
| --- | --- | --- |
| 按索引读取、顺序遍历 | ArrayList | 数组定位和内存局部性更直接 |
| 尾部追加 | ArrayList | 扩容后均摊成本通常可以接受 |
| 队列、栈、两端进出 | ArrayDeque | 双端操作清晰，节点开销更少 |
| 已持有迭代器位置，需要在那里插入 | LinkedList | 不需要先按 index 查找节点 |
| 频繁按值查找、去重 | HashMap / HashSet | List 本来就不擅长按值检索 |
| 需要排序并大量查找 | TreeMap / TreeSet 或先排序后二分 | 先明确数据结构要解决什么问题 |

还可以用一句话做快速判断：如果代码里出现了很多 `get(i)`，ArrayList 通常更合适；如果代码确实围绕头尾增删展开，先看 ArrayDeque；只有节点位置已经掌握，LinkedList 的链式优势才有发挥空间。

### 5. 内存和 GC 的差别也不能忽略

ArrayList 主要维护一个对象数组。元素引用集中放在数组里，扩容时会申请更大的数组并复制引用。

LinkedList 为每个元素创建节点。节点数量和对象分配次数同步增长，除了元素引用，还要维护前后指针。元素数量很大时，额外对象和指针会带来更明显的堆占用和 GC 压力。

具体占用取决于 JVM、对象头、压缩指针和对象大小，不能靠一句“每个节点多 16 字节”算完所有平台。但趋势很明确：ArrayList 的内存结构更紧凑，LinkedList 为灵活的节点链接付出了额外成本。

### 6. 面试里别只背那张复杂度表

被问到 ArrayList 和 LinkedList 时，可以按这个顺序回答：

1. ArrayList 用数组保存元素，随机访问快，按索引插入删除要移动元素。
2. LinkedList 用双向链表，拿到节点后改链是 O(1)，按索引访问和插入要先查找节点。
3. 两者遍历的理论复杂度都是 O(n)，实际表现还会受到内存局部性和对象分配影响。
4. 大多数业务场景优先 ArrayList；队列、栈优先 ArrayDeque；LinkedList 只在访问模式匹配时使用。

如果面试官继续问“为什么 LinkedList 在实际项目里少见”，不要只说“现在内存大”。更准确的说法是：它的优势依赖已经拿到目标节点，而这个条件在普通业务代码中并不常见。

## 总结

`ArrayList` 和 `LinkedList` 的差别不在一个抽象的“谁更快”，而在数据放在哪里、代码怎样访问、元素移动和阶段分配各占多少成本。

本机实验里，ArrayList 在随机访问和迭代遍历上明显领先，LinkedList 只在头部插入这一项更快。这个结果只能说明访问模式很重要，不能拿来给所有硬件和业务场景下结论。

实际选型我会先写清操作分布，再决定集合类型。默认使用 ArrayList，需要两端进出时考虑 ArrayDeque，只有节点访问方式真正适合链式结构时，才把 LinkedList 放进候选。

## 参考

- [OpenJDK 17 ArrayList.java](https://github.com/openjdk/jdk17u/blob/master/src/java.base/share/classes/java/util/ArrayList.java)
- [OpenJDK 17 LinkedList.java](https://github.com/openjdk/jdk17u/blob/master/src/java.base/share/classes/java/util/LinkedList.java)
- [Java 17 List API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/List.html)
- [Java 17 Deque API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Deque.html)
