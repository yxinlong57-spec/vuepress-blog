import { sidebar } from "vuepress-theme-hope";

export default sidebar({
  "/interview/": ["", "hashmap-source.md", "thread-pool.md"],
  "/spring/": ["", "auto-configuration.md"],
  "/backend/": ["", "redis-data-structures.md"],
  "/projects/": ["", "vuepress-blog.md"],
  "/daily/": [""],
  // 其余页面（首页、阅读指南、关于我）
  "/": [
    "",
    { text: "阅读指南", icon: "flag", link: "/guide/" },
    { text: "关于我", icon: "circle-info", link: "/intro.html" },
  ],
});
