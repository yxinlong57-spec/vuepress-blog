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

  // 仓库信息（编辑链接 + 最后更新时间）
  docsRepo: "https://github.com/yxinlong57-spec/vuepress-blog",
  docsBranch: "main",
  docsDir: "docs",
  editLink: true,
  lastUpdated: true,
  contributors: false,

  // 文章页头信息
  pageInfo: ["Author", "Date", "Category", "Tag", "ReadingTime", "Word"],

  // 导航栏
  navbar,

  // 侧边栏
  sidebar,

  // 页脚
  footer: "Copyright © 2022-2026 Loong",
  displayFooter: true,

  // 博客相关
  blog: {
    description: "Java 后端打底，Agent 应用探路，公开记录一个计算机学生的技术成长路线。",
    intro: "/intro.html",
    avatar: "/images/avatar.jpg",
    roundAvatar: true,
    medias: {
      CSDN: {
        icon: "https://g.csdnimg.cn/static/logo/favicon32.ico",
        link: "https://blog.csdn.net/lqbzlll",
      },
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

    // 最后更新时间依赖 Git 信息
    git: true,

    // 站内搜索（导航栏搜索框）
    slimsearch: {
      indexContent: true,
    },

    // 代码块一键复制
    copyCode: {
      showInMobile: true,
    },

    // 图片点击放大
    photoSwipe: true,

    // 文章版权信息（转载自动带原文链接）
    copyright: {
      global: true,
      author: "Loong",
      license: "CC BY-NC-SA 4.0",
    },

    components: {
      components: ["Badge", "VPCard"],
    },

    icon: {
      prefix: "fa6-solid:",
    },
  },
});
