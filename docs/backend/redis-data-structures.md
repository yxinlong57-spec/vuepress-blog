---
title: "Redis 五种数据结构怎么选？从底层编码到真实应用场景一次理清"
shortTitle: "Redis 数据结构"
date: 2026-10-19
description: "实测 String/List/Hash/Set/ZSet 五种结构的底层编码与转换阈值，讲清 Redis 7.0 为什么用 listpack 取代 ziplist，附场景选型表、大 key 热 key 排查和面试答法。"
category:
  - Redis
tag:
  - Redis
  - 数据结构
  - 应用场景
order: 9
---


> 环境：本机实测 Windows 11 + Redis 5.0.14（MS OpenTech 移植版），命令输出均为真实执行结果；结论基准为 Redis 7.x，凡 5.0 实测与 7.x 行为不一致的地方，正文中逐一标注。面试和线上遇到的多是 6.x/7.x，记结论时以 7.x 为准。

**目录**

- 一句话结论：先记类型，再记编码
- 底层编码总览：ziplist 已经在 7.0 退役
- String：int / embstr / raw 三种编码
- Hash：小对象走 listpack，大了转 hashtable
- List：3.2 之后只有一种编码 quicklist
- Set：intset、hashtable，7.2 又加了 listpack
- ZSet：listpack 与 skiplist+dict
- 大 key 与热 key：危害和排查手段
- 选型决策表
- 面试怎么答
- 小结

## 一句话结论：先记类型，再记编码

Redis 面试里"五种数据结构"这个问题，只答出 String、List、Hash、Set、ZSet 的名字和用法只能算及格。能拉开差距的是第二层：**每种类型在内存里并不是一种固定结构，而是按数据大小和元素形态在多种编码之间自动切换**。同一个 Hash，3 个字段时是 listpack，超过阈值就变成 hashtable；同一个 String，存 `"100"` 是 int，存 60 个字符就是 raw。

为什么要关心编码？因为它直接决定内存占用和读写代价。一个存了 500 个小字段的 Hash 用 listpack 可能比 hashtable 省一半以上内存；一个 129 人的排行榜和 128 人的排行榜，底层根本不是同一种结构，范围查询的复杂度也不同。这篇文章把五种类型逐个拆开：底层编码是什么、什么时候转换、真实项目里拿它干什么，最后给一张选型表和一段面试答法。

## 底层编码总览：ziplist 已经在 7.0 退役

先给一张类型与编码的对照表，版本边界直接写在里面：

| 类型 | Redis 5.0 / 6.x | Redis 7.x |
| --- | --- | --- |
| String | int / embstr / raw | int / embstr / raw（未变） |
| List | quicklist（节点是 ziplist） | quicklist（节点默认是 listpack） |
| Hash | ziplist / hashtable | listpack / hashtable |
| Set | intset / hashtable | intset / hashtable；7.2 起小集合可用 listpack |
| ZSet | ziplist / skiplist | listpack / skiplist |

变化的主线只有一条：**7.0 用 listpack 全面取代了 ziplist**。ziplist 的问题出在它的连锁更新上——每个 entry 要记录前一个 entry 的长度（prevlen），前一个 entry 小于 254 字节时 prevlen 占 1 字节，否则占 5 字节。如果在头部连续插入或删除一个恰好卡在 250~253 字节的 entry，后面一连串 entry 的 prevlen 都要从 1 字节扩成 5 字节，一次写操作可能引发 O(N) 的连续 realloc。listpack 换了个思路：每个 entry 只记录自己的类型、数据和本 entry 总长度（放在尾部用于反向遍历），不依赖前一个 entry 的长度，连锁更新这条路径从根上被去掉了。

listpack 其实不是 7.0 才发明的——它在 5.0 就随 Stream 类型引入，验证了两年后，7.0 才把它推广到 Hash、List、ZSet，ziplist 相关的配置项也统一改名（`hash-max-ziplist-entries` → `hash-max-listpack-entries` 等，旧名字仍作为别名兼容）。

本机 5.0.14 上查到的默认阈值配置：

```text
hash-max-ziplist-entries  512
hash-max-ziplist-value    64
zset-max-ziplist-entries  128
set-max-intset-entries    512
list-max-ziplist-size     -2
```

7.x 里对应项的前缀从 `ziplist` 换成 `listpack`，默认值含义不变（Hash 仍是 512 个字段或单值超 64 字节时转 hashtable，ZSet 仍是 128 个成员）。List 的默认值有个版本差异要注意：6.x 及之前 `list-max-ziplist-size` 默认 `-2`（每个 quicklist 节点控制在 8KB 以内），7.0 起 `list-max-listpack-size` 默认改为 `128`（每个节点最多 128 个元素）。

## String：int / embstr / raw 三种编码

String 的编码规则最简单，本机实测：

```bash
redis-cli set counter 100          # OK
redis-cli object encoding counter  # int
redis-cli incr counter             # 101

redis-cli set site:name loongstack # OK
redis-cli object encoding site:name  # embstr

redis-cli set article:body "AAAA...(53个A)"
redis-cli object encoding article:body  # raw
```

值能解析成整数就用 `int`，短字符串（不超过 44 字节）用 `embstr`，超过 44 字节用 `raw`。embstr 把 redisObject 头和 SDS 放在一次连续内存分配里，只分配一次、缓存友好；44 这个边界的由来是 redisObject（16 字节）+ sdshdr8 头 + 内容凑满 jemalloc 的 64 字节分配档。

一个容易忽略的细节：**编码会随写入退化**。对 int 编码的 key 执行 `APPEND`，值变成 `"101abc"`，编码直接退化为 `raw`（本机实测确认）。所以计数器 key 不要和业务字符串混用同一组操作。

String 的真实应用场景：

1. **计数器 / 限流**。`INCR` 是原子操作，文章阅读量、接口调用次数都靠它。限流常用 `INCR` + `EXPIRE` 做固定窗口，要滑窗再上 ZSet。
2. **分布式锁**。`SET lock:order:1001 loong NX EX 10`，本机实测返回 `OK`，`TTL` 查为 10。`NX` 保证互斥，`EX` 防死锁，value 存唯一标识（比如线程 ID），释放时用 Lua 脚本比对后再删，避免误删别人的锁。这是 2.6.12 之后的一条命令语义，老版本的 `SETNX` + `EXPIRE` 两条命令组合有原子性问题，现在不该再出现。
3. **缓存对象**。直接存 JSON 序列化结果。字段级更新频繁时不如 Hash 合适，见下一节。

## Hash：小对象走 listpack，大了转 hashtable

拿购物车举例，本机实测：

```bash
redis-cli hset cart:1001 sku:1001 2   # 1
redis-cli hset cart:1001 sku:1002 1   # 1
redis-cli hset cart:1001 sku:1003 5   # 1
redis-cli object encoding cart:1001   # ziplist（Redis 7.x 下同一条命令返回 listpack）
redis-cli hgetall cart:1001
# sku:1001  2
# sku:1002  1
# sku:1003  5
```

字段数不超过 `hash-max-listpack-entries`（默认 512）且每个字段名和值都不超过 `hash-max-listpack-value`（默认 64 字节）时，用 listpack 紧凑存储；任一条件被突破就转成 hashtable。转换不可逆——字段删回 512 以内也不会变回 listpack。

Hash 的真实应用场景：

1. **购物车**。key 是 `cart:{userId}`，field 是 skuId，value 是数量。加购 `HSET`，改数量 `HINCRBY`，全量取出 `HGETALL`，清空 `DEL`，语义一一对应。
2. **对象缓存**。和 String 存 JSON 对比：Hash 支持字段级读写（`HSET user:1 name xxx` 不用整存整取），还能单独统计字段数；缺点是字段没有独立 TTL（7.4 才给 Hash 字段加了过期能力：`HEXPIRE` 等命令，此前只能整个 key 过期），且大 Hash 会退化成 hashtable 失去紧凑优势。只读多、整体读写的对象用 String + JSON 更简单。
3. **计数分组**。一个活动的多渠道报名数，`HINCRBY signup:act1 channel:wechat 1`，比每个渠道开一个 String key 更好管理。

## List：3.2 之后只有一种编码 quicklist

List 的编码史常被说错。3.2 之前 List 确实有 ziplist 和 linkedlist 两种编码，3.2 起统一成 quicklist：**一条双向链表，每个节点内部是一个紧凑列表**（5.0/6.x 节点里是 ziplist，7.0 起默认换成 listpack）。它折中了 linkedlist 的节点开销和 ziplist 的更新代价——两端操作走链表指针 O(1)，中间访问只在单个节点内移动，不用遍历整条链。`OBJECT ENCODING` 对 List 返回的就是 `quicklist`，本机实测确认（5.0 上新建 3 元素 List 即为 quicklist，不存在"先 ziplist 后 quicklist"的说法，那是 3.2 之前的旧知识）。

```bash
redis-cli rpush mq:email "u1:welcome" "u2:reset" "u3:invoice"  # 3
redis-cli object encoding mq:email  # quicklist
redis-cli lpop mq:email             # u1:welcome
redis-cli lrange mq:email 0 -1      # u2:reset  u3:invoice
```

List 的真实应用场景：

1. **简单消息队列**。生产者 `LPUSH`，消费者 `BRPOP`（阻塞版，队列空时挂起等待，避免空轮询）。配一个 `BRPOPLPUSH`（6.2 起换成 `BLMOVE`）把取出的任务先放进处理中队列，消费成功再删，能兜住消费者中途挂掉的情况。要说清楚边界：List 队列没有消息确认、没有多消费者分组、没有失败重试，订单、支付这类场景请用专业 MQ 或 Redis Stream；异步发个邮件、写个访问日志用它足够。
2. **最新列表**。首页"最新 50 条动态"：`LPUSH feed:news {id}` + `LTRIM feed:news 0 49`，永远只留 50 条，读取 `LRANGE 0 -1` 就是按时间倒序。
3. **栈和队列的原语**。同端进出（LPUSH+LPOP）是栈，异端进出（LPUSH+RPOP）是队列，临时算法场景可以直接借用。

## Set：intset、hashtable，7.2 又加了 listpack

```bash
redis-cli sadd follow:loong 1001 1002 1003 1004  # 4
redis-cli object encoding follow:loong           # intset
redis-cli sadd follow:alice 1003 1004 1005       # 3
redis-cli sinter follow:loong follow:alice       # 1003  1004

redis-cli sadd follow:loong golang               # 1
redis-cli object encoding follow:loong           # hashtable
```

元素全是整数且个数不超过 `set-max-intset-entries`（默认 512）时用 intset——一块按值排序的连续整数数组，查找走二分；出现非整数元素或超限就转 hashtable。实测里加入字符串 `golang` 后编码立刻从 intset 变成 hashtable。7.2 又给小集合加了第三种编码：元素数不超过 `set-max-listpack-entries`（默认 128）且每个元素不超过 `set-max-listpack-value`（默认 64 字节）时优先用 listpack，不满足 intset 条件的小集合也能吃到紧凑存储（7.0/7.1 没有这条路径，非整数小集合直接上 hashtable）。

Set 的真实应用场景：

1. **共同关注 / 交集计算**。`SINTER` 求共同关注，`SUNION` 做标签并集，`SDIFF` 算"我关注而他没关注"。社交关系、权限交集都是这一类。数据量大时注意 `SINTER` 是 O(N×M) 级别的计算，线上大 key 求交要用 `SINTERSTORE` 落到从库或拆到业务侧算。
2. **去重**。爬虫 URL 去重、抽奖参与名单，`SADD` 天然去重，返回 0 就是重复。
3. **随机抽取**。抽奖用 `SRANDMEMBER`（可重复抽 n 个）或 `SPOP`（抽走不重复），比把名单拉回内存再 shuffle 省一趟网络。

## ZSet：listpack 与 skiplist+dict

```bash
redis-cli zadd rank:weekly 98 alice 87 bob 76 carol  # 3
redis-cli object encoding rank:weekly                # ziplist（7.x 下为 listpack）
redis-cli zrevrange rank:weekly 0 2 withscores
# alice 98   bob 87   carol 76
redis-cli zadd rank:weekly 95 alice   # 0（改分不算新增）
redis-cli zrevrange rank:weekly 0 0 withscores       # alice 95
```

成员数不超过 `zset-max-listpack-entries`（默认 128）且成员名不超过 64 字节用 listpack；超过则转 skiplist。本机实测转换过程：写入 129 个成员后编码从 ziplist 变成 skiplist：

```text
1..129 个成员写入 bigz
object encoding bigz  →  skiplist
zcard bigz            →  129
```

所谓 skiplist 编码其实是一个**复合结构**：跳表负责按 score 排序和范围查询（`ZRANGEBYSCORE` O(logN+M)），同时挂一个 dict 做 member→score 的映射，让 `ZSCORE` 单点查询保持 O(1)。面试里只说"跳表"会漏掉这一半。

为什么用跳表不用红黑树？作者 antirez 公开回答过：跳表实现简单得多，范围查询沿着底层链表顺序走就行，不用像树那样中序遍历；代价是每个节点多占一些指针内存。这个取舍和 Redis"足够好、够简单"的风格一致。

ZSet 的真实应用场景：

1. **排行榜**。score 是分数，member 是用户，`ZADD` 改分、`ZREVRANGE` 取 Top N、`ZREVRANK` 查名次，一条命令一个语义。并列名次按 member 字典序排，业务上要"先到先排前面"就把时间戳拼进 score 的小数部分。
2. **延迟队列**。score 存触发时间戳，`ZRANGEBYSCORE q 0 {now}` 捞出到期任务，处理完 `ZREM`。订单超时关闭常用这个方案，但要自己处理"捞出后宕机"的可靠性问题，严格场景还是上专业延迟消息。
3. **滑动窗口限流**。member 存请求 ID（或纳秒时间戳），score 存请求时间，每次请求 `ZREMRANGEBYSCORE` 清掉窗口外的旧记录再 `ZCARD` 计数，比 String 固定窗口平滑。

## 大 key 与热 key：危害和排查手段

五种结构讲完后，必须补一个生产环境绕不开的话题：**key 本身的体量问题**。

**大 key** 没有官方字节定义，经验上 String 超过 10KB、集合类元素超过 5000 个就要警惕。危害有三层：读写一个大 value 会让单线程的 Redis 在这一条命令上耗时明显变长，堵住后面的请求；集群模式下数据倾斜，某个 slot 对应的节点内存先爆；删除时 `DEL` 同步释放内存也会卡主线程（4.0 起用 `UNLINK` 异步删除，把释放交给后台线程）。排查手段按成本排序：`redis-cli --bigkeys` 扫一遍采样出各类型的最大 key；定位到具体 key 用 `MEMORY USAGE key`（4.0+）看字节数；集合类再看 `HLEN`/`LLEN`/`SCARD`/`ZCARD`。处理思路是拆：大 Hash 按 field 哈希拆成多个 key，大 List 按时间分片，String 大 JSON 先想是不是该压缩或换个地方存。

**热 key** 是访问频率问题：一个 key 扛了几十万 QPS，集群下它只落在一个节点上，单点 CPU 和网卡先被打满。排查手段：实例开 LFU 淘汰策略（`maxmemory-policy allkeys-lfu`）后可以用 `redis-cli --hotkeys`（4.0+）采样；临时用 `MONITOR` 抓一小段流量统计（生产慎用，本身有开销）；更稳妥的是客户端侧埋点统计 key 访问次数。处理思路：读多场景在应用侧加一层本地缓存（Caffeine 之类，配合短过期和变更通知）；也可以做 key 拆副本——`hotkey:01`~`hotkey:10` 存相同内容，读时随机选一份，写时全写，把单点压力摊到多个 slot 上。

## 选型决策表

| 需求 | 首选结构 | 关键命令 | 为什么是它 |
| --- | --- | --- | --- |
| 计数、限流、分布式锁 | String | `INCR`、`SET NX EX` | 原子自增 + 单命令互斥语义 |
| 存对象且要改单个字段 | Hash | `HSET`、`HINCRBY` | 字段级读写，小对象 listpack 省内存 |
| 存对象只整体读写 | String | `SET`、`GET` | JSON 序列化最简单，无编码转换负担 |
| 简单异步队列 | List | `LPUSH`、`BRPOP` | 语义直接，阻塞消费省轮询 |
| 去重、交集、抽奖 | Set | `SADD`、`SINTER` | 天然去重 + 集合运算原语 |
| 排行榜、延迟任务、滑窗限流 | ZSet | `ZADD`、`ZREVRANGE` | 按 score 排序是内置能力 |
| 最新 N 条列表 | List | `LPUSH` + `LTRIM` | 一条命令维持固定长度 |

反过来记也成立：需要排序就别用 Set 硬凑，需要字段级 TTL（7.4 之前）就别用 Hash，需要可靠消息就别用 List。

## 面试怎么答

被问"Redis 有哪些数据结构，用在什么场景"，一个能体现深度的答法分三层：

第一层，30 秒答完五种类型和各自的招牌场景：String 做计数器和分布式锁，Hash 存对象和购物车，List 做简单队列和最新列表，Set 做去重和共同关注，ZSet 做排行榜和延迟队列。

第二层，主动往编码上引："这些类型底层不是固定结构。比如 Hash 字段少的时候是 listpack，超过 512 个字段或单值超 64 字节就转 hashtable；ZSet 小于 128 个成员用 listpack，超过后转 skiplist，而且 skiplist 编码实际是跳表加 dict 的复合结构，跳表管范围查询，dict 管单点查分。"

第三层，版本边界，这是最容易加分也最容易翻车的地方："ziplist 在 Redis 7.0 已经被 listpack 全面取代，因为 ziplist 的 prevlen 设计存在连锁更新问题；List 从 3.2 起就只有 quicklist 一种编码，只是 quicklist 节点里的紧凑列表在 7.0 从 ziplist 换成了 listpack。说'List 是 ziplist 或链表'是 3.2 之前的旧结论。"

常见追问的备料：为什么跳表不用红黑树（实现简单、范围查询友好、作者公开回答过）；Hash 和 String 存对象怎么选（字段级更新用 Hash，整体读写用 String，注意 Hash 字段在 7.4 之前没有独立 TTL）；大 key 怎么排查（`--bigkeys` + `MEMORY USAGE`，删除用 `UNLINK`）。

## 小结

- 五种类型只是 API 层的抽象，底层编码随数据形态自动切换：String 分 int/embstr/raw，Hash 和 ZSet 小数据用 listpack、大了转 hashtable/skiplist，Set 多了 intset 这条整数专用路径（7.2 起也有 listpack），List 从 3.2 起统一为 quicklist。
- 7.0 最重要的底层变化是 listpack 取代 ziplist，根因是 ziplist 的 prevlen 连锁更新；本文 5.0.14 实测输出的 ziplist，在 7.x 下同一条命令都会返回 listpack。
- 场景选型记对应关系：计数找 String，对象找 Hash，队列和最新列表找 List，去重和集合运算找 Set，排序和延迟任务找 ZSet；专业消息队列和严格延迟任务不要硬用 Redis 扛。
- 结构选对了还要盯 key 的体量：大 key 用 `--bigkeys` 排查、拆分或 `UNLINK` 处理，热 key 用 LFU + `--hotkeys` 排查、本地缓存或副本拆分处理。
