# 语文作业成绩语音录入系统

一个面向语文老师的外部 Web 页面：使用浏览器语音识别进行“姓名-成绩”录入，并支持导出 Excel。

## 技术栈

- **React 18** - 用户界面库
- **TypeScript** - 类型安全
- **Vite** - 快速构建工具
- **pnpm** - 快速、节省磁盘空间的包管理器
- **ESLint** - 代码质量检查
- **xlsx (SheetJS)** - 前端导出 Excel

## 核心功能

- **开始/结束录音**：点击开始后念“姓名 成绩”，结束后保存到登记表
- **实时反馈**：展示实时转写文本与实时解析预览
- **花名册（学号+姓名）**：支持学号与姓名；成绩录入时可用“学号”或“姓名”报分
- **花名册匹配**：结束保存时可用 Gemini 基于花名册（学号/姓名）做匹配，降低误识别
- **Gemini 辅助花名册录入（可选）**：从混杂文本中提取姓名生成花名册预览，并可一键追加/替换
- **人工修正**：登记表可编辑（姓名联想、成绩范围 0-100）
- **导出 Excel**：一键导出当日登记表

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

## 使用说明（语音识别）

- **浏览器建议**：桌面版 Chrome（常见实现 Web Speech API）
- **权限**：首次使用需允许麦克风权限
- **花名册格式**：每行一个学生：`学号(可选) + 姓名`，例如：`202401 张三`
- **建议念法**：支持用姓名或学号报分，例如：`张三 95，202402 88`；支持中文数字如 `王五 九十五分`

## 使用说明（AI 辅助录入）

> 安全提醒：本项目当前是**纯前端**调用 AI API，这意味着 **API Key 会暴露在浏览器端**（可被查看/抓包）。建议：
> - 使用 **受限的 Key**（配额/来源限制），或
> - 在生产环境改为 **后端代理** 再调用 Gemini。

- **配置方式一（推荐开发）**：在项目根目录创建 `.env.local`：

```bash
VITE_GEMINI_API_KEY=你的key
VITE_QWEN_API_KEY=你的key
```

- **配置方式二（页面内填写）**：在“花名册 > AI 辅助录入”区域选择提供方（Gemini / 通义千问），并粘贴对应 API Key（可选择是否保存到浏览器 localStorage）。
- **使用**：粘贴原始名单/文本 → 点“生成预览” → 选择“追加去重/替换花名册” → 点“应用到花名册”。

> 备注：通义千问（DashScope）在部分环境下可能存在浏览器 CORS 限制；如遇跨域报错，请改用后端代理转发请求。

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

### 配置自动部署

项目已通过 CLI 部署，如需配置自动部署（每次 push 代码自动部署），请按以下步骤操作：

1. **访问项目设置**
   - 打开 https://vercel.com/zeyuns-projects/modern-frontend-app/settings
   - 或访问 [Vercel Dashboard](https://vercel.com/dashboard)，找到 `modern-frontend-app` 项目

2. **连接 GitHub 仓库**
   - 在项目设置页面，点击左侧菜单的 **"Git"**
   - 如果显示 "Not Connected"，点击 **"Connect Git Repository"**
   - 选择你的 GitHub 账户（如果未授权，会提示授权）
   - 选择仓库 `QiZeyun/modern-frontend-app`
   - 点击 **"Connect"**

3. **配置部署分支**
   - 在 Git 设置中，确保 **"Production Branch"** 设置为 `main`
   - 确保 **"Auto Deploy"** 选项已启用

4. **配置预览部署**（可选）
   - 在 "Preview Deployments" 部分
   - 启用 **"Automatic Preview Deployments"**
   - 这样每次创建 Pull Request 时也会自动生成预览部署

配置完成后，每次 push 代码到 `main` 分支，Vercel 会自动触发部署。

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
