# qq-openai-bot

在 **Cloudflare 免费版**上限内运行：把任意 OpenAI 兼容接口接进 QQ，对外提供 OpenAI 兼容 API、QQ 机器人通道，以及一个能查完整请求/响应正文的调用记录后台。

这个项目是 [`cf-ds-api-qq-bot`](https://github.com/Dsl114514/cf-ds-api-qq-bot) 的独立分支：**只保留 OpenAI 兼容 API 接入**，移除了 DeepSeek 网页协议的全部机器（算力挑战、会话令牌、降级阶梯、wasm 求解）。模型来自你配置的任何 OpenAI 兼容端点 —— 官方 API、中转、自建网关都可以，支持**多端点故障转移**与**自定义请求头**。

## 架构

```
QQ 事件 ──┐
           ├─→ Worker ─→ 多端点故障转移 ─→ 你的 OpenAI 兼容 API
/v1/*  ────┘        │
                    └─→ D1：调用审计、会话历史、定时任务、设置
```

- **QQ 机器人**：Ed25519 验签、@触发、Markdown/引用回复、群成员昵称记忆、每日会话重置（可钉住）、定时任务、进群发牢骚、黑/白名单、`/help` `/reset` `/status` 指令。
- **OpenAI 兼容 API**：`POST /v1/chat/completions`（流式/非流式）、`GET /v1/models`；`session_key` 让服务端替你管理上下文。
- **会话历史**：无状态接口延续上下文的唯一方式是把历史一起发过去 —— 服务端按会话键存储并在每次请求时重发，每日自动重置（钉住的会话除外），上限 20 轮。
- **控制台**（`/admin`）：审计（完整正文）、会话、历史、定时任务、QQ 管理、模型来源（多端点管理/探测/测试/诊断）、统计、导出。

## 部署

```bash
npm install
npm run build:web
npx wrangler d1 create qq-openai-bot     # 把输出的 id 填进 wrangler.toml
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ACCESS_KEY
npx wrangler secret put QQ_APP_ID
npx wrangler secret put QQ_APP_SECRET
npx wrangler deploy
```

模型端点不用写进配置 —— 部署后打开 `/admin` → 设置 → 模型来源，在页面里添加端点、填 Key、选模型，保存即生效，无需重新部署。

## 为什么没有 DeepSeek 网页版接入

原项目逆向了 DeepSeek 网页端，代价是一整套为免费版约束而生的机器：PoW 挑战求解（Keccak 分块）、6 小时轮换一次的会话令牌、以及三步降级阶梯。这些复杂度只为一个上游服务存在，而且令牌轮换无法自动化。这个项目把上游换成了标准的 OpenAI 兼容接口：一次 POST，没有挑战，没有令牌，故障转移把"上游挂了"从危机降级为配置问题。

完整的设计决策记录在 [`docs/adr/`](docs/adr/) —— 其中 0001–0021 沿用自原项目（PoW 相关的各篇保留作为历史），0022 起为本项目新增。

## 测试

```bash
npm test          # 251 个测试，11 个文件
npm run check     # tsc --noEmit
npm run check:encoding   # UTF-8 完整性（PowerShell 会写坏中文，这个脚本抓它）
npm run check:views      # 控制台 11 个视图 SSR 渲染检查
```
