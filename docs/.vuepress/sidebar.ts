import { sidebar } from "vuepress-theme-hope";

export default sidebar({
  "/java/": [
    "",
    "equals-and-double.md",
    "scanner-nextline.md",
    "arraylist-vs-linkedlist.md",
    "bio-nio-aio.md",
  ],
  "/interview/": [
    "",
    {
      text: "集合与并发",
      icon: "layer-group",
      children: [
        "hashmap-core.md",
        "synchronized-lock-upgrade.md",
        "threadlocal-thread-pool.md",
        "completable-future.md",
      ],
    },
    {
      text: "JVM 实战",
      icon: "microchip",
      children: ["jvm-heap-oom.md"],
    },
    {
      text: "简历与求职",
      icon: "file-lines",
      children: [
        "java-backend-resume.md",
        "heima-mall-resume.md",
        "heima-toutiao-resume.md",
        "heima-comment-resume.md",
      ],
    },
  ],
  "/spring/": ["", "springboot-api-versioning.md"],
  "/backend/": [
    "",
    {
      text: "MySQL",
      icon: "database",
      children: [
        "mysql-leftmost-prefix.md",
        "mysql-index-failure.md",
        "mysql-readview-rr-rc.md",
        "mysql-snapshot-vs-current-read.md",
      ],
    },
    {
      text: "Redis",
      icon: "bolt",
      children: ["redis-cache-three-problems.md"],
    },
    {
      text: "存储与 IO",
      icon: "hard-drive",
      children: ["zero-copy.md", "sql-vs-nosql.md", "nosql-why-faster.md"],
    },
  ],
  "/agent/": [
    "",
    {
      text: "入门与视野",
      icon: "eye",
      children: ["ai-agent-intro.md"],
    },
    {
      text: "协议与框架",
      icon: "diagram-project",
      children: [
        "agent-skills.md",
        "mcp-local-tools.md",
        "mcp-security.md",
        "a2a-vs-mcp.md",
        "multi-agent-architecture.md",
        "springai-vs-langchain4j.md",
      ],
    },
    {
      text: "核心机制",
      icon: "gears",
      children: [
        "minimal-agent-loop.md",
        "function-calling-validation.md",
        "agent-memory.md",
        "agent-evaluation.md",
      ],
    },
    {
      text: "Spring AI 与 RAG",
      icon: "wand-magic-sparkles",
      children: ["springai-tool-calling.md", "java-minimal-rag.md"],
    },
  ],
  "/projects/": ["", "vuepress-blog.md"],
  // 其余页面（首页、阅读指南、关于我）
  "/": [
    "",
    { text: "阅读指南", icon: "flag", link: "/guide/" },
    { text: "关于我", icon: "circle-info", link: "/intro.html" },
  ],
});
