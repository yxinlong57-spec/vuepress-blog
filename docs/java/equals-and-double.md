---
title: "Java 的 == 和 equals 到底有什么区别？用 String、Integer 和自定义对象一次讲清"
description: "用 String、Integer 和自定义对象实测 == 与 equals 的差异：常量池、装箱缓存、hashCode 成对重写，附判断路径图。"
shortTitle: "== 和 equals 的区别"
date: 2026-10-04
category:
  - Java 基础
tag:
  - Java
  - equals
  - Java 基础
  - 字符串
order: 1
---


## 快速认识

`==` 和 `equals` 不是“一个比较地址，一个比较内容”这么简单。

更准确的规则是：

- 两边是基本类型时，`==` 比较值。
- 两边是对象引用时，`==` 判断它们是否指向同一个对象。
- `equals` 是一个方法。`Object` 里的默认实现就是引用比较，但 `String`、包装类等会重写它。
- 自定义类如果只重写 `equals`、不重写 `hashCode`，放进 `HashSet` 或作为 `HashMap` 的 Key 时仍然可能出错。

可以先记住一张判断表：

| 场景 | 推荐写法 | 原因 |
| --- | --- | --- |
| 比较两个 `int`、`long`、`double` | `a == b` | 基本类型没有 `equals` |
| 比较两个字符串的内容 | `a.equals(b)` 或 `Objects.equals(a, b)` | 字符串的 `equals` 已按内容实现 |
| 判断两个引用是否为同一个对象 | `a == b` | 这正是引用比较的语义 |
| 枚举值比较 | `enumValue == OtherEnum.VALUE` | 枚举常量是单例，`==` 更安全也更直观 |
| 可能为 `null` 的对象值比较 | `Objects.equals(a, b)` | 避免空指针 |
| 自定义实体按业务字段判等 | 重写 `equals` 和 `hashCode` | 保证集合和 Map 行为一致 |

先用一个最小例子看结果：

```java
String a = "Java";
String b = "Java";
String c = new String("Java");

System.out.println(a == b);       // true
System.out.println(a == c);       // false
System.out.println(a.equals(c));  // true
```

`a == b` 为 `true`，是因为两个字面量可以复用同一个字符串对象。`c` 是新创建的对象，所以 `a == c` 为 `false`。它们的内容都相同，所以 `a.equals(c)` 为 `true`。

![String 内存关系：字面量复用与 new String](/images/java/equals-and-double/01-String内存关系.png)

## 拓展

### 一、先区分基本类型和引用类型

基本类型保存的是具体数值，引用类型保存的是指向对象的引用。

```java
int left = 10;
int right = 10;
System.out.println(left == right); // true
```

这里比较的是两个 `int` 的值，所以结果是 `true`。

对于引用：

```java
String left = new String("Java");
String right = new String("Java");

System.out.println(left == right);       // false
System.out.println(left.equals(right));  // true
```

`new String` 创建了两个不同的对象。`==` 判断它们是否为同一个对象，结果是 `false`；`equals` 比较字符串内容，结果是 `true`。

所以，不要把“对象用 `equals`”背成无条件规则。真正要问的是：我现在比较的是对象身份，还是对象的业务值？

### 二、为什么字符串字面量的 == 有时是 true

直接写出的字符串字面量会进入字符串常量池。同一组在编译期确定的字符串内容，可以被两个变量引用到同一个对象。

```java
String a = "Java";
String b = "Java";
String c = "Ja" + "va";

System.out.println(a == b); // true
System.out.println(a == c); // true
```

`"Ja" + "va"` 的两个操作数都是编译期常量，编译器会在编译阶段完成拼接，所以它仍然可以复用 `"Java"` 的常量对象。

但下面两种情况不一样：

```java
String prefix = "Ja";
String d = prefix + "va";
String e = new String("Java");

System.out.println(a == d); // false
System.out.println(a == e); // false
System.out.println(a.equals(d)); // true
System.out.println(a.equals(e)); // true
```

`prefix` 是变量，它的值要到运行时才能确定。这里是否创建新对象、是否进入常量池，不能只凭肉眼猜。实际写业务代码时，字符串内容比较就统一使用 `equals` 或 `Objects.equals`，不要依赖常量池带来的 `==` 结果。

### 三、Integer 的 127 和 128

下面这段代码很容易让初学者疑惑：

```java
Integer a = 127;
Integer b = 127;
Integer c = 128;
Integer d = 128;

System.out.println(a == b);       // true
System.out.println(c == d);       // false
System.out.println(c.equals(d));  // true
```

自动装箱会调用类似 `Integer.valueOf(127)` 的方法。HotSpot 常见实现会缓存 `-128` 到 `127` 之间的 `Integer` 对象，所以 `a` 和 `b` 可能指向缓存中的同一个对象；`128` 超出这个常见范围，`c` 和 `d` 可能是两个不同对象。

这里要特别注意两点：

1. 包装类比较的是对象，不能把 `==` 当成数值比较。
2. `Integer` 和 `Long` 即使数值相同，`equals` 也会因为类型不同而返回 `false`。

```java
Integer count = 1000;
Long sameValue = 1000L;

System.out.println(count.equals(sameValue)); // false
```

业务代码中比较包装类数值，优先使用 `equals`，并且确认两边类型一致。需要做数值计算时，先明确是否可能为 `null`，再决定如何拆箱或转换。

### 四、自定义对象必须自己说明“什么叫相等”

如果类没有重写 `equals`，它继承的是 `Object.equals`，效果等同于引用比较。

```java
class PlainUser {
    private final String name;

    PlainUser(String name) {
        this.name = name;
    }
}

PlainUser left = new PlainUser("Tom");
PlainUser right = new PlainUser("Tom");

System.out.println(left.equals(right)); // false
```

两个用户的 `name` 相同，但这是两个不同对象，所以默认比较结果仍然是 `false`。如果业务规定“用户名相同就是同一个用户”，就需要自己重写。

```java
import java.util.Objects;

class NamedUser {
    private final String name;

    NamedUser(String name) {
        this.name = name;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof NamedUser)) {
            return false;
        }
        NamedUser that = (NamedUser) other;
        return Objects.equals(name, that.name);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name);
    }
}
```

这段代码做了三件事：

1. 先判断是否为同一个对象，减少后续比较。
2. 判断类型是否匹配。
3. 用 `Objects.equals` 比较参与判等的字段，顺便处理字段为 `null` 的情况。

为什么还要重写 `hashCode`？因为 `HashSet`、`HashMap` 会先根据哈希值寻找桶，再用 `equals` 确认是否相等。如果两个对象被判定为 `equals`，但哈希值不同，集合就可能把它们放进不同位置。

```java
Set<NamedUser> users = new HashSet<>();
users.add(new NamedUser("Tom"));

System.out.println(users.contains(new NamedUser("Tom"))); // true
```

这里的 `contains` 为 `true`，不是因为两个对象是同一个对象，而是因为类已经定义了“姓名相同就算相同用户”，并且 `equals` 与 `hashCode` 使用了同一组字段。

### 五、判断路径可以简化成这样

写代码时不需要每次都想一遍底层实现，可以按下面的顺序判断：

```text
两边是基本类型
-> 用 ==

两边是对象
-> 需要判断是不是同一个对象？用 ==
-> 需要按内容或业务字段比较？用 equals / Objects.equals
-> 比较的是枚举常量？用 ==
-> 自己定义的实体需要进入 Set / Map？重写 equals + hashCode
```

![== 与 equals 的判断路径](/images/java/equals-and-double/02-判断路径.png)

### 六、几个容易踩的坑

**第一个坑：对可能为 null 的变量直接调用 equals。**

```java
String left = null;
String right = "Java";

// System.out.println(left.equals(right)); // NullPointerException
System.out.println(Objects.equals(left, right)); // false
```

如果你能确定常量非空，也可以写成 `"Java".equals(variable)`。如果两边都可能为空，`Objects.equals` 更清楚。

**第二个坑：只重写 equals，不重写 hashCode。**

这在普通 `if` 判断里可能看不出来，但加入 `HashSet` 或 `HashMap` 后就会暴露。只要重写其中一个，就应该同时检查另一个。

**第三个坑：BigDecimal 不能用 equals 判断数值相等。**

```java
BigDecimal a = new BigDecimal("1.0");
BigDecimal b = new BigDecimal("1.00");

System.out.println(a.equals(b));      // false
System.out.println(a.compareTo(b));   // 0
```

`equals` 会同时考虑数值和精度，`compareTo` 比较数值大小。金额比较采用哪个方法，取决于业务是否关心精度表示。不要看到 `false` 就立刻认为 `compareTo` 永远更合理，先把业务口径写清楚。

**第四个坑：数组用 equals 比较内容。**

数组没有按元素重写 `equals`。要比较两个数组的内容，应使用 `Arrays.equals`；二维数组使用 `Arrays.deepEquals`。

### 七、练习题

先不要运行代码，自己写下结果，再对照输出。

**练习一：字符串**

```java
String a = "java";
String b = new String("java");
String c = "ja" + "va";

System.out.println(a == b);
System.out.println(a == c);
System.out.println(a.equals(b));
```

重点不是背答案，而是解释每一行为什么是 `true` 或 `false`。

**练习二：Integer**

```java
Integer a = 100;
Integer b = 100;
Integer c = 200;
Integer d = 200;

System.out.println(a == b);
System.out.println(c == d);
System.out.println(c.equals(d));
```

再把这四个变量改成 `new Integer(...)` 的写法，比较结果会如何变化？注意 `new Integer` 已经不再推荐使用，这里只用来观察对象身份。

**练习三：自定义对象**

创建一个 `Student` 类，包含 `id` 和 `name`。规定 `id` 相同就是同一学生，完成：

1. 重写 `equals` 和 `hashCode`。
2. 创建两个 `id` 相同、`name` 不同的对象。
3. 放入 `HashSet`，观察集合大小。
4. 调用 `contains`，解释结果。
5. 删掉 `hashCode`，重新运行，观察变化。

**练习四：找错误**

下面这段代码可能在什么时候出错？

```java
Map<String, Integer> scores = new HashMap<>();
String key = null;
scores.put(key, 90);
System.out.println(scores.get(null));
```

先查 `HashMap` 对 `null` Key 的说明，再结合自己的 JDK 版本运行验证。不要把“HashMap 一定不能存 null”当成未经核对的结论。

### 八、B站和练习资源怎么用

B站适合用它看老师怎么把对象、引用和集合串起来，但不要只开着视频“听懂”。每看完一段，就把示例里的一个变量改掉，重新运行，看看结果是否和预测一致。

可以按这个顺序检索：

1. B站搜索“Java equals 和 == 的区别”，先看一个 10 到 20 分钟的入门讲解。
2. 搜索“Java hashCode equals”，确认集合中为什么需要成对重写。
3. 搜索“Java String 常量池”，理解字面量和 `new String` 的差异。
4. 搜索“Java Integer 缓存”，观察自动装箱的执行路径。
5. 回到代码，把文章中的四个练习全部跑一遍。

可直接打开这些入口：

- [B站：Java equals 和 == 的区别](https://search.bilibili.com/all?keyword=Java%20equals%20%E5%92%8C%3D%3D%E7%9A%84%E5%8C%BA%E5%88%AB)
- [B站：Java hashCode equals](https://search.bilibili.com/all?keyword=Java%20hashCode%20equals)
- [Oracle：Object.equals](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/Object.html#equals(java.lang.Object))
- [Oracle：Object.hashCode](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/Object.html#hashCode())
- [HackerRank Java 练习](https://www.hackerrank.com/domains/java)
- [CodingBat Java 练习](https://codingbat.com/java)

最后给一个实用规则：如果比较的是对象身份，用 `==`；如果比较的是值或业务字段，用 `equals` 或 `Objects.equals`；如果自定义对象要进入 `HashSet`、`HashMap`，把 `equals` 和 `hashCode` 一起检查。先把这三个判断用到自己的代码里，比一次背完所有细节更有用。
