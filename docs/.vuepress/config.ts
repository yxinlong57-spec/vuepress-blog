import { viteBundler } from "@vuepress/bundler-vite";
import { baiduAnalyticsPlugin } from "@vuepress/plugin-baidu-analytics";
import { defineUserConfig } from "vuepress";

import theme from "./theme.js";

export default defineUserConfig({
  bundler: viteBundler(),

  // GitHub Pages 等子路径部署时通过环境变量注入，如 BASE_PATH=/vuepress-blog/
  base: process.env.BASE_PATH || "/",

  lang: "zh-CN",
  title: "LoongStack",
  description:
    "LoongStack：Java 后端打底，Agent 应用探路——Java 基础、并发、JVM、MySQL、Redis、Spring 实战、Agent / LLM 应用开发，一个计算机学生的技术成长路线。",

  // 搜索引擎站点所有权验证标记（Google Search Console / 百度站长等）
  // 这类验证码是公开明文，写进页面源码正是其设计目的，可安全入库
  head: [
    [
      "meta",
      {
        name: "google-site-verification",
        content: "2UJTzgjz4DUQjGBkRKYNdwq61QS8WSy3RvIasEeeUsc",
      },
    ],
  ],

  theme,

  plugins: [
    // 百度统计（站点 ID 为公开明文，可安全入库）
    baiduAnalyticsPlugin({
      id: "1d7686efbd21624e5578f7af2725e070",
    }),
  ],
});
