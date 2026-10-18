import { viteBundler } from "@vuepress/bundler-vite";
import { defineUserConfig } from "vuepress";

import theme from "./theme.js";

export default defineUserConfig({
  bundler: viteBundler(),

  // GitHub Pages 等子路径部署时通过环境变量注入，如 BASE_PATH=/vuepress-blog/
  base: process.env.BASE_PATH || "/",

  lang: "zh-CN",
  title: "Loong 的技术栈",
  description:
    "一个 Java 后端学习者的知识沉淀：面经手册、Spring 实战、后端进阶、项目实战",

  theme,
});
