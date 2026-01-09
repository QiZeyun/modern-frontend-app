# Modern Frontend App

一个基于 React + TypeScript + Vite 构建的现代化前端应用。

## 技术栈

- **React 18** - 用户界面库
- **TypeScript** - 类型安全
- **Vite** - 快速构建工具
- **pnpm** - 快速、节省磁盘空间的包管理器
- **ESLint** - 代码质量检查

## 功能特性

- ⚡️ 快速的开发体验
- 🎨 现代化的 UI 设计
- 🔒 TypeScript 类型安全
- 🚀 自动化的 CI/CD 流程

## 开发

### 前置要求

确保已安装 pnpm。如果尚未安装，可以通过以下方式安装：

```bash
npm install -g pnpm
```

或者使用其他安装方式，详见 [pnpm 官方文档](https://pnpm.io/installation)

### 安装依赖

```bash
pnpm install
```

### 启动开发服务器

```bash
pnpm dev
```

### 构建生产版本

```bash
pnpm build
```

### 预览生产构建

```bash
pnpm preview
```

### 代码检查

```bash
pnpm lint
```

### 类型检查

```bash
pnpm type-check
```

## 部署

### Vercel 部署

项目已配置 Vercel 部署，可以通过以下方式部署：

#### 方式一：通过 Vercel CLI（推荐）

1. 安装 Vercel CLI：
```bash
npm install -g vercel
```

2. 在项目根目录运行：
```bash
vercel
```

3. 按照提示完成部署配置

#### 方式二：通过 Vercel 网站

1. 访问 [Vercel](https://vercel.com)
2. 使用 GitHub 账号登录
3. 点击 "Add New Project"
4. 导入你的 GitHub 仓库 `QiZeyun/modern-frontend-app`
5. Vercel 会自动检测项目配置（已包含 `vercel.json`）
6. 点击 "Deploy" 完成部署

部署后，每次 push 代码到 `main` 分支，Vercel 会自动重新部署。

## GitHub Actions

项目配置了 GitHub Actions 工作流，每次 push 代码到仓库后会自动触发构建。

工作流文件位置：`.github/workflows/ci.yml`

## 项目结构

```
modern-frontend-app/
├── .github/
│   └── workflows/
│       └── ci.yml          # GitHub Actions 工作流
├── public/                  # 静态资源
├── src/
│   ├── App.tsx             # 主应用组件
│   ├── App.css             # 应用样式
│   ├── main.tsx            # 应用入口
│   └── index.css           # 全局样式
├── index.html              # HTML 模板
├── package.json            # 项目配置
├── .npmrc                  # pnpm 配置文件
├── vercel.json             # Vercel 部署配置
├── tsconfig.json           # TypeScript 配置
├── vite.config.ts          # Vite 配置
└── README.md               # 项目说明
```

## License

MIT
