import { viteBundler } from "@vuepress/bundler-vite";
import { defineUserConfig } from "vuepress";

import theme from "./theme.js";

export default defineUserConfig({
  bundler: viteBundler(),

  // GitHub Pages 等子路径部署时通过环境变量注入，如 BASE_PATH=/vuepress-blog/
  base: process.env.BASE_PATH || "/",

  lang: "zh-CN",
  title: "我的博客",
  description: "基于 VuePress 的个人博客",

  theme,
});
