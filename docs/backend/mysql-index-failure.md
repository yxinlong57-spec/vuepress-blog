---
title: "MySQL 索引为什么会失效？用同一张表前后 EXPLAIN 定位原因"
shortTitle: "MySQL 索引失效"
date: 2026-10-08
category:
  - MySQL
tag:
  - MySQL
  - 索引
  - EXPLAIN
order: 2
---


实验环境：Windows 11，MySQL Community Server 8.0.45，`utf8mb4` 字符集，InnoDB 表，人工造数 100000 行。本文中的行数、访问类型和耗时均来自这一轮本地实验，换一份数据后需要重新执行 `EXPLAIN`。

## 目录

- [先定义什么叫“索引失效”](#先定义什么叫索引失效)
- [实验表与索引设计](#实验表与索引设计)
- [场景一：函数包住索引列](#场景一函数包住索引列)
- [场景二：前导百分号让 LIKE 失去起点](#场景二前导百分号让-like-失去起点)
- [场景三：联合索引缺少前导列](#场景三联合索引缺少前导列)
- [场景四：OR 的一侧没有可用索引](#场景四or-的一侧没有可用索引)
- [场景五：索引可用，但优化器选择其他扫描](#场景五索引可用但优化器选择其他扫描)
- [用 EXPLAIN 快速定位原因](#用-explain-快速定位原因)
- [修复时不要只盯着“有没有索引”](#修复时不要只盯着有没有索引)
- [参考资料](#参考资料)

## 先定义什么叫“索引失效”

`EXPLAIN` 里没有看到目标索引，并不等于索引设计一定错了。MySQL 的优化器会先判断一条谓词是否能形成有效的索引访问路径，再估算不同候选路径的成本。排查时要分清两件事：谓词是否让索引根本不可用，以及索引可用但优化器为什么没有选它。

这轮实验用同一张订单表复现了五类现象，结论是：函数包列和前导百分号会破坏普通索引的定位能力；联合索引缺少前导列时无法从后一列直接 seek；`OR` 的一侧没有访问路径时整体可能退化为扫描；而覆盖范围接近全表时，优化器扫描覆盖索引也可能比回表更便宜。

## 实验表与索引设计

核心表结构如下：

```sql
CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  status TINYINT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  created_at DATETIME NOT NULL,
  remark VARCHAR(80) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_user_status_created (user_id, status, created_at),
  KEY idx_created_at (created_at),
  KEY idx_remark (remark)
) ENGINE = InnoDB;
```

人工数据覆盖 5000 个用户、4 种状态和 30 天时间范围，`remark` 中约千分之一是 `INVOICE-URGENT-*`。执行 `ANALYZE TABLE orders` 后，`SELECT COUNT(*)` 返回 100000。`EXPLAIN` 的 `rows` 是优化器估算，本机实际行数只认 `COUNT(*)`；同一实验里 `information_schema.TABLES.TABLE_ROWS` 曾显示 99951。

## 场景一：函数包住索引列

下面这条查询看起来只是按日期筛选，`created_at` 也确实有索引：

```sql
EXPLAIN
SELECT id, user_id, status, created_at
FROM orders
WHERE DATE(created_at) = '2026-01-15';
```

关键输出如下：

| type | possible_keys | key | key_len | rows | Extra |
| --- | --- | --- | ---: | ---: | --- |
| `index` | `NULL` | `idx_user_status_created` | 14 | 99951 | `Using where; Using index` |

`type=index` 表示这里没有按某个小范围定位，而是扫描了一整棵索引。函数 `DATE(created_at)` 改变了比较对象：B+ 树按照 `created_at` 原值排序，优化器无法从 `'2026-01-15'` 直接推导出一个稳定的原值边界。

换成不包函数的半开区间：

```sql
EXPLAIN
SELECT id, user_id, status, created_at
FROM orders
WHERE created_at >= '2026-01-15 00:00:00'
  AND created_at < '2026-01-16 00:00:00';
```

执行计划变为：

| type | possible_keys | key | key_len | rows | Extra |
| --- | --- | --- | ---: | ---: | --- |
| `range` | `idx_user_status_created,idx_created_at` | `idx_created_at` | 5 | 3333 | `Using index condition` |

为了比较实际读取行数，下面改用两组 `COUNT(*)`。这条查询不需要回表，优化器可能选用与上面 SELECT 不同的覆盖索引，所以不要只对照 `key` 列。`EXPLAIN ANALYZE` 显示，函数写法的覆盖索引扫描读过了 100000 行，过滤后剩 3333 行；范围写法的覆盖索引范围扫描直接读取 3333 行。两者在本机一次运行中约为 48.6 ms 和 2.78 ms。

这些耗时只证明当前数据下两条路径的差异，不能当作固定性能倍数。真正稳定的判断是：把函数移动出去、把列单独放在比较符一侧，普通 B+ 树索引才有机会形成范围访问。

MySQL 8.0 支持函数索引，确实可以为常用表达式建立单独索引。但建立函数索引后要通过 `EXPLAIN` 确认它被选中，不能只根据“语法上支持”就认为原查询自动变快。

## 场景二：前导百分号让 LIKE 失去起点

前导百分号的查询如下：

```sql
EXPLAIN
SELECT id, user_id, remark
FROM orders
WHERE remark LIKE '%INVOICE-URGENT-%';
```

结果为：

| type | possible_keys | key | rows | Extra |
| --- | --- | --- | ---: | --- |
| `ALL` | `NULL` | `NULL` | 99951 | `Using where` |

把百分号移到最后：

```sql
EXPLAIN
SELECT id, user_id, remark
FROM orders
WHERE remark LIKE 'INVOICE-URGENT-%';
```

结果为：

| type | possible_keys | key | rows | Extra |
| --- | --- | --- | ---: | --- |
| `range` | `idx_remark` | `idx_remark` | 100 | `Using index condition` |

索引按字符串前缀排序。`'INVOICE-URGENT-'` 能确定一个连续的前缀区间，前导 `%` 则表示前缀未知，优化器没有起点可以用于 seek。这里的 `Using index condition` 是索引条件下推：先通过访问路径拿到索引记录，再把能下推的条件放到存储引擎层筛选。

字符串索引还有一个容易忽略的边界。`LIKE 'abc%'` 通常比 `LIKE '%abc%'` 更容易形成范围访问，但列字符集、排序规则、大小写规则和实际前缀选择率仍会影响最终计划，不能只凭写法断言性能。

## 场景三：联合索引缺少前导列

表的联合索引是 `(user_id, status, created_at)`。下面查询只给了第二列和一个非索引列：

```sql
EXPLAIN
SELECT id, user_id, status, amount
FROM orders
WHERE status = 1
  AND amount BETWEEN 100 AND 120;
```

结果为：

| type | possible_keys | key | rows | Extra |
| --- | --- | --- | ---: | --- |
| `ALL` | `NULL` | `NULL` | 99951 | `Using where` |

`status` 虽然会出现在索引记录里，但联合索引的第一级排序键是 `user_id`。优化器无法在缺少 `user_id` 条件时，直接按 `status` 找到一个连续区间。

同一张表给出前两列条件后，执行计划完全不同：

```sql
EXPLAIN
SELECT id, user_id, status, amount
FROM orders
WHERE user_id = 1234
  AND status = 1;
```

结果为 `type=ref`、`key=idx_user_status_created`、`key_len=9`、`ref=const,const`，估算只扫描 20 行。`user_id BIGINT NOT NULL` 占 8 字节，`status TINYINT NOT NULL` 占 1 字节，所以前两列的 `key_len` 是 9。

这里也能解释一个常见误区：联合索引并不是只能匹配完整的三列。只要条件从最左列开始连续出现，优化器就可能使用对应前缀；条件跳过第一列，通常不能直接定位。

## 场景四：OR 的一侧没有可用索引

```sql
EXPLAIN
SELECT id, user_id, amount
FROM orders
WHERE user_id = 1234
   OR amount = 123.45;
```

结果为：

| type | possible_keys | key | rows | Extra |
| --- | --- | --- | ---: | --- |
| `ALL` | `idx_user_status_created` | `NULL` | 99951 | `Using where` |

`possible_keys` 里有联合索引，说明优化器看到了 `user_id` 一侧的候选路径。但 `amount` 没有索引，另一侧只能逐行判断。只要 `OR` 中任意一行满足条件，结果就要保留，优化器无法先把整体限制在一个小范围内。

这并不表示所有 `OR` 都会导致全表扫描。如果两侧分别有可用的索引访问路径，MySQL 可能计算多个范围，也可能使用索引合并。排查时应该分别看每个分支，不要直接套用“出现 OR 就是索引失效”。

## 场景五：索引可用，但优化器选择其他扫描

最后一个现象最容易被误判：

```sql
EXPLAIN
SELECT id, user_id, created_at
FROM orders
WHERE created_at >= '2026-01-01 00:00:00';
```

执行计划为：

| type | possible_keys | key | key_len | rows | Extra |
| --- | --- | --- | ---: | ---: | --- |
| `index` | `idx_user_status_created,idx_created_at` | `idx_user_status_created` | 14 | 99951 | `Using where; Using index` |

`possible_keys` 中确实有 `idx_created_at`，所以不能说这个索引“失效了”。造数范围从 `2026-01-01` 开始，这个下界覆盖全部记录，范围条件没有缩小结果集。此时扫描一棵覆盖二级索引，可能比先走不太有选择性的范围、再频繁回表更便宜。

优化器选择索引时并不只看“条件里有没有这个列”，还会参考统计信息、访问行数、回表成本和排序要求。MySQL 官方文档也说明，`possible_keys` 表示可供选择的索引，`key` 才是最终实际使用的索引，两者本来就可能不同。

要确认是成本选择还是谓词限制，可以固定小样本做对照。例如把时间范围缩短到一天，观察 `rows` 和 `key` 是否变化；也可以打开优化器跟踪查看候选方案的成本。不要仅凭 `key` 和预期不一致就删除或重建索引。

## 用 EXPLAIN 快速定位原因

遇到“建了索引却没走”，优先看下面几列：

| 列 | 要回答的问题 |
| --- | --- |
| `type` | 是大范围扫描、全表扫描，还是 `range/ref` 这类定位访问 |
| `possible_keys` | 优化器有没有找到候选索引 |
| `key` | 最终采用了哪个索引 |
| `rows` | 优化器预计需要读多少行，注意它只是估算 |
| `filtered` | 读取到的记录还能剩下多少比例 |
| `Extra` | 是否覆盖索引、是否索引条件下推、是否需要排序或临时表 |

`possible_keys=NULL` 和 `key=NULL` 同时出现，往往说明谓词没有形成候选访问路径，例如前导百分号或缺少联合索引前导列。`possible_keys` 有值而 `key` 没有选，或者选择了另一个覆盖索引，更可能是成本选择，需要结合数据分布继续判断。

如果过滤条件使用了函数，先尝试把列单独放到比较符一侧，并用等价的半开区间改写时间范围：

```sql
-- 不利于普通索引定位
WHERE DATE(created_at) = '2026-01-15'

-- 更容易形成范围访问
WHERE created_at >= '2026-01-15 00:00:00'
  AND created_at < '2026-01-16 00:00:00'
```

如果问题来自联合索引，检查条件是否连续从最左列开始。把高选择性的等值条件放在联合索引前部，再根据查询模式安排范围列和排序列，通常比机械追求“列越多越好”更有效。最终仍要用 `EXPLAIN` 和真实数据验证。

## 修复时不要只盯着“有没有索引”

一次排查可以先按这个顺序做：

1. 用实际 SQL 跑 `EXPLAIN`，不要只看建表语句。
2. 确认谓词是否对索引列做了函数、隐式类型转换或前导模糊匹配。
3. 对联合索引检查最左连续前缀，而不是只看列是否出现在 `WHERE` 中。
4. 查看 `OR` 的每个分支有没有各自可用的路径。
5. 如果 `possible_keys` 有候选但没被选，检查选择率和成本，不要立刻删除索引。
6. 改写后用 `EXPLAIN ANALYZE` 比较实际读取行数和排序情况，并记录版本与数据分布。

“索引失效”适合作为搜索词，不适合作为最终诊断。更准确的说法是：这条 SQL 没有形成预期的索引访问路径，或者优化器在可用路径中选择了成本更低的另一种扫描方式。把这两个判断分开，修复方向通常就清楚了。

## 参考资料

- [MySQL 8.0 Reference Manual: EXPLAIN Output Format](https://dev.mysql.com/doc/refman/8.0/en/explain-output.html)
- [MySQL 8.0 Reference Manual: How MySQL Uses Indexes](https://dev.mysql.com/doc/refman/8.0/en/mysql-indexes.html)
- [MySQL 8.0 Reference Manual: Multiple-Column Indexes](https://dev.mysql.com/doc/refman/8.0/en/multiple-column-indexes.html)
- [MySQL 8.0 Reference Manual: Range Optimization](https://dev.mysql.com/doc/refman/8.0/en/range-optimization.html)
- [MySQL 8.0 Reference Manual: Optimizer Trace](https://dev.mysql.com/doc/refman/8.0/en/optimizer-trace.html)
