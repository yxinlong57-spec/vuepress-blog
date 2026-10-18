import { sidebar } from "vuepress-theme-hope";

export default sidebar({
  "/": [
    "",
    {
      text: "指南",
      icon: "lightbulb",
      prefix: "guide/",
      children: ["", "advanced.md"],
    },
    "intro",
  ],
});
