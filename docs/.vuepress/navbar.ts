import { navbar } from "vuepress-theme-hope";

export default navbar([
  "/",
  {
    text: "指南",
    icon: "lightbulb",
    prefix: "/guide/",
    children: ["", "advanced.md"],
  },
]);
