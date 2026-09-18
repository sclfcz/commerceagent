# PWA Icons

## 自动生成

PNG 图标通过 `npm run generate-icons` 从统一源图自动生成。构建时会自动运行此脚本。

## 图标源

- 首选：`logo-1024.png`
- 回退：`../favicon.svg`

脚本会从同一份源文件生成全部 PWA PNG 尺寸，避免维护内容重复的 SVG 副本。

## 自定义图标

如需更新图标：

1. 替换 `logo-1024.png`，或在没有 PNG 源图时编辑 `../favicon.svg`
2. 运行 `npm run generate-icons` 重新生成 PNG
3. 或使用设计工具（Figma、Sketch）创建专业图标，直接替换 PNG 文件
