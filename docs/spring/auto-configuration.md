---
title: "Spring Boot 自动装配到底自动了什么？从 @EnableAutoConfiguration 读到条件装配"
shortTitle: "自动装配原理"
date: 2026-10-19
description: "拆解 Spring Boot 自动装配的完整链路：@EnableAutoConfiguration、AutoConfigurationImportSelector、spring.factories 到 .imports 文件的版本变化、@Conditional 条件装配，以及自定义 Starter 的最小实现。"
category:
  - Spring
tag:
  - Spring Boot
  - 自动装配
  - 源码
order: 2
---


> 版本基准：Spring Boot 3.2.x（要求 JDK 17），源码来自 `spring-boot-autoconfigure-3.2.x.jar`；关键差异点注明 Spring Boot 2.7 及更早版本的行为。

引入 `spring-boot-starter-web` 之后，pom 里没有写任何配置类，Tomcat 却自己起来了，`DispatcherServlet` 也注册好了。这个"自己"背后做的事其实可以压缩成一句话：在容器刷新阶段，Spring Boot 把各个 jar 里预先列好的配置类名单读出来，按条件筛选，筛选通过的注册成 `BeanDefinition`，剩下的交给 Spring 容器正常实例化。

自动装配没有任何运行时魔法，它发生在启动期，全部入口都能从 `@SpringBootApplication` 一个注解追下去。这篇文章就沿着这条链路把源码读一遍，最后写一个最小的自定义 Starter 把流程跑通。

## 目录

- @SpringBootApplication 只是三个注解的打包
- 加载链路：@EnableAutoConfiguration 到 AutoConfigurationImportSelector
- 候选名单从哪读：2.7 是一道分界线
- 条件装配：@Conditional 家族如何让配置按需生效
- 时机：自动装配在容器启动的哪一步执行
- 动手写一个最小的自定义 Starter
- 面试怎么答

## @SpringBootApplication 只是三个注解的打包

启动类上这一个注解，实际是三个注解的组合（源码：`org.springframework.boot.autoconfigure.SpringBootApplication`）：

```java
@SpringBootConfiguration
@EnableAutoConfiguration
@ComponentScan(excludeFilters = {
        @Filter(type = FilterType.CUSTOM, classes = TypeExcludeFilter.class),
        @Filter(type = FilterType.CUSTOM, classes = AutoConfigurationExcludeFilter.class) })
public @interface SpringBootApplication {
    // ...
}
```

三个注解各管一件事：

| 注解 | 职责 |
| --- | --- |
| `@SpringBootConfiguration` | 就是 `@Configuration` 的特化，语义上标记"这是主配置类"，一个应用最好只有一个 |
| `@ComponentScan` | 以启动类所在包为根做组件扫描，这解释了为什么启动类要放在根包 |
| `@EnableAutoConfiguration` | 自动装配的总开关，真正干活的部分 |

`@ComponentScan` 上的 `AutoConfigurationExcludeFilter` 值得留意：它把自动配置类从普通组件扫描里排除掉，保证自动配置类只走自动装配这一条受控通道，而不是被扫描两遍。

需要排除某个自动配置时，不一定要拆注解。`@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)` 和配置项 `spring.autoconfigure.exclude` 是等价的，都透传到 `@EnableAutoConfiguration` 的排除逻辑里。

顺便澄清一个常见误解：`@ComponentScan` 默认只扫启动类所在包及子包，而各个 starter 的自动配置类散落在别人的 jar 包里，根本不在扫描范围内。所以"自动装配靠包扫描找到配置类"这个说法是错的——扫描和自动装配是两条独立的通道，前者找业务组件，后者读固定名单，这也解释了为什么引入一个 starter 不需要改任何扫描配置。

## 加载链路：@EnableAutoConfiguration 到 AutoConfigurationImportSelector

`@EnableAutoConfiguration` 的源码很短，核心就两行（源码：`org.springframework.boot.autoconfigure.EnableAutoConfiguration`）：

```java
@AutoConfigurationPackage
@Import(AutoConfigurationImportSelector.class)
public @interface EnableAutoConfiguration {

    String ENABLED_OVERRIDE_PROPERTY = "spring.boot.enableautoconfiguration";

    Class<?>[] exclude() default {};

    String[] excludeName() default {};
}
```

`@AutoConfigurationPackage` 通过内部的 `Registrar` 把启动类所在的包名注册进容器，供 JPA 实体扫描这类场景使用，可以一笔带过。关键是 `@Import` 导入的 `AutoConfigurationImportSelector`，它实现的接口是 `DeferredImportSelector`——延迟导入选择器。"延迟"这两个字后面讲时机时会回来展开。

这个类的核心方法是 `getAutoConfigurationEntry`（源码：`AutoConfigurationImportSelector`），流程是固定的五步：

```java
protected AutoConfigurationEntry getAutoConfigurationEntry(AnnotationMetadata annotationMetadata) {
    if (!isEnabled(annotationMetadata)) {
        return EMPTY_ENTRY;
    }
    AnnotationAttributes attributes = getAttributes(annotationMetadata);
    List<String> configurations = getCandidateConfigurations(annotationMetadata, attributes);
    configurations = removeDuplicates(configurations);
    Set<String> exclusions = getExclusions(annotationMetadata, attributes);
    checkExcludedClasses(configurations, exclusions);
    configurations.removeAll(exclusions);
    configurations = getConfigurationClassFilter().filter(configurations);
    fireAutoConfigurationImportEvents(configurations, exclusions);
    return new AutoConfigurationEntry(configurations, exclusions);
}
```

读出来是一条清晰的流水线：**读候选名单 → 去重 → 处理 exclude → 条件过滤 → 返回**。`isEnabled` 检查环境属性 `spring.boot.enableautoconfiguration`，默认 true，这也是彻底关掉自动装配的总阀门。

整条链路到这里只剩一个问题：候选名单是从哪个文件读出来的。这个问题在不同版本里答案不一样。

## 候选名单从哪读：2.7 是一道分界线

Spring Boot 3.x 里，`getCandidateConfigurations` 的实现是：

```java
protected List<String> getCandidateConfigurations(AnnotationMetadata metadata, AnnotationAttributes attributes) {
    List<String> configurations = ImportCandidates.load(AutoConfiguration.class, getBeanClassLoader())
            .getCandidates();
    // ... 名单为空时抛出带提示的异常
    return configurations;
}
```

`ImportCandidates.load` 读的是每个 jar 包下的固定路径文件：

```text
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

格式极简单，每行一个自动配置类的全限定名。拆开 `spring-boot-autoconfigure-3.2.x.jar` 能看到这个文件里列了一百多个类，`DataSourceAutoConfiguration`、`DispatcherServletAutoConfiguration`、`TomcatServletWebServerFactory` 所在的 `ServletWebServerFactoryAutoConfiguration` 都在其中。而在 3.x 里，`spring.factories` 已经**不再用于注册自动配置候选**。

有一个细节能印证这个切换的彻底程度：3.x 里如果一个候选都没读到，`getCandidateConfigurations` 会抛出异常，异常信息直接写明 "No auto configuration classes found in META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports"，并提示如果你在用自定义 starter，要检查文件路径是否写对。这个提示本身就是官方给出的迁移指引。

版本差异整理如下：

| 版本 | 候选名单位置 | 说明 |
| --- | --- | --- |
| 2.6 及更早 | `META-INF/spring.factories`，key 为 `EnableAutoConfiguration` 全限定名 | value 逗号分隔多个类 |
| 2.7 | 新旧两种并存，新 `.imports` 文件优先 | 旧方式标记过时，给生态留迁移窗口 |
| 3.x | 只读 `.imports` 文件 | 老 starter 只写 `spring.factories` 的话，升级到 3.x 后自动配置直接失效 |

两个容易记错的边界：

1. **`spring.factories` 在 3.x 没有被整体废弃**。`AutoConfigurationImportFilter`、`FailureAnalyzer`、`ApplicationListener` 等 SPI 仍然通过 `SpringFactoriesLoader` 从 `spring.factories` 加载，只是自动配置候选这一项搬了家。说"3.x 抛弃了 spring.factories"是不准确的。
2. 2.7 同时引入了 `@AutoConfiguration` 注解，它本质是 `@Configuration(proxyBeanMethods = false)` 加上 `before`/`after` 排序属性。3.x 的自动配置类都用它替代普通 `@Configuration`，lite 模式下 `@Bean` 方法之间不做代理增强，换来一点启动速度。

## 条件装配：@Conditional 家族如何让配置按需生效

一百多个候选类如果全部注册，"自动"就变成"乱动"。过滤靠两层条件机制。

第一层在候选名单阶段：`AutoConfigurationImportSelector` 里的 `ConfigurationClassFilter` 会调用所有 `AutoConfigurationImportFilter` 实现（这些过滤器在 spring-boot-autoconfigure 的 `spring.factories` 里注册，3.x 有三个：`OnClassCondition`、`OnWebApplicationCondition`、`OnBeanCondition`）。这一层只做不依赖 `BeanDefinition` 状态的廉价判断，比如类路径下有没有某个类。`OnBeanCondition` 在这一层直接放行——此时 Bean 定义还不全，判断不了。

第二层在配置类注册成 `BeanDefinition` 时，由 Spring 框架的 `ConditionEvaluator` 逐个评估类和方法上的 `@Conditional` 注解。常用的是这一族：

| 注解 | 生效条件 |
| --- | --- |
| `@ConditionalOnClass` / `@ConditionalOnMissingClass` | 类路径存在 / 不存在指定类 |
| `@ConditionalOnBean` / `@ConditionalOnMissingBean` | 容器中存在 / 不存在指定 Bean |
| `@ConditionalOnProperty` | 配置项匹配指定值，`matchIfMissing` 控制缺省行为 |
| `@ConditionalOnWebApplication` | 当前是（或不是）Web 应用，可细分 SERVLET / REACTIVE |
| `@ConditionalOnSingleCandidate` | 某类型 Bean 只有一个或有一个首选 |
| `@ConditionalOnResource` / `@ConditionalOnExpression` | 资源存在 / SpEL 表达式为真 |

看一个真实例子（源码：`DataSourceAutoConfiguration`）：

```java
@AutoConfiguration
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })
@ConditionalOnMissingBean(type = "io.r2dbc.spi.ConnectionFactory")
@EnableConfigurationProperties(DataSourceProperties.class)
@Import(DataSourcePoolMetadataProvidersConfiguration.class)
public class DataSourceAutoConfiguration {
    // ...
}
```

译成自然语言：只有类路径下存在 `DataSource`（即引入了 JDBC 相关依赖）、且容器里没有 R2DBC 连接工厂时，这个配置类才生效。`spring-boot-starter-jdbc` 一引入，条件满足，数据源就有了；没引入，这个类连 `BeanDefinition` 都不会注册。

属性开关是另一种常见形态。`@ConditionalOnProperty` 允许用配置项直接控制某个 Bean 的存亡，`matchIfMissing` 决定配置项缺省时的默认行为：

```java
@Bean
@ConditionalOnProperty(prefix = "spring.task.scheduling", name = "enabled", havingValue = "true", matchIfMissing = true)
public ThreadPoolTaskScheduler taskScheduler(TaskSchedulingProperties properties) {
    // ...
}
```

这类写法在官方自动配置里大量出现，效果是把"是否启用某功能"变成一行 `application.properties` 的事，使用者不用 exclude 整个配置类。

这里有一个顺序上的关键设计：**`@ConditionalOnMissingBean` 要成立，必须保证用户自己的配置先于自动配置被处理**。用户已经定义了 `DataSource`，自动配置看到"不缺"就退让；如果顺序反过来，自动配置抢先注册，用户配置反而被挡。这正是 `AutoConfigurationImportSelector` 实现 `DeferredImportSelector` 的原因——延迟到所有常规配置类处理完之后才执行。

推论也很直接：`@ConditionalOnBean`、`@ConditionalOnMissingBean` 只适合写在自动配置类里，因为自动配置类的处理顺序由框架保证。写在普通业务 `@Configuration` 上，容器扫描顺序不受你控制，结果可能时灵时不灵。

## 时机：自动装配在容器启动的哪一步执行

把链路放回 `AbstractApplicationContext.refresh()` 的标准流程里：

```text
refresh()
 └─ invokeBeanFactoryPostProcessors(beanFactory)
     └─ ConfigurationClassPostProcessor.postProcessBeanDefinitionRegistry
         └─ ConfigurationClassParser 解析所有 @Configuration
             ├─ 普通 @Import / @ComponentScan：立即处理
             └─ DeferredImportSelector：收集分组，所有配置类处理完最后一轮才执行
                 └─ AutoConfigurationGroup：排序后逐条调用 getAutoConfigurationEntry
```

排序在 `AutoConfigurationSorter` 里完成，依据是 `@AutoConfiguration(before/after)`、`@AutoConfigureBefore`、`@AutoConfigureAfter` 和 `@AutoConfigureOrder`，保证比如 `MybatisAutoConfiguration` 排在 `DataSourceAutoConfiguration` 之后。

能走到这一步，前提是 `ConfigurationClassPostProcessor` 已经在容器里。它是 `AnnotatedBeanDefinitionReader` 在注册启动类时顺带注册的（`AnnotationConfigUtils` 那条路），`@SpringBootConfiguration` 继承自 `@Configuration`，启动类因此成为整个解析过程的种子。

要注意这一步只注册 `BeanDefinition`，自动配置类里的 Bean 实例化仍发生在 `refresh()` 末尾的 `finishBeanFactoryInitialization`，和普通单例走同一条路。所以"自动装配"改的是**容器里有哪些 Bean 定义**，并不引入新的实例化机制。

想亲眼看到条件评估结果，启动时加 `debug: true`（或命令行 `--debug`），`ConditionEvaluationReportLoggingApplicationListener` 会打印自动配置报告，分四段：`Positive matches`（条件通过）、`Negative matches`（条件未通过及原因）、`Exclusions`、`Unconditional classes`。排查"为什么我的配置没生效"时，先看 Negative matches 里它缺了哪个条件。

## 动手写一个最小的自定义 Starter

理解了链路，自定义 Starter 就是把框架对官方 starter 做的事照样做一遍。以 3.x 为准，惯例拆两个模块：`greeting-spring-boot-autoconfigure` 放逻辑，`greeting-spring-boot-starter` 只做依赖聚合（pom 里依赖前者）。

第一步，属性类：

```java
@ConfigurationProperties(prefix = "greeting")
public class GreetingProperties {

    /** 问候语前缀 */
    private String prefix = "Hello";

    public String getPrefix() {
        return this.prefix;
    }

    public void setPrefix(String prefix) {
        this.prefix = prefix;
    }
}
```

第二步，业务服务类 `GreetingService`，一个普通 POJO，不依赖任何 Spring 注解——starter 的用户拿到的就是它。

第三步，自动配置类：

```java
@AutoConfiguration
@ConditionalOnClass(GreetingService.class)
@EnableConfigurationProperties(GreetingProperties.class)
public class GreetingAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public GreetingService greetingService(GreetingProperties properties) {
        return new GreetingService(properties.getPrefix());
    }
}
```

第四步，在 autoconfigure 模块的 resources 下创建文件：

```text
META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

内容一行：

```text
com.example.greeting.autoconfigure.GreetingAutoConfiguration
```

三个设计点对应前面的原理：

- `@ConditionalOnClass(GreetingService.class)`：用户只引 starter 却排除掉核心依赖时，配置安静失效而不是报 `NoClassDefFoundError`。
- `@ConditionalOnMissingBean`：把覆盖权留给用户。用户自己声明一个 `GreetingService` Bean，默认实现就退让，这是所有官方 starter 的统一礼仪。
- 如果 starter 需要同时兼容 Spring Boot 2.x 使用者，得额外维护一份 `META-INF/spring.factories`，用 `EnableAutoConfiguration` 作 key 写同一个类；只面向 3.x 就不必。

发布到本地仓库后，在另一个项目里只加 starter 依赖就能注入使用：

```java
@RestController
public class DemoController {

    private final GreetingService greetingService;

    public DemoController(GreetingService greetingService) {
        this.greetingService = greetingService;
    }
}
```

想验证"退让"是否生效，就在使用方自己声明一个同类型 `@Bean`，再看自动配置报告里 `GreetingAutoConfiguration` 是否出现在 Negative matches、原因是 `@ConditionalOnMissingBean` 找到了已有 Bean。这条验证路径和排查官方 starter 问题时完全一样。

## 面试怎么答

30 秒版本：自动装配的入口是 `@SpringBootApplication` 里的 `@EnableAutoConfiguration`，它通过 `@Import` 引入 `AutoConfigurationImportSelector`。这个类在容器刷新的 `invokeBeanFactoryPostProcessors` 阶段，从所有 jar 的 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 读出候选配置类名单，经过去重、排除和 `@ConditionalOnClass` 等条件过滤后，把生效的配置类注册成 `BeanDefinition`。它实现的是 `DeferredImportSelector`，保证用户配置先处理、自动配置兜底，这样 `@ConditionalOnMissingBean` 才能正确判断"缺不缺"。2.7 之前名单读的是 `spring.factories`，这是版本之间最容易被追问的差异点。

能继续往深挖的追问和应答要点：

- **为什么用 DeferredImportSelector？** 答到"让用户配置优先、自动配置兜底"就到位了，可以再补一句排序由 `AutoConfigurationSorter` 按 `@AutoConfigureAfter` 处理。
- **spring.factories 在 3.x 废了吗？** 没有，只是自动配置候选不再从它加载，其他 SPI 仍在用。
- **条件评估发生在什么时候？** 分两层：候选阶段的 `AutoConfigurationImportFilter` 粗筛，和注册 `BeanDefinition` 时 `ConditionEvaluator` 的完整评估；Bean 实例化在 `finishBeanFactoryInitialization`。
- **自己写的 Bean 和自动配置冲突谁赢？** 在自动配置类声明了 `@ConditionalOnMissingBean` 的前提下用户赢；某些自动配置没写这个条件时，要靠 exclude 显式排除。
- **怎么排查自动配置没生效？** `debug=true` 看 ConditionEvaluationReport 的 Negative matches。

回答时最容易露怯的是把整个过程说成"扫描注解"——自动装配不扫描任何业务包，它读的是固定路径的文本名单。

## 总结

总结一下：

1. `@SpringBootApplication` 是 `@SpringBootConfiguration`、`@EnableAutoConfiguration`、`@ComponentScan` 的打包，自动装配的入口在第二个。
2. 加载链路是 `AutoConfigurationImportSelector.getAutoConfigurationEntry` 的五步流水线：读名单、去重、排除、条件过滤、注册。
3. 名单位置以 2.7 为界：之前是 `spring.factories`，3.x 起只用 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`。
4. 条件装配分两层，`@ConditionalOnMissingBean` 的正确性依赖 `DeferredImportSelector` 保证的处理顺序。
5. 自定义 Starter 的核心就是一个 `@AutoConfiguration` 类加一行 `.imports` 文件，外加 `@ConditionalOnMissingBean` 的退让礼仪。

实际开发中我会把 `debug=true` 的条件报告当作排查自动配置问题的第一工具，而不是去猜哪个条件没满足。下一步值得想的问题是：自动装配只管 Bean 的注册，那配置属性（`@ConfigurationProperties`）的绑定和校验又是在哪个环节接入的？这值得单独写一篇。

## 参考

- [Spring Boot Reference: Auto-configuration](https://docs.spring.io/spring-boot/reference/using/auto-configuration.html)
- [Spring Boot Reference: Creating Your Own Auto-configuration](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
- [Spring Boot 3.0 Migration Guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.0-Migration-Guide)
- Spring Boot 3.2.x 源码：`AutoConfigurationImportSelector`、`AutoConfigurationImportSelector$AutoConfigurationGroup`、`DataSourceAutoConfiguration`
