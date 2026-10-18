import { viteBundler } from "@vuepress/bundler-vite";
import { defineUserConfig } from "vuepress";

import theme from "./theme.js";

export default defineUserConfig({
  bundler: viteBundler(),

  // GitHub Pages 等子路径部署时通过环境变量注入，如 BASE_PATH=/vuepress-blog/
  base: process.env.BASE_PATH || "/",

  lang: "zh-CN",
  title: "Loong 龙栈 LoongStack",
  description:
    "Loong 龙栈：包含 Java 基础、面经手册、并发编程、JVM、Spring 全家桶、MySQL、Redis、消息队列、分布式、Java 实战项目训练…",

  theme,
});
