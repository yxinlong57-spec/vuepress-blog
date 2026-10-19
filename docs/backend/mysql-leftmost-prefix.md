---
title: "最左前缀原则到底约束了什么？联合索引、范围和 ORDER BY 的一次实测"
description: "联合索引、范围查询和 ORDER BY 一次实测：最左前缀原则到底约束了什么。"
shortTitle: "最左前缀原则"
date: 2026-10-08
category:
  - MySQL
tag:
  - MySQL
  - 索引
  - 最左前缀
order: 1
---


实验环境：Windows 11，MySQL Community Server 8.0.45，`utf8mb4` 字符集，InnoDB 表，人工造数 100000 行。表上只有一个联合索引 `idx_user_event_time(user_id, event_type, created_at)`，本文用它观察范围访问、排序和覆盖索引。不同数据分布下优化器可能给出不同计划。

## 目录

- [最左前缀约束的是连续索引前缀](#最左前缀约束的是连续索引前缀)
- [实验表与数据分布](#实验表与数据分布)
- [缺少前导列：能扫描索引，不能直接定位](#缺少前导列能扫描索引不能直接定位)
- [范围列之后的列为什么会退化](#范围列之后的列为什么会退化)
- [ORDER BY 什么时候能利用索引顺序](#order-by-什么时候能利用索引顺序)
- [IN 是多段范围，不保证全局有序](#in-是多段范围不保证全局有序)
- [覆盖索引、回表和 key_len](#覆盖索引回表和-key_len)
- [设计联合索引时的检查方法](#设计联合索引时的检查方法)
- [参考资料](#参考资料)

## 最左前缀约束的是连续索引前缀

最左前缀原则约束的是联合索引的连续使用方式。索引按 `(user_id, event_type, created_at)` 的顺序排列，可用于定位的完整前缀从第一列开始：`(user_id)`、`(user_id, event_type)`、`(user_id, event_type, created_at)`。它没有说缺少第一列时索引绝对不可用，也没有说只要列出现在 `WHERE` 中就能直接 seek。

这次实测出现了三个容易混淆的结果：只查 `event_type` 时仍然扫描了整棵联合索引；`event_type` 使用范围后，`created_at` 不再作为索引范围边界；等值条件覆盖前两列时，`ORDER BY created_at` 不再需要额外排序，而 `IN` 两个取值时又出现了 `Using filesort`。

![联合索引最左匹配示意](/images/backend/mysql-leftmost-prefix/01-leftmost-match.svg)

## 实验表与数据分布

```sql
CREATE TABLE user_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  payload VARCHAR(200) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_user_event_time (user_id, event_type, created_at)
) ENGINE = InnoDB;
```

人工数据包含 2000 个用户、8 种事件类型和 90 天时间范围，`SELECT COUNT(*)` 返回 100000。脚本执行了 `ANALYZE TABLE`，下面所有计划都来自修正造数样本后的同一轮输出。

第一轮脚本曾用 `user_id = 42 AND event_type = 'purchase'` 验证，因组合内没有这个样本而返回 0 行。后来将等值演示改为该用户实际存在的 `click`，重新执行 `EXPLAIN` 和 `EXPLAIN ANALYZE`，避免用空结果解释排序。

## 缺少前导列：能扫描索引，不能直接定位

查询只给出联合索引的第二列：

```sql
EXPLAIN
SELECT id, user_id, event_type, created_at
FROM user_events
WHERE event_type = 'purchase';
```

关键输出：

| type | key | key_len | rows | Extra |
| --- | --- | ---: | ---: | --- |
| `index` | `idx_user_event_time` | 143 | 99582 | `Using where; Using index` |

执行计划确实“用了索引”，但 `type=index` 表示扫描整棵索引，`rows` 接近 100000，而不是从 `event_type` 直接 seek。联合索引的第一级排序键是 `user_id`，缺少它时，同一个 `event_type` 值分散在不同 `user_id` 区间中，无法形成一个连续的前缀范围。

这解释了为什么“`EXPLAIN` 的 `key` 有值”不足以证明访问路径理想。还要结合 `type`、`rows` 和 `Extra` 判断优化器是在定位、范围读取，还是做整棵索引扫描。

MySQL 8.0 的索引跳跃扫描在某些低基数前导列和合适谓词下可以跳过前导列，但这不是无条件保证。本次 `user_id` 有 2000 个不同值，优化器没有选择该路径。实际项目里不能通过“列出现在索引里”来推断一定会跳扫。

## 范围列之后的列为什么会退化

给前两列条件，第二列使用范围：

```sql
EXPLAIN
SELECT id, user_id, event_type, created_at
FROM user_events
WHERE user_id = 42
  AND event_type > 'click'
  AND created_at >= '2026-02-01 00:00:00'
LIMIT 20;
```

结果为：

| type | key | key_len | rows | filtered | Extra |
| --- | --- | ---: | ---: | ---: | --- |
| `range` | `idx_user_event_time` | 138 | 1 | 33.33 | `Using where; Using index` |

`event_type` 是字符串类型，`BIGINT` 加 `VARCHAR(32)` 的 `key_len` 是 138，说明范围边界落在 `event_type`，没有继续使用 `created_at`。查询中的 `created_at >= ...` 仍然有效，只是它现在更可能在读取索引记录之后执行过滤。

当第一列是等值条件时，第二列使用范围，索引定位大致可以理解成：

```text
(user_id = 42, event_type > 'click')
                 |
                 +-- 在这个范围内再检查 created_at
```

范围条件会让后续列失去“用边界继续缩小搜索区间”的能力。`created_at` 依然可能出现在 `Using where`、覆盖索引或索引条件下推中，但它不再贡献更精确的 `key_len`。

如果查询里所有前缀列都是等值条件，第三列才可能作为最后一段范围进入 `key_len`：

```sql
EXPLAIN
SELECT id, user_id, event_type, created_at
FROM user_events
WHERE user_id = 42
  AND event_type = 'click'
  AND created_at >= '2026-02-01 00:00:00'
ORDER BY created_at
LIMIT 20;
```

这条查询得到 `type=range`、`key_len=143`、`rows=34`，说明三列都参与了索引范围。`key_len` 从 138 增加到 143，对应 `DATETIME(0)` 的 5 字节。

## ORDER BY 什么时候能利用索引顺序

固定前两列后按第三列排序：

```sql
EXPLAIN
SELECT id, user_id, event_type, created_at
FROM user_events
WHERE user_id = 42
  AND event_type = 'click'
ORDER BY created_at
LIMIT 20;
```

结果为：

| type | key_len | ref | rows | Extra |
| --- | ---: | --- | ---: | --- |
| `ref` | 138 | `const,const` | 50 | `Using index` |

`Extra` 中没有 `Using filesort`。`EXPLAIN ANALYZE` 的执行树也很直接：

```text
-> Limit: 20 row(s)
    -> Covering index lookup on user_events using idx_user_event_time
       (user_id=42, event_type='click')
```

在 `(user_id, event_type)` 被固定成同一个等值组合后，索引内部剩下的排列顺序就是 `created_at`。数据库顺序读取 20 条记录即可返回，不必把全部结果取出来再排序。

如果只固定第一列：

```sql
EXPLAIN
SELECT id, user_id, event_type, created_at
FROM user_events
WHERE user_id = 42
ORDER BY created_at
LIMIT 20;
```

结果为 `type=ref`、`key_len=8`、`Extra=Using index; Using filesort`。`EXPLAIN ANALYZE` 里能看到 `Sort: user_events.created_at`。

原因是 `user_id=42` 范围内仍包含多个 `event_type`。索引局部顺序是 `event_type, created_at`，不是全局的 `created_at`。如果写成 `ORDER BY event_type, created_at`，那么固定 `user_id` 后，索引顺序正好与排序需求一致，但这属于另一种查询模式。

## IN 是多段范围，不保证全局有序

```sql
EXPLAIN
SELECT id, user_id, event_type, created_at
FROM user_events
WHERE user_id = 42
  AND event_type IN ('click', 'purchase')
ORDER BY created_at
LIMIT 20;
```

关键输出：

| type | key_len | rows | Extra |
| --- | ---: | ---: | --- |
| `range` | 138 | 51 | `Using where; Using index; Using filesort` |

`EXPLAIN ANALYZE` 把这个条件拆成两段：

```text
Index range scan ... over
  (user_id = 42 AND event_type = 'click')
  OR (user_id = 42 AND event_type = 'purchase')
-> Sort: user_events.created_at, limit input to 20 row(s) per chunk
```

每个 `event_type` 区间内部的 `created_at` 有序，两个区间之间的 `created_at` 顺序没有保证。将两段结果简单拼接，通常得不到全局有序的 `created_at`，所以优化器仍要安排排序。

这与单值等值条件不同。`event_type='click'` 只产生一个前缀等值组，直接读取 `created_at` 就是有序的；`IN` 仍然是一个范围条件，可能包含多个互相独立的有序段。

## 覆盖索引、回表和 key_len

只查询索引包含的列：

```sql
EXPLAIN
SELECT user_id, event_type, created_at
FROM user_events
WHERE user_id = 42
  AND event_type = 'click';
```

结果为 `type=ref`、`key=idx_user_event_time`、`Extra=Using index`。这里的 `Using index` 表示从二级索引就能取得所需数据，不必逐行回到聚簇索引读取整行。

把 `payload` 加进查询：

```sql
EXPLAIN
SELECT user_id, event_type, created_at, payload
FROM user_events
WHERE user_id = 42
  AND event_type = 'click';
```

仍然使用同一个联合索引，但 `Extra` 为空。`payload` 不在 `idx_user_event_time` 中，需要回表读取完整记录。计划中没有 `Using index`，说明覆盖索引条件已经不成立。

本表主键是 `id`，InnoDB 的二级索引会包含主键列。因此查询 `id, user_id, event_type, created_at` 仍可能形成覆盖索引。这个细节在业务表主键不是自增整数、或者二级索引列很宽时更需要结合实际情况确认。

本次数据类型的 `key_len` 可以拆成：

| 索引列 | 长度 |
| --- | ---: |
| `user_id BIGINT NOT NULL` | 8 |
| `event_type VARCHAR(32) NOT NULL` | 130 |
| 前两列合计 | 138 |
| `created_at DATETIME NOT NULL` | 5 |
| 三列合计 | 143 |

`VARCHAR(32)` 在 `utf8mb4` 下最多占 `32 * 4` 字节，再加 2 字节长度；`DATETIME(0)` 占 5 字节。`key_len` 能帮助判断范围访问实际走到了哪一列，但不能单独用来判断 SQL 快慢。

## 设计联合索引时的检查方法

联合索引的顺序要回到真实查询模式，先列出最常见的等值条件，再考虑范围和排序。一个可执行的检查流程是：

1. 找到同一组查询里反复出现的等值列，把它们放在索引前部。
2. 安排一个用于范围或排序的列，观察 `key_len` 是否到达预期位置。
3. 用 `EXPLAIN` 看 `type` 是 `ref/range` 还是整棵索引扫描。
4. 用 `Extra` 检查是否出现 `Using filesort`，以及查询是否被覆盖。
5. 用 `EXPLAIN ANALYZE` 看实际返回行和执行树，不只看估算 `rows`。

例如当前表的常见查询如果是“某个用户的某类事件按时间游标读取”，`(user_id, event_type, created_at)` 能同时支持前两列等值和第三列顺序。若还有大量查询只按 `event_type` 过滤，这个联合索引不能替代以 `event_type` 开头的索引，或者需要调整索引列顺序。

索引不是越宽越好。增加列可以提高覆盖概率，也会增加索引存储、更新成本和页分裂风险。最终应使用接近真实分布的样本执行计划，而不是仅凭记忆套用一条口诀。

## 参考资料

- [MySQL 8.0 Reference Manual: Multiple-Column Indexes](https://dev.mysql.com/doc/refman/8.0/en/multiple-column-indexes.html)
- [MySQL 8.0 Reference Manual: Range Optimization](https://dev.mysql.com/doc/refman/8.0/en/range-optimization.html)
- [MySQL 8.0 Reference Manual: ORDER BY Optimization](https://dev.mysql.com/doc/refman/8.0/en/order-by-optimization.html)
- [MySQL 8.0 Reference Manual: EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.0/en/explain-output.html)
- [MySQL 8.0 Reference Manual: Use of Index Extensions](https://dev.mysql.com/doc/refman/8.0/en/index-extensions.html)
