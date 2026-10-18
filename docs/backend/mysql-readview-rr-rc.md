---
title: "MySQL 可重复读到底重复在哪？RR 和 RC 的 ReadView 时机实测"
shortTitle: "RR 与 RC 的 ReadView"
date: 2026-10-09
category:
  - MySQL
tag:
  - MySQL
  - 事务
  - MVCC
  - ReadView
order: 3
---


> 实验环境：Windows 11、MySQL Community Server 8.0.45、InnoDB，默认隔离级别为 `REPEATABLE-READ`。以下 SQL、时间戳和输出来自本机两个并发会话的实测，版本和数据分布发生变化时应重新验证。

## 目录

- [先把结论说清楚](#先把结论说清楚)
- [实验表和两个会话语义](#实验表和两个会话语义)
- [RR：第一次一致性读建立快照](#rr第一次一致性读建立快照)
- [RC：每次一致性读重新建立快照](#rc每次一致性读重新建立快照)
- [边界：START TRANSACTION 不等于立刻生成 ReadView](#边界start-transaction-不等于立刻生成-readview)
- [ReadView 在源码里做什么](#readview-在源码里做什么)
- [当前读为什么不遵循这套快照](#当前读为什么不遵循这套快照)
- [复现实验时要注意什么](#复现实验时要注意什么)
- [参考资料](#参考资料)

## 先把结论说清楚

RR 的“可重复读”指的是：同一个事务里的普通 `SELECT` 使用同一个 ReadView。这个视图通常在该事务第一次一致性读时建立，后续普通 `SELECT` 复用它，所以其他事务在第一次读之后提交的新值仍然不可见。RC 则不同，每次普通 `SELECT` 都会重新建立读取视图，因此下一次读取可能看到其他事务已经提交的新版本。

这里有两个容易答错的边界：`START TRANSACTION` 本身不能简单理解成已经固定了整张表的快照；`SELECT ... FOR UPDATE`、`UPDATE`、`DELETE` 等当前读也不沿用普通一致性读的 ReadView。本文用三个双会话实验把时点和行为分别证实。

## 实验表和两个会话语义

实验表是一行两列的简化账户表，余额初始为 100：

```sql
CREATE TABLE accounts (
  id INT PRIMARY KEY,
  owner_name VARCHAR(32) NOT NULL,
  balance INT NOT NULL
) ENGINE = InnoDB;

INSERT INTO accounts (id, owner_name, balance)
VALUES (1, 'alice', 100), (2, 'bob', 1000);

SELECT @@version AS mysql_version,
       @@transaction_isolation AS global_isolation;
```

本机初始输出：

```text
mysql_version | global_isolation
8.0.45        | REPEATABLE-READ
```

会话 A 负责在同一事务内读取两次，会话 B 在两次读取之间执行并提交更新。为了让时序可观察，A 在第一次读后执行 `DO SLEEP(5)`，B 在客户端中按顺序执行。两个会话必须连接同一个 MySQL 实例和同一个数据库，不能用两个互不相关的临时快照来观察。

## RR：第一次一致性读建立快照

会话 A 的步骤如下：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;

SELECT NOW(6) AS sample_time,
       'A1 RR first snapshot read' AS step,
       balance
FROM accounts
WHERE id = 1;

DO SLEEP(5);

SELECT NOW(6) AS sample_time,
       'A2 RR second snapshot read after B commit' AS step,
       balance
FROM accounts
WHERE id = 1;

COMMIT;
```

会话 B 在 A 第一次读之后执行：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
UPDATE accounts SET balance = 200 WHERE id = 1;
COMMIT;

SELECT NOW(6) AS sample_time,
       'B committed 100 -> 200' AS step,
       balance
FROM accounts
WHERE id = 1;
```

关键输出如下：

```text
2026-10-08 21:37:46.842411 | A1 RR first snapshot read | 100
2026-10-08 21:37:48.576944 | B committed 100 -> 200 | 200
2026-10-08 21:37:51.859264 | A2 RR second snapshot read after B commit | 100
```

A 的第二次普通 `SELECT` 发生在 B 提交之后，但结果仍然是 100。原因是 A 第一次一致性读已经建立了 ReadView，B 的新事务编号不在这个视图的可见集合里。这里看到的是旧版本，而不是读取失败，也不是 `SELECT` 被锁住等待。

## RC：每次一致性读重新建立快照

为了单独观察 RC，先把余额重置为 100，再让 A 使用 `READ COMMITTED`：

```sql
UPDATE accounts SET balance = 100 WHERE id = 1;

SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;

SELECT NOW(6), balance FROM accounts WHERE id = 1;
DO SLEEP(5);
SELECT NOW(6), balance FROM accounts WHERE id = 1;
COMMIT;
```

会话 B 在两次读之间提交 `100 -> 300`：

```text
2026-10-08 21:37:59.034199 | A1 RC first snapshot read | 100
2026-10-08 21:38:00.735284 | B committed 100 -> 300 | 300
2026-10-08 21:38:04.049592 | A2 RC second snapshot read after B commit | 300
```

这一次 A2 读到了 300。RC 不会把事务开始时或第一次读取时的可见性集合一直沿用下去，每次一致性读都会重新判断哪些事务已经提交。因此，同一个事务中的两次相同查询可能返回不同结果。

RC 与 RR 的差异不是“RC 每次读取都会加锁”，而是“每次一致性读的可见性边界不同”。普通 `SELECT` 在这种场景下仍然是非锁定读。

## 边界：START TRANSACTION 不等于立刻生成 ReadView

把第一次表读取延后，可以看出“事务开始”和“第一次一致性读”不是同一个时点。会话 A 只执行：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
SELECT NOW(6) AS started_at;
DO SLEEP(5);
SELECT NOW(6) AS first_read_at, balance
FROM accounts
WHERE id = 1;
COMMIT;
```

会话 B 在 A 第一次读取 `accounts` 之前提交：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
UPDATE accounts SET balance = 400 WHERE id = 1;
COMMIT;
```

实测输出：

```text
2026-10-08 21:38:16.284075 | A1 transaction started, no table read yet
2026-10-08 21:38:18.030266 | B committed 100 -> 400 before A first read
2026-10-08 21:38:21.295614 | A2 first snapshot read after B commit | 400
```

A 的 `START TRANSACTION` 先发生，但 A 的第一次 `accounts` 一致性读发生在 B 提交之后，所以它看到 400。这个结果说明：在本次普通一致读路径上，ReadView 是在需要一致性读时创建的。

如果业务明确要求在事务开始时获取一致快照，可以使用：

```sql
START TRANSACTION WITH CONSISTENT SNAPSHOT;
```

但不要只依赖语法名称。事务内是否出现当前读、写入、DDL 或其他特殊操作，都会改变实际行为，最终仍要结合版本和 SQL 路径验证。

## ReadView 在源码里做什么

MySQL 8.0.45 的 `trx_assign_read_view()` 源码注释写得很直接：同一个事务内的所有一致性读获得同一个 ReadView，而这个 ReadView 在该函数第一次被调用时创建。`ReadView::prepare()` 记录当前活跃读写事务 ID、事务号的上限边界和创建者事务 ID；后续读取 undo 版本时，用这些信息判断某个事务的修改是否对当前视图可见。

`changes_visible()` 里还有一个很有用的边界：创建者事务 ID 会直接被视为可见。换句话说，事务能看到自己的修改；RR 的“重复读”约束的是其他已提交事务的新版本，不是把自己的 `INSERT`、`UPDATE`、`DELETE` 结果隐藏掉。

可以把判断过程压缩成三步：

1. 第一次普通 `SELECT` 为事务建立 ReadView。
2. 后续普通 `SELECT` 复用这个视图，并沿着版本链寻找对当前视图可见的记录。
3. 创建该 ReadView 的事务自己的修改可见，活跃事务列表中的其他事务则需要按可见性规则继续判断。

源码链接见文末。这里的重点不是背 C++ 字段名，而是理解 RR 和 RC 的差异最终落在“何时打开读取视图、后续是否复用它”上。

## 当前读为什么不遵循这套快照

普通 `SELECT` 是一致性非锁定读；下面这些语句通常会进入锁定读或当前读路径：

```sql
SELECT ... FOR UPDATE;
SELECT ... FOR SHARE;
UPDATE ...;
DELETE ...;
```

它们需要在索引记录上参与锁竞争，读取时不能只拿一个可能已经固定的历史快照来返回结果。`SELECT ... FOR UPDATE` 可能等待其他事务提交或回滚；`UPDATE`、`DELETE` 还可能根据索引范围锁定更多记录。具体锁范围受索引、查询条件和隔离级别影响，不能只凭语句类型下结论。

也不要把它简化成“当前读绕过 MVCC”。更准确的说法是：当前读不沿用普通一致性读的 ReadView，它会读取当前需要的结果并参与锁定；InnoDB 仍要通过版本、记录和索引结构完成读取。下一篇会用“普通 SELECT 看到旧值，而 FOR UPDATE 等待后读最新提交值”的双会话结果专门拆开这个差异。

## 复现实验时要注意什么

1. 确认 `@@version`、`@@transaction_isolation` 和表引擎，不能只在文章结论里写“MySQL”。
2. 两个会话必须使用同一个测试库、同一张表和同一行主键，避免把不同连接的不同快照误当成隔离级别差异。
3. RR 和 RC 分别重置数据，不要把上一轮的 200、300 或 400 带到下一轮。
4. `DO SLEEP(5)` 只用来稳定交叠时序，不是性能测试；不要根据它推断查询耗时。
5. 把 `SELECT NOW(6)` 当作观察工具，而不是业务锁；它不能替代并发测试中的提交确认。
6. 看到第二次读到旧值时，先画一条“事务开始、第一次读、其他事务更新、其他事务提交、第二次读”的时间线，再判断是哪种读取路径。

这组实验适合用来验证基础机制。生产系统里的长事务、连接池、批量更新、二级索引和不同版本的优化器行为，还需要按真实 SQL 继续测量。

## 参考资料

- [MySQL 8.0 Reference Manual: Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html)
- [MySQL 8.0 Reference Manual: InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html)
- [MySQL 8.0 Reference Manual: Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html)
- [MySQL 8.0.45 source: trx0trx.cc](https://github.com/mysql/mysql-server/blob/mysql-8.0.45/storage/innobase/trx/trx0trx.cc)
- [MySQL 8.0.45 source: read0read.cc](https://github.com/mysql/mysql-server/blob/mysql-8.0.45/storage/innobase/read/read0read.cc)
- [MySQL 8.0.45 source: read0types.h](https://github.com/mysql/mysql-server/blob/mysql-8.0.45/storage/innobase/include/read0types.h)
