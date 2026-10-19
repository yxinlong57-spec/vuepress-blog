---
title: "用 Java 手写一个最小 RAG：从文档切分、向量检索到 Prompt 拼接的完整链路"
description: "用 Java 手写一个最小 RAG：文档切分、向量检索到 Prompt 拼接的完整链路。"
shortTitle: "Java 最小 RAG"
date: 2026-10-11
category:
  - Agent
tag:
  - RAG
  - 向量检索
  - Java
order: 13
---


> 环境：Windows 11、JDK 17.0.12、Maven 3.9.14  
> 依赖：Spring AI 2.0.1（嵌入模型调用）、H2 本地向量存储（可选，本文用内存 List 实现）  
> 说明：本文重点是把 RAG 的每个环节拆开讲清楚，代码可直接跑通最小链路；生产环境仍需接入真实向量数据库和重排策略。

**目录**

- RAG 解决的不是"模型不够聪明"，而是"知识不在参数里"
- 最小 RAG 的五个环节：切分、嵌入、存储、检索、生成
- 第一步：文档切分，不是越细越好
- 第二步：文本嵌入，把语义压缩成向量
- 第三步：向量存储，为什么不能只用 HashMap
- 第四步：相似度检索，Top-K 只是开始
- 第五步：Prompt 拼接，把检索结果喂给模型
- 跑通最小链路：一个可运行的 Java 示例
- 常见的坑和优化方向
- 小结

## RAG 解决的不是"模型不够聪明"，而是"知识不在参数里"

很多人第一次接触 RAG，会把它理解成"让模型更聪明的技术"。这个方向偏了。RAG（Retrieval Augmented Generation，检索增强生成）解决的问题很具体：**模型的参数里没有你需要的知识**。

这些知识可能是：
- 公司内部的产品文档和操作手册
- 刚更新的政策文件和合同条款
- 私有代码库的接口说明
- 用户自己上传的 PDF、Word、Markdown

模型不可能把所有私有数据都训练进参数里——成本、时效、安全都不允许。RAG 的思路是：生成回答之前，先从外部知识库中检索出相关片段，把它们和用户问题一起塞进 Prompt，让模型基于检索到的内容回答。

换个角度说，RAG 做的是"开卷考试"：模型本身的推理能力没变，但它答题时可以翻参考资料。参考资料找得准不准，直接决定回答质量。

这篇文章不打算介绍 LangChain4j 或 Spring AI 的 RAG 组件怎么一键配置。我想把链路拆开，用纯 Java 手写一个最小可用的 RAG，让每个环节都暴露出来。看完以后，你再去看任何框架的 RAG 实现，都能对应到具体步骤。

## 最小 RAG 的五个环节：切分、嵌入、存储、检索、生成

一条完整的 RAG 链路分五个环节：

```text
原始文档 → 文档切分 → 文本嵌入 → 向量存储 → 相似度检索 → Prompt 拼接 → 模型生成
```

每个环节都有自己的设计空间和常见坑：

| 环节 | 核心问题 | 常见做法 | 直接影响 |
| --- | --- | --- | --- |
| 文档切分 | 一块文本多大合适？从哪切开？ | 按字符数、按 token、按段落、按语义 | 召回率：相关信息会不会被切在两块里 |
| 文本嵌入 | 用什么模型？多少维？ | OpenAI Embedding、BGE、M3E | 语义相似度的准确性 |
| 向量存储 | 怎么存？怎么查？ | 向量数据库（Milvus、Pinecone、Chroma） | 检索速度和规模 |
| 相似度检索 | 取 Top 几？要不要重排？ | 余弦相似度、MMR、Reranker | 上下文相关性和冗余度 |
| Prompt 拼接 | 检索结果怎么组织？放哪？ | System Prompt 里、User Message 里 | 模型是否会正确引用上下文 |

下面逐个拆开讲，最后合成一个可运行的最小示例。

## 第一步：文档切分，不是越细越好

文档切分（Chunking）是 RAG 的第一步，也是最容易被低估的一步。切得太大，单块内容噪声多，检索不准；切得太小，上下文断裂，模型拼不出完整答案。

一个常见的误解是"切得越细，召回越准"。实际上，切分粒度需要和用户问题的粒度匹配。如果用户问的是"第三章讲了什么"，你把文档切成 100 字一块，检索出来的碎片根本回答不了这个问题。

### 几种切分策略的对比

**1. 固定长度切分（Fixed-size Chunking）**

最简单的做法：每 N 个字符或 token 切一刀，两块之间保留一点重叠（overlap），避免句子被切断时丢失信息。

```java
public List<String> fixedSizeSplit(String text, int chunkSize, int overlap) {
    List<String> chunks = new ArrayList<>();
    int start = 0;
    while (start < text.length()) {
        int end = Math.min(start + chunkSize, text.length());
        chunks.add(text.substring(start, end));
        start += chunkSize - overlap;
    }
    return chunks;
}
```

优点：实现简单，速度快。  
缺点：可能从句子中间切断，破坏语义完整性。

**2. 按语义单元切分（Semantic Chunking）**

先按段落、句子或 Markdown 标题切，再根据需要合并或拆分。比如：

```java
public List<String> paragraphSplit(String text) {
    // 按空行切分段落
    String[] paragraphs = text.split("\\n\\s*\\n");
    return Arrays.stream(paragraphs)
            .map(String::trim)
            .filter(p -> !p.isEmpty())
            .toList();
}
```

优点：语义完整性好。  
缺点：段落长度差异大，有的太短有的太长。

**3. 递归字符切分（Recursive Character Splitting）**

LangChain 里常用的策略：先按换行切，太大再按句子切，还大再按单词切，最后按字符切。尽量在自然边界处断开。

在最小实现里，我推荐用"按段落切 + 长度超限再二次拆分"的组合。大多数场景够用，实现成本也低。

### 切分大小怎么选

没有万能公式，但有几个判断维度：

- **嵌入模型的最大 token 限制**：单块不能超过模型的输入上限，比如 `text-embedding-3-small` 是 8191 token。
- **用户问题的平均长度**：问题越宏观，块可以越大；问题越具体，块可以越小。
- **Prompt 窗口的剩余空间**：检索结果要塞进 Prompt，块越大，能塞的块数越少。

一个实用的起点：中文 300-500 字一块，重叠 50-100 字。然后根据实际检索效果调整。

## 第二步：文本嵌入，把语义压缩成向量

嵌入（Embedding）就是把一段文本转换成一个固定维度的浮点数向量。语义相近的文本，向量距离也近。这是 RAG 能"按意思找文本"的基础。

嵌入模型的选择直接影响检索质量。常见的选择：

| 模型 | 维度 | 特点 | 适用场景 |
| --- | --- | --- | --- |
| text-embedding-3-small | 1536（可压缩） | OpenAI 官方，质量稳定，按量付费 | 英文为主，预算充足 |
| text-embedding-3-large | 3072（可压缩） | 质量更高，更贵 | 对检索精度要求高 |
| BGE-m3 | 1024 | 开源，中英文效果好 | 私有化部署，中文场景 |
| M3E | 768 | 开源，中文优化 | 中文轻量场景 |

在 Spring AI 里调用嵌入模型很简单：

```java
@Autowired
private EmbeddingModel embeddingModel;

public float[] embed(String text) {
    EmbeddingResponse response = embeddingModel.call(
        new EmbeddingRequest(List.of(text), EmbeddingOptionsBuilder.builder().build())
    );
    return response.getResult().getOutput();
}
```

但理解嵌入的几个特性更重要：

**1. 向量维度不是越高越好**

高维向量能表达更丰富的语义，但存储和计算成本也更高。OpenAI 的 `text-embedding-3-large` 有 3072 维，但可以通过 API 参数压缩到 256 维，质量损失不大。选型时先测你自己的数据集，不要默认选最高维。

**2. 嵌入模型和生成模型是两回事**

很多人以为用 GPT-4 生成就必须用 OpenAI 的嵌入模型。不是的。嵌入只和检索质量相关，生成模型用什么都行。你完全可以用 BGE 做嵌入，用 DeepSeek 做生成。

**3. 嵌入不是无损压缩**

一段 500 字的文本压缩成 1536 个浮点数，必然丢失信息。精细的数字、精确的命名、复杂的逻辑关系，在向量空间里可能区分不开。这也是为什么纯向量检索的召回率有上限，通常需要配合关键词检索或重排。

## 第三步：向量存储，为什么不能只用 HashMap

有了向量，接下来要存起来，以便后续检索。最简单的做法——全部放进内存的 `List` 里，查询时逐条计算相似度。

```java
public class InMemoryVectorStore {
    private final List<VectorDocument> documents = new ArrayList<>();

    public void add(String id, String content, float[] vector) {
        documents.add(new VectorDocument(id, content, vector));
    }

    public List<SearchResult> search(float[] queryVector, int topK) {
        return documents.stream()
            .map(doc -> new SearchResult(doc, cosineSimilarity(queryVector, doc.vector())))
            .sorted((a, b) -> Double.compare(b.score(), a.score()))
            .limit(topK)
            .toList();
    }
}
```

数据量小的时候（几千条以内），线性扫描完全够用。但当文档量到了几万、几十万条，每次查询都要和所有向量算一遍相似度，延迟会非常明显。

这时候就需要向量数据库。向量数据库做的核心优化是**近似最近邻（ANN）索引**：不精确计算每一条的距离，而是用某种数据结构（HNSW、IVF、PQ 等）快速缩小范围，牺牲一点点精度换几十上百倍的速度。

常见向量数据库对比：

| 数据库 | 部署方式 | 特点 | 适用场景 |
| --- | --- | --- | --- |
| Milvus | 独立部署 | 功能最全，分布式，生态成熟 | 大规模生产环境 |
| Pinecone | SaaS | 托管服务，零运维 | 不想自己运维 |
| Chroma | 本地/服务端 | 轻量，Python 生态好 | 原型验证、小规模 |
| PostgreSQL + pgvector | 扩展 | 复用现有 PG，支持 SQL | 已有 PG，向量数据量不大 |
| Redis + RedisVL | 扩展 | 复用 Redis，低延迟 | 缓存级向量检索 |

在最小 RAG 实现里，用内存 List 就够了。等你验证完整个链路、确认检索效果有价值，再考虑迁移到向量数据库。

### 余弦相似度的计算

向量相似度最常用的是余弦相似度（Cosine Similarity），衡量两个向量方向的夹角：

```java
public double cosineSimilarity(float[] a, float[] b) {
    if (a.length != b.length) {
        throw new IllegalArgumentException("Vector dimensions do not match");
    }
    double dotProduct = 0.0;
    double normA = 0.0;
    double normB = 0.0;
    for (int i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA == 0.0 || normB == 0.0) {
        return 0.0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

取值范围是 [-1, 1]，越大表示越相似。文本嵌入的结果通常都是正的，所以实际看到的分数大多在 0 到 1 之间。

## 第四步：相似度检索，Top-K 只是开始

检索环节最朴素的做法是：把用户问题也转成向量，和库里所有向量算相似度，取分数最高的前 K 个。

但直接取 Top-K 有几个问题：

**1. 冗余问题**

前 K 个结果可能内容高度重叠。比如同一段文字在文档里出现了多次，或者相邻两块内容差不多。把它们都塞进 Prompt 是浪费 token。

解决方法：**MMR（Maximal Marginal Relevance）**——先取一个最相关的，然后下一个既要和查询相关，又要和已选的差异大。在相关性和多样性之间做权衡。

**2. 相关性阈值问题**

Top-K 不管相关不相关，总能返回 K 个。如果库里根本没有相关内容，返回的这 K 个就是噪声，模型可能会被误导。

解决方法：设一个相似度阈值，低于阈值的结果直接丢弃，宁可不检索也不塞无关内容。

**3. 检索粒度问题**

有时候最相关的是第 5 块，但答案其实在第 4 块和第 6 块的连接处。只取 Top-K 可能漏掉关键上下文。

解决方法：检索到相关块后，把它前后各一块也带上（上下文窗口扩展），或者在切分时就加大 overlap。

一个实用的检索流程：

```text
1. 问题转成查询向量
2. 初步检索 Top-2K（多取一些，给后面过滤留余量）
3. 按相似度阈值过滤，低于 0.7 的扔掉
4. 用 MMR 做多样性重排，选出最终 Top-K
5. 对每个命中块，扩展其前后相邻块（可选）
```

## 第五步：Prompt 拼接，把检索结果喂给模型

检索到的文本片段不能直接扔给模型。需要组织成清晰的格式，告诉模型：这些是参考资料，请基于它们回答。

一个基础的 RAG Prompt 模板：

```text
你是一个问答助手。请基于以下参考资料回答用户的问题。
如果参考资料中没有相关信息，请直接说"参考资料中没有找到相关内容"，不要编造答案。

参考资料：
---
1. {chunk_1_content}
---
2. {chunk_2_content}
---
...

用户问题：{user_question}
```

几个设计细节：

**1. 参考资料放在哪**

通常放在 System Prompt 或 User Message 里。放在 System Prompt 里，模型更容易"记住"；放在 User Message 里，更灵活，可以每次替换。对大多数 RAG 场景，两者效果差异不大。如果检索结果很长，注意不要超出模型的上下文窗口。

**2. 要不要编号**

编号有两个好处：模型回答时可以引用具体来源（"根据资料 2..."），方便事后核对；另外，编号本身也能帮助模型区分不同的片段。

**3. "不知道"的约束很重要**

一定要明确告诉模型：资料里没有就说不知道。否则模型会基于参数里的知识编造答案，看起来很合理但可能完全不对。这是 RAG 里最常见的幻觉来源之一。

**4. 检索结果的顺序**

相关度高的放前面还是后面？有研究表明，模型对开头和结尾的信息更敏感（首因效应和近因效应）。所以最高相关的放第一个，次高的放最后一个，中间放其他的，可能比严格按分数排序效果更好。

## 跑通最小链路：一个可运行的 Java 示例

下面把五个环节拼起来，写一个最小可用的 RAG 类。为了不依赖外部服务，嵌入部分我用一个模拟实现；你接入真实嵌入模型时，替换 `embed()` 方法即可。

### 项目依赖

```xml
<dependencies>
    <!-- Spring AI 用于调用真实嵌入模型和生成模型 -->
    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-model</artifactId>
        <version>2.0.1</version>
    </dependency>
    <dependency>
        <groupId>org.springframework.ai</groupId>
        <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
        <version>2.0.1</version>
    </dependency>
</dependencies>
```

### 文档切分器

```java
public class TextSplitter {
    private final int chunkSize;
    private final int overlap;

    public TextSplitter(int chunkSize, int overlap) {
        this.chunkSize = chunkSize;
        this.overlap = overlap;
    }

    /**
     * 先按段落切，段落太长的再按固定大小二次切分
     */
    public List<String> split(String text) {
        List<String> result = new ArrayList<>();
        String[] paragraphs = text.split("\\n\\s*\\n");

        for (String paragraph : paragraphs) {
            String trimmed = paragraph.trim();
            if (trimmed.isEmpty()) continue;

            if (trimmed.length() <= chunkSize) {
                result.add(trimmed);
            } else {
                // 超长段落，按固定大小 + 重叠拆分
                int start = 0;
                while (start < trimmed.length()) {
                    int end = Math.min(start + chunkSize, trimmed.length());
                    result.add(trimmed.substring(start, end));
                    start += chunkSize - overlap;
                }
            }
        }
        return result;
    }
}
```

### 内存向量存储

```java
public class InMemoryVectorStore {
    private final List<Chunk> chunks = new ArrayList<>();

    public record Chunk(String id, String content, float[] vector) {}

    public record SearchResult(Chunk chunk, double score) {}

    public void add(Chunk chunk) {
        chunks.add(chunk);
    }

    public List<SearchResult> search(float[] queryVector, int topK, double threshold) {
        return chunks.stream()
            .map(chunk -> new SearchResult(chunk, cosineSimilarity(queryVector, chunk.vector())))
            .filter(result -> result.score() >= threshold)
            .sorted((a, b) -> Double.compare(b.score(), a.score()))
            .limit(topK)
            .toList();
    }

    private double cosineSimilarity(float[] a, float[] b) {
        double dot = 0.0, normA = 0.0, normB = 0.0;
        for (int i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA == 0 || normB == 0) return 0.0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
```

### RAG 服务主类

```java
public class MinimalRAG {
    private final TextSplitter splitter;
    private final InMemoryVectorStore store;
    private final EmbeddingModel embeddingModel;
    private final ChatModel chatModel;

    public MinimalRAG(EmbeddingModel embeddingModel, ChatModel chatModel) {
        this.splitter = new TextSplitter(400, 50);
        this.store = new InMemoryVectorStore();
        this.embeddingModel = embeddingModel;
        this.chatModel = chatModel;
    }

    /**
     * 把文档加入知识库
     */
    public void ingestDocument(String documentId, String content) {
        List<String> chunks = splitter.split(content);
        for (int i = 0; i < chunks.size(); i++) {
            String chunkText = chunks.get(i);
            float[] vector = embed(chunkText);
            String chunkId = documentId + "-" + i;
            store.add(new InMemoryVectorStore.Chunk(chunkId, chunkText, vector));
        }
    }

    /**
     * 基于知识库回答问题
     */
    public String answer(String question, int topK, double threshold) {
        // 1. 问题向量化
        float[] queryVector = embed(question);

        // 2. 检索相关片段
        List<InMemoryVectorStore.SearchResult> results = store.search(queryVector, topK, threshold);
        if (results.isEmpty()) {
            return "知识库中没有找到相关内容，无法回答。";
        }

        // 3. 构建 Prompt
        String context = buildContext(results);
        String prompt = buildRAGPrompt(question, context);

        // 4. 调用模型生成回答
        return chatModel.call(prompt);
    }

    private float[] embed(String text) {
        EmbeddingResponse response = embeddingModel.call(
            new EmbeddingRequest(List.of(text), EmbeddingOptionsBuilder.builder().build())
        );
        return response.getResult().getOutput();
    }

    private String buildContext(List<InMemoryVectorStore.SearchResult> results) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < results.size(); i++) {
            sb.append("[").append(i + 1).append("] ")
              .append(results.get(i).chunk().content())
              .append("\n\n");
        }
        return sb.toString();
    }

    private String buildRAGPrompt(String question, String context) {
        return """
            你是一个专业的问答助手。请严格基于以下参考资料回答用户的问题。
            如果参考资料中没有相关信息，请明确说"参考资料中未找到相关内容"，不要编造答案。
            回答时可以引用资料编号，例如"根据资料[1]"。

            参考资料：
            %s

            用户问题：%s
            """.formatted(context, question);
    }
}
```

### 使用示例

```java
public class RAGDemo {
    public static void main(String[] args) {
        // 初始化模型（实际使用时从 Spring 容器获取）
        EmbeddingModel embeddingModel = ...; // OpenAiEmbeddingModel 或其他
        ChatModel chatModel = ...;           // OpenAiChatModel 或其他

        MinimalRAG rag = new MinimalRAG(embeddingModel, chatModel);

        // 灌入文档
        String doc = """
            Spring AI 是 Spring 生态中的 AI 应用开发框架。
            它提供了对多种大模型的抽象，包括 ChatModel、EmbeddingModel、ImageModel 等。

            工具调用（Tool Calling）是 Agent 的核心能力之一。
            Spring AI 通过 @Tool 注解将 Java 方法暴露给模型调用。
            DefaultToolCallingManager 负责执行工具调用的完整链路，
            包括工具查找、参数解析、异常处理和调用上限控制。

            RAG（检索增强生成）是一种将外部知识检索与大模型生成结合的技术。
            它的核心流程包括文档切分、向量化、向量存储、相似度检索和 Prompt 拼接。
            RAG 可以有效解决大模型知识滞后和幻觉问题。
            """;

        rag.ingestDocument("doc-spring-ai", doc);

        // 提问
        String answer = rag.answer("Spring AI 的工具调用是怎么实现的？", 3, 0.7);
        System.out.println(answer);
    }
}
```

## 常见的坑和优化方向

把最小链路跑通只是开始。真正落地时，还有几个问题必须面对：

### 1. 检索不准怎么办

检索不准是 RAG 最常见的问题。可能的原因和对策：

- **切分粒度不对**：调大或调小 chunk size，检查最相关的内容是不是刚好被切散了
- **嵌入模型不匹配**：中文场景试试 BGE 或 M3E，不一定比 OpenAI 的差
- **只靠向量检索不够**：加上关键词检索（BM25）做混合检索，通常能提升 5-10 个百分点
- **加入重排（Reranker）**：先用向量召回 Top-20，再用交叉编码器重排取 Top-3，效果提升明显

### 2. 模型不引用上下文怎么办

有时候检索结果是对的，但模型不照着回答，而是用自己参数里的知识。对策：

- Prompt 里强化"只能基于参考资料回答"的约束
- 把参考资料放在更醒目的位置，用明确的分隔符
- 用更听话的模型（比如 GPT-4o 通常比小模型更听话）
- 在 Few-shot 示例里展示正确的引用方式

### 3. 上下文太长怎么办

文档多了以后，检索结果可能很长，超出 Prompt 窗口或造成浪费：

- 减小 Top-K
- 用 MMR 减少冗余
- 对检索结果做摘要压缩（Map-Reduce 模式）
- 用更小的 chunk size，但要保证语义完整

### 4. 如何评估 RAG 效果

不能靠"感觉回答得不错"来判断。至少要有几个定量指标：

- **召回率（Recall）**：标准答案所在的块有没有被检索出来
- **准确率（Precision）**：检索出来的块有多少是真的相关
- **回答正确率**：最终回答对不对，可以用 LLM-as-judge 辅助评估
- **引用准确率**：回答中引用的资料是不是真的支持这个结论

## 小结

RAG 的原理不复杂，但每个环节都有设计空间。把最小链路手写一遍的价值在于：你知道每个参数在影响什么，出了问题知道从哪查。

这篇文章的最小实现用了内存存储和基础相似度检索，适合学习和原型验证。走向生产的路径大致是：

1. 先跑通最小链路，确认 RAG 对你的场景有价值
2. 接入真实向量数据库，解决规模问题
3. 加入混合检索和重排，提升召回质量
4. 建立评测集，用量化指标驱动优化
5. 逐步加入查询改写、多轮对话、元数据过滤等高级特性

每一步都有对应的框架和工具，但核心环节永远是那五个：切分、嵌入、存储、检索、生成。理解了它们，换任何框架都只是换 API。

---

**标签**：Java、RAG、Spring AI、向量检索、嵌入模型、Agent

**参考资料**：
- Spring AI 官方文档：https://docs.spring.io/spring-ai/reference/
- Azure Search OpenAI Demo (Java)：https://learn.microsoft.com/en-us/samples/azure-samples/azure-search-openai-demo-java/
- A Survey on Retrieval-Augmented Generation for Large Language Models
