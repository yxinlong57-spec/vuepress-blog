---
title: "HashMap 的核心结构：从一次 put 看到扩容、桶迁移与树化边界"
description: "从一次 put 调用看 HashMap 核心结构：扰动函数、桶定位、链表树化阈值与扩容迁移全过程。"
shortTitle: "HashMap 核心结构"
date: 2026-10-05
category:
  - 面经手册
tag:
  - Java
  - HashMap
  - 集合
  - 源码
order: 1
---


> 实验环境：Windows 11、Oracle JDK 17.0.12。文中的反射探针只用于观察 JDK 17 的实现，不代表所有 JDK 版本或其他 Map 实现。

无参创建的 `HashMap` 在第一次 `put` 前没有分配数组；第一次插入后，`table` 长度才变成 16。默认负载因子是 0.75，容量 16 对应的阈值是 12，所以第 13 个元素加入后，表才从 16 扩到 32。另一个常被说错的边界是树化：同一个桶连续碰撞时，第 9 个节点进入 `treeifyBin`，但如果容量还没到 64，它会先扩容，而不是立刻变成红黑树。

这篇文章不去背“数组加链表加红黑树”这句话，而是用一个小探针把 `table`、`threshold` 和桶节点类型打出来，再回到 JDK 17 源码解释每次变化发生的原因。

## 目录

- 一、先看一次 put 的结果
- 二、数组、节点和索引如何组成 HashMap
- 三、为什么容量会折算成 2 的幂
- 四、扩容时，旧桶为什么只分成两组
- 五、同桶第 9 个节点为什么不马上树化
- 六、这次实验不能证明什么
- 七、实际使用时的判断

## 一、先看一次 put 的结果

先用无参构造创建一个 map，再连续插入多个不同 hash 的 key。探针在每次插入前读取容量，在插入后读取新的容量和阈值：

```text
初始状态: table.length=0, threshold=0, size=0
1     h=1        1          0         -         16        1         是
...
12    h=11       11         16        11        16        11
13    h=12       12         16        12        32        12        是
```

这里同时发生了两件事：

1. 第一次 `put` 把空表初始化成长度 16，并把阈值设置成 `16 * 0.75 = 12`。
2. 第 13 次插入让 `size` 从 12 变成 13。`putVal` 在插入完成后执行 `if (++size > threshold) resize()`，于是容量翻倍到 32，阈值变成 24。

如果构造时就传入预计容量，结果会不一样。`new HashMap<>(20)` 的构造阶段不会创建数组，但会把 `threshold` 暂时保存为向上取整后的容量 32。第一次 `put` 时，`resize()` 使用这个阈值分配长度 32 的数组，之后阈值才变成 24。

```text
new HashMap<>(20) -> table.length=0, threshold=32, size=0
第一次 put 之后   -> table.length=32, threshold=24, size=1
```

“懒加载”只表示数组不在构造函数里分配，不表示第一次插入一定得到 16。指定了初始容量时，第一次分配的大小取决于构造参数经过 `tableSizeFor` 折算后的结果。

## 二、数组、节点和索引如何组成 HashMap

在 JDK 17 中，`HashMap` 的字段声明是：

```java
transient Node<K, V>[] table;
```

每个 `Node` 保存四项信息：

```java
final int hash;
final K key;
V value;
Node<K, V> next;
```

`hash` 是 key 经过扰动后的结果，`next` 指向同一个桶里的下一个节点。普通桶先以链表保存节点；当某个桶的条件满足后，节点可以转换为 `TreeNode`，底层使用红黑树结构。

插入时，数组下标由这一行决定：

```java
i = (n - 1) & hash;
```

其中 `n` 是当前数组长度。取得下标后，`putVal` 依次处理三种情况：

- 该位置为空，直接放一个新节点。
- 首节点的 hash 和 key 都匹配，替换旧值。
- 首节点不匹配，则沿着链表或树继续查找；到底后把新节点追加上去。

`HashMap` 只约定映射行为，不承诺迭代顺序。对同一个键来说，`hashCode()` 和 `equals()` 必须保持一致；如果键对象在插入后改变了参与哈希计算的字段，后续查找就可能定位不到原来的节点。

## 三、为什么容量会折算成 2 的幂

`HashMap` 在构造和扩容时都维持容量为 2 的幂。源码中的 `tableSizeFor` 会把传入容量向上折算到最近的 2 的幂，并限制在 `MAXIMUM_CAPACITY = 1 << 30` 以内。

这个选择首先是为了索引计算。容量 `n` 是 2 的幂时，`n - 1` 的低位全是 1，因此：

```text
hash & (n - 1)
```

只保留 hash 的低位，效果等价于非负 hash 对 `n` 取模，但位运算更直接，而且结果一定落在 `[0, n - 1]`。Java 的 `hashCode()` 可以返回负数，直接取模可能得到负下标；位与运算不会产生这个问题。

```text
容量 16 是 2 的幂：
hash     hash & (n-1)   hash % n   相等
1        1              1          true
15       15             15         true
16       0              0          true
17       1              1          true
-1       15             -1         false
```

只用低位也有代价。两个 hash 如果低位相同，但高位不同，在容量较小时仍可能进入同一个桶。源码里的 `hash(Object key)` 因此做了一次很便宜的高位扰动：

```java
static final int hash(Object key) {
    int h;
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

`h >>> 16` 把高 16 位移到低位，再和原值异或。探针中的两个 hash 低位都是 1：

```text
原始 hash      低 4 位        HashMap.hash index(cap=16)
0x00000001   1            0x00000001   1
0x00010001   1            0x00010000   0
```

扰动后，第二个 hash 的高位参与了低位，在容量 16 时被分到了另一个桶。这里的目标是减少系统性的低位碰撞，不是把普通对象哈希变成密码学哈希，也不能消除碰撞。

## 四、扩容时，旧桶为什么只分成两组

容量翻倍时，旧容量 `oldCap` 也是一个 2 的幂。对旧数组中的一个节点来说：

```java
(e.hash & oldCap) == 0
```

这个表达式只有两种结果：0，或者 `oldCap` 本身。因为 `oldCap` 的二进制形式只有一个 1，hash 在这一位要么是 0，要么是 1。

于是扩容不需要重新对每个节点做一次取模，而是把旧桶拆成两组：

- 结果为 0 的节点留在原来的下标 `j`。
- 结果不为 0 的节点移动到 `j + oldCap`。

探针里的 `h = 1` 和 `h = 17` 在容量 16 时都落在下标 1：

```text
key        index(cap=16)  index(cap=32)  hash & oldCap
h=1        1              1              0
h=17       1              17             16
```

容量从 16 变成 32 后，`h=1` 留在下标 1，`h=17` 移到下标 17。这个拆桶规则依赖容量是 2 的幂，也是 `HashMap` 扩容时仍然能保持较低搬迁成本的原因之一。

## 五、同桶第 9 个节点为什么不马上树化

源码定义了两个容易混在一起的常量：

```java
static final int TREEIFY_THRESHOLD = 8;
static final int MIN_TREEIFY_CAPACITY = 64;
```

`TREEIFY_THRESHOLD` 是桶内链表长度的判断点，`MIN_TREEIFY_CAPACITY` 是允许树化的最小表容量。`putVal` 在链表尾部追加节点后，如果 `binCount >= TREEIFY_THRESHOLD - 1`，就调用 `treeifyBin`。

但 `treeifyBin` 的第一件事不是立即转换，而是检查表容量：

```java
if (tab == null || (n = tab.length) < MIN_TREEIFY_CAPACITY)
    resize();
```

所以同一个桶连续插入返回 `hash = 0` 的 key 时，探针看到的是下面的过程：

```text
size   cap      threshold    bucket     说明
8      16       12           HashMap$Node
9      32       24           HashMap$Node 容量不足 64，改为扩容
10     64       48           HashMap$Node 容量仍不足 64，再次扩容
11     64       48           HashMap$TreeNode 已树化
```

第 9 个节点触发扩容时，容量从 16 变成 32；第 10 个节点再次触发检查，容量从 32 变成 64。到了第 11 个节点，表容量已经满足 64，桶节点类型才从 `HashMap$Node` 变成 `HashMap$TreeNode`。

这说明“桶里有 8 个节点就会树化”是不够准确的。树化同时看桶内节点情况和表容量；容量不足时，优先扩容通常更划算，因为更大的表可能把节点分散到不同桶。

## 六、这次实验不能证明什么

这组反射输出能说明 JDK 17.0.12 在这个小样本里的状态变化，但不能直接推广成所有实现的行为：

- 反射读取 `table`、`threshold` 等私有字段依赖具体的 JDK 实现，不应当放进业务代码。
- 实验没有对比不同 JDK 厂商和版本，不能据此断言 Java 8、Java 11 或未来版本的所有细节完全相同。
- “容量是 2 的幂”是当前 `HashMap` 的实现选择，不是所有哈希表的共同规则。
- `HashMap` 也不保证每个操作的常数时间。hash 分布很差、碰撞集中、对象数量很大时，仍然可能付出额外成本；JEP 180 说明平衡树是在高频碰撞下改善最坏情况的措施。
- 当前探针没有做延迟和吞吐量测试，不能拿它给不同 Map 做性能排名。

根据 Java 17 API 文档，`HashMap` 本身不是同步容器。多个线程同时读写同一个实例时，需要外部同步，或者改用并发场景下设计过的 `ConcurrentHashMap`。

## 七、实际使用时的判断

如果只是保存少量键值对，直接使用默认构造的 `HashMap` 通常就够了。数据量明显可预估时，可以在构造阶段给出合理的初始容量，减少多次扩容；但容量会被向上取整，负载因子和对象数量也会共同影响最终阈值。

更值得投入精力的地方，通常是键对象本身：

- `hashCode()` 的分布要稳定，`equals()` 要与其保持一致。
- 不要用插入后还会改变哈希字段的可变对象作为 key。
- 不要把“碰撞”误认为“键相等”；链表或树节点仍会继续比较 hash、引用和 `equals()`。
- 不要把树化阈值当成性能承诺，先看真实数据分布和访问模式。
- 需要并发写入时，不要给普通 `HashMap` 外面随便包一层“看起来安全”的代码，先选择正确的并发容器。

我会把 `HashMap` 的核心结构记成一条完整链路：容量决定低位掩码，hash 扰动决定高位信息是否参与，阈值决定何时扩容，扩容决定桶如何拆分，树化阈值决定碰撞严重时是否换用红黑树。每个数字只有放回这条链路里，才不容易背错。

## 参考

- [Java 17 HashMap API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/HashMap.html)
- [JEP 180: Handle Frequent HashMap Collisions with Balanced Trees](https://openjdk.org/jeps/180)
- JDK 17.0.12 源码包中的 `java.base/java/util/HashMap.java`
