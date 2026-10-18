---
title: Spring Boot 自动装配原理
icon: bolt
date: 2026-10-18
category:
  - Spring
tag:
  - Java
  - Spring
  - 源码阅读
order: 1
star: true
---

# Spring Boot 自动装配原理

> 状态：骨架，待填充。以下为写作大纲与要点提示。

## 核心问题（面试怎么问）

- @SpringBootApplication 里有什么？
- 自动装配的入口在哪？怎么加载第三方依赖的 Bean？
- @Conditional 系列注解起什么作用？
- 自定义 Starter 怎么写？

## 写作大纲

### 1. @SpringBootApplication 三层结构

- @SpringBootConfiguration：本质是 @Configuration
- @ComponentScan：扫描主类所在包
- **@EnableAutoConfiguration：自动装配核心**

### 2. @EnableAutoConfiguration 拆解

- @Import(AutoConfigurationImportSelector.class)
- 读取 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`（2.7+，旧版 spring.factories）
- 加载候选配置类 → 条件过滤 → 注册 BeanDefinition

### 3. 条件注解体系

- @ConditionalOnClass / @ConditionalOnMissingBean / @ConditionalOnProperty
- 配合 `@ConfigurationProperties` 完成属性绑定

### 4. 动手：自定义 Starter

- xxx-autoconfigure + xxx-starter 两模块结构
- 编写配置类 + imports 文件 + 属性类

## 待补充

- [ ] 配图：自动装配流程图
- [ ] 源码：AutoConfigurationImportSelector 关键方法 + 注释
- [ ] 自定义 Starter 完整示例代码
