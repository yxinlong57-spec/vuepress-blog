---
title: "MySQL 快照读和当前读有什么区别？一次 SELECT 与 SELECT ... FOR UPDATE 的并发实测"
shortTitle: "快照读与当前读"
date: 2026-10-09
category:
  - MySQL
tag:
  - MySQL
  - 事务
  - 锁
order: 4
---


> 实验环境：Windows 11、MySQL Community Server 8.0.45、InnoDB，默认隔离级别为 `REPEATABLE-READ`。两个会话连接同一个临时实例，B 先更新但不提交，A 分别执行普通 `SELECT` 和 `SELECT ... FOR UPDATE`；输出的时间戳只是本次复现记录。

## 目录

- [先把两类读分清](#先把两类读分清)
- [实验准备和双会话时间线](#实验准备和双会话时间线)
- [普通 SELECT：不等待，也不看未提交版本](#普通-select不等待也不看未提交版本)
- [FOR UPDATE：等待行锁，提交后读最新版本](#for-update等待行锁提交后读最新版本)
- [为什么“当前读绕过 MVCC”不够准确](#为什么当前读绕过-mvcc不够准确)
- [哪些语句需要按当前读理解](#哪些语句需要按当前读理解)
- [业务中怎么选](#业务中怎么选)
- [参考资料](#参考资料)

## 先把两类读分清

普通 `SELECT` 是一致性非锁定读，遇到另一个事务尚未提交的更新时，它不加锁等待，而是按照当前事务的 ReadView 返回可见版本。`SELECT ... FOR UPDATE` 是锁定读，会参与行锁竞争；如果目标记录已经被其他事务加上写锁，它可能等待，等对方提交后再读取最新已提交版本。

这两种行为的差别不只是“读旧值还是读新值”。普通读关心可见性视图，锁定读还要关心锁的获取、等待、超时和锁范围。本文将用一条账户记录观察：B 先把 100 改成 600 但不提交，A 的普通读看到什么，A 的 `FOR UPDATE` 又为什么会等待。

## 实验准备和双会话时间线

实验表只有一行需要观察的数据，余额初始为 100：

```sql
CREATE TABLE accounts (
  id INT PRIMARY KEY,
  owner_name VARCHAR(32) NOT NULL,
  balance INT NOT NULL
) ENGINE = InnoDB;

INSERT INTO accounts (id, owner_name, balance)
VALUES (1, 'alice', 100), (2, 'bob', 1000);
```

两个会话都使用 `REPEATABLE READ`。B 的执行顺序是：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
UPDATE accounts SET balance = 600 WHERE id = 1;

SELECT NOW(6) AS sample_time,
       'B1 uncommitted update is holding the row lock' AS step,
       balance
FROM accounts
WHERE id = 1;

DO SLEEP(5);
COMMIT;
```

B 在自己的事务里能看到 600，同时持有 `id=1` 这行对应的写锁：

```text
2026-10-08 21:38:48.150907 | B1 uncommitted update is holding the row lock | 600
```

A 在 B 尚未提交时启动事务，先做两次普通读取：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;

SELECT NOW(6) AS sample_time,
       'A1 snapshot read after B uncommitted update' AS step,
       balance
FROM accounts
WHERE id = 1;

DO SLEEP(1);

SELECT NOW(6) AS sample_time,
       'A2 snapshot read while B is uncommitted' AS step,
       balance
FROM accounts
WHERE id = 1;
```

这两次普通 `SELECT` 都返回 100。随后 A 把普通读换成锁定读：

```sql
SET @lock_wait_started = NOW(6);

SELECT NOW(6) AS sample_time,
       'A3 locking current read while B holds the row lock' AS step,
       balance
FROM accounts
WHERE id = 1
FOR UPDATE;

SELECT @lock_wait_started AS lock_wait_started,
       NOW(6) AS lock_wait_finished,
       ROUND(TIMESTAMPDIFF(MICROSECOND, @lock_wait_started, NOW(6)) / 1000, 3)
         AS lock_wait_ms;

COMMIT;
```

完整时间线如下：

```text
2026-10-08 21:38:48.150907 | B1 uncommitted update is holding the row lock | 600
2026-10-08 21:38:49.037438 | A1 snapshot read after B uncommitted update | 100
2026-10-08 21:38:50.050450 | A2 snapshot read while B is uncommitted | 100
2026-10-08 21:38:50.052020 | A3 locking read started, waiting for B
2026-10-08 21:38:53.172468 | B2 committed 100 -> 600 | 600
2026-10-08 21:38:53.172651 | A3 locking read finished | 600
lock_wait_ms = 3120.631
```

这里最值得看的不是 3.12 秒本身，而是两组语句面对同一把未提交写锁时走了不同路径：普通读直接返回当前可见版本；锁定读先停在锁等待上，等 B 提交后再返回最新版本。

## 普通 SELECT：不等待，也不看未提交版本

A 的两次普通读发生在 B 持有写锁期间，实际输出是：

```text
2026-10-08 21:38:49.037438 | A1 snapshot read after B uncommitted update | 100
2026-10-08 21:38:50.050450 | A2 snapshot read while B is uncommitted | 100
```

普通 `SELECT` 是一致性非锁定读，它不需要获取 `id=1` 这行的读锁，因此不会被 B 的写锁阻塞。它也没有读取 B 尚未提交的 600，而是沿着版本可见性规则返回 A 当前可以看见的版本。RR 下这两次读使用同一个一致性读取视图，结果都是 100；换成 RC 后，如果 B 已经提交，后续读取才可能看到新值。

这里有两个不同的判断不能混在一起：

- “不等待”说明普通读没有和写锁发生互斥等待。
- “读到 100”说明未提交事务的修改不满足 A 的可见性条件。

不等待不等于读取了 B 的修改，读到旧值也不是因为 A 的查询被锁住了。若业务要求读取当下的最新值，需要明确这条查询是否应该改成锁定读，而不是期待普通 `SELECT` 自动看到未提交结果。

## FOR UPDATE：等待行锁，提交后读最新版本

A 的锁定读开始时，B 还没有提交。A 的 `FOR UPDATE` 在目标行上申请排他锁，发现锁被 B 持有后进入等待。B 提交后，A 才拿到锁并返回：

```text
A3 locking read started          | 2026-10-08 21:38:50.052020
B2 committed                     | 2026-10-08 21:38:53.172468
A3 locking read finished         | 2026-10-08 21:38:53.172651 | 600
lock_wait_ms                     | 3120.631
```

这次 A 读到 600，因为 B 已经提交，锁定读需要基于当前记录状态完成读取。与普通 `SELECT` 相比，`FOR UPDATE` 多做了两件事：在读取过程中参与锁竞争，并且不沿用此前普通一致性读已经固定的旧视图。

如果 B 回滚，A 不应当把 600 当成 B 的结果；它会根据回滚后的可见状态继续完成读取。是否真的等待、等待多久、是否可能超时，取决于目标记录是否被锁住、锁的兼容性、索引条件和 `innodb_lock_wait_timeout`。

本次 3120.631 ms 是 Windows 本机一次调度记录，也受 B 的 `DO SLEEP(5)` 和具体提交时刻影响。它可以证明 A 在等待锁，不能证明线上一定出现相同延迟，更不能拿来估算优化收益。

## 为什么“当前读绕过 MVCC”不够准确

“当前读绕过 MVCC”作为学习口诀很常见，但把它当作最终结论，会漏掉两个关键点。

第一，当前读没有沿用普通一致性读的 ReadView。它不能只凭事务第一次普通 `SELECT` 时的旧快照返回，而要读取当前锁和当前记录状态，所以 B 提交后 A 能看到 600。

第二，InnoDB 仍有版本、索引和记录结构；所谓“当前”不是跳过所有底层读取步骤。更准确的表达是：

> 当前读不沿用普通一致性读的快照，会在读取时参与锁定，并基于当前已提交状态取得结果。

这句话解释了为什么 `FOR UPDATE` 可能等待。如果只记“绕过 MVCC”，很容易误以为它不用等锁，或以为任何普通 `SELECT` 都能自动获取最新值。实际行为必须同时看一致性读快照和锁竞争两条线。

## 哪些语句需要按当前读理解

常见的锁定读和当前读路径包括：

```sql
SELECT ... FOR UPDATE;
SELECT ... FOR SHARE;
UPDATE ...;
DELETE ...;
```

这些语句都可能在索引记录上获取锁，`UPDATE` 和 `DELETE` 还可能因为索引范围或缺少合适索引锁定更多记录。`INSERT` 在唯一性检查和写行时也有自己的锁与读取路径，不能简单把它归为“读快照”或“直接绕过锁”。

判断锁问题时，至少保存这些上下文：

1. 完整 SQL，不要只保留 `WHERE id = 1` 这样的片段。
2. 表结构、索引和实际执行计划。
3. 每个事务的开始、更新、提交和回滚时间。
4. 锁等待输出、等待时间和 `innodb_lock_wait_timeout`。
5. 隔离级别与 MySQL 版本，因为不同版本的锁实现和优化器路径可能变化。

主键等值的单行实验适合建立基本概念，但不能直接外推到范围查询。范围条件可能涉及间隙锁、临键锁和扫描过程中遇到的记录，锁范围问题需要单独复现。

## 业务中怎么选

只需要在事务内读取稳定版本时，普通 `SELECT` 通常更合适，因为它不等待目标行的写锁。只有读取后还要基于当前版本继续计算、校验并写入时，才需要评估 `FOR UPDATE`，并尽量把锁持有时间缩短。

如果只想读取最新已提交值，又不想和写事务发生长时间锁等待，可以考虑调整隔离级别、使用版本号、重新查询或业务重试，而不是习惯性给所有查询加上 `FOR UPDATE`。如果只想防止他人同时修改，现代业务也可以通过条件更新、唯一约束和状态机减少长事务锁的依赖。

实测给出的方向很清楚：普通读解决“可见版本”问题，锁定读解决“读取并占用当前记录”问题。两者不是简单的快慢选项，选择时要先明确事务需要普通快照，还是需要参与锁竞争。

## 参考资料

- [MySQL 8.0 Reference Manual: Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html)
- [MySQL 8.0 Reference Manual: Locking Reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html)
- [MySQL 8.0 Reference Manual: Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html)
- [MySQL 8.0 Reference Manual: InnoDB Locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html)
- [MySQL 8.0.45 source: trx0trx.cc](https://github.com/mysql/mysql-server/blob/mysql-8.0.45/storage/innobase/trx/trx0trx.cc)
