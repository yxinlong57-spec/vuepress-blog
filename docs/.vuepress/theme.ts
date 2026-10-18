import { hopeTheme } from "vuepress-theme-hope";

import navbar from "./navbar.js";
import sidebar from "./sidebar.js";

export default hopeTheme({
  hostname: "https://yxinlong57-spec.github.io",

  author: {
    name: "Loong",
    url: "https://github.com/yxinlong57-spec",
  },

  logo: "/logo.svg",

  // 导航栏
  navbar,

  // 侧边栏
  sidebar,

  // 页脚
  footer: "Copyright © 2022-2026 Loong",
  displayFooter: true,

  // 博客相关
  blog: {
    description: "一个 Java 后端学习者",
    intro: "/intro.html",
    medias: {
      GitHub: "https://github.com/yxinlong57-spec",
    },
  },

  // 多语言配置
  metaLocales: {
    editLink: "在 GitHub 上编辑此页",
  },

  markdown: {
    align: true,
    attrs: true,
    codeTabs: true,
    component: true,
    demo: true,
    figure: true,
    gfm: true,
    imgLazyload: true,
    imgSize: true,
    include: true,
    mark: true,
    sub: true,
    sup: true,
    tabs: true,
    tasklist: true,
    vPre: true,
  },

  // 插件
  plugins: {
    blog: true,

    components: {
      components: ["Badge", "VPCard"],
    },

    icon: {
      prefix: "fa6-solid:",
    },
  },
});
