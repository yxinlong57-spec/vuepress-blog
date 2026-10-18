---
title: 从 0 搭建 VuePress 博客并自动化部署
icon: blog
date: 2026-10-18
category:
  - 项目
tag:
  - VuePress
  - CI/CD
  - GitHub Actions
order: 1
star: true
---

# 从 0 搭建 VuePress 博客并自动化部署

> 本文是本站的诞生记录：技术选型 → 初始化 → 主题配置 → CI 自动化部署，全程亲历复盘。

## 1. 为什么是 VuePress + theme-hope

- VuePress 2：Vue 驱动的静态站点生成器，Markdown 优先，适合程序员写作
- vuepress-theme-hope：内置博客能力（文章、分类、标签、时间线），主题生态成熟，参考站 bugstack.cn 同属此技术栈，结构可对齐
- 对比过 Hugo/Hexo：Hexo 生态老牌但主题定制偏 JS 模板；Hugo 构建快但想加交互要写 Go 模板；最终因 Vue 生态熟悉度选了 VuePress

## 2. 项目初始化

- `npm init` 后安装：`vuepress`、`@vuepress/bundler-vite`、`vuepress-theme-hope`、`sass-embedded`
- 目录结构：源码放 `docs/`，配置在 `docs/.vuepress/`（config.ts / theme.ts / navbar.ts / sidebar.ts）
- 常用脚本：`docs:dev` 本地预览、`docs:build` 生产构建

## 3. 主题配置要点

- navbar / sidebar 显式声明目录结构（本主题版本不支持 `"structure"` 自动生成导航组）
- `base` 支持环境变量注入：GitHub Pages 需要子路径 `/vuepress-blog/`，自建服务器用根路径 `/`，通过 `BASE_PATH` 环境变量在构建时切换

## 4. GitHub Actions 自动化部署

工作流核心设计（完整配置见仓库 `.github/workflows/deploy-docs.yml`）：

- **双 job**：GitHub Pages 与自建服务器各构建一次（base 不同，产物不同）
- Pages job：注入 `BASE_PATH=/vuepress-blog/` 构建 → 推送 `gh-pages` 分支
- 服务器 job：默认 base 构建 → rsync over SSH 同步（未配 secrets 时自动跳过）
- 踩坑记录：Windows 反斜杠路径在 Linux runner 上必挂；`easingthemes/ssh-deploy` 需用 v6 tag（v5 不存在）

## 5. 遇到的坑

1. **navbar 报错 `item.children.map is not a function`**：导航组 `children: "structure"` 写法不被当前主题版本支持，改为显式子项数组
2. **plugin-git 报 no commits**：首次构建时还没有 git 提交历史，首次提交后消失
3. **Pages 404**：部署成功后需到仓库 Settings → Pages 手动开启，选择 gh-pages 分支

## 6. 后续计划

- 接入 Giscus 评论系统
- 自定义域名 + HTTPS
- 文章模板与写作流程固化
