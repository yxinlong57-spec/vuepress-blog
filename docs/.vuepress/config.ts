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
    "Loong 龙栈：Java 后端打底，Agent 应用探路——Java 基础、并发、JVM、MySQL、Redis、Spring 实战、Agent / LLM 应用开发，一个计算机学生的技术成长路线。",

  theme,
});
