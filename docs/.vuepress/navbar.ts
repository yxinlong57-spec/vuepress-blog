import { navbar } from "vuepress-theme-hope";

export default navbar([
  "/",
  {
    text: "专栏",
    icon: "book",
    children: [
      { text: "面经手册", icon: "lightbulb", link: "/interview/" },
      { text: "Spring 实战", icon: "leaf", link: "/spring/" },
      { text: "后端进阶", icon: "server", link: "/backend/" },
      { text: "项目实战", icon: "rocket", link: "/projects/" },
      { text: "技术随笔", icon: "pen-nib", link: "/daily/" },
    ],
  },
  { text: "阅读指南", icon: "flag", link: "/guide/" },
  { text: "时间线", icon: "clock-rotate-left", link: "/timeline/" },
  { text: "关于我", icon: "circle-info", link: "/intro.html" },
  { text: "GitHub", link: "https://github.com/yxinlong57-spec" },
]);
