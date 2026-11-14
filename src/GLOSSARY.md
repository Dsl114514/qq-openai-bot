# 服务与接入

把 DeepSeek 网页端的会话能力包装成三样东西：一个 OpenAI 兼容接口、一个 QQ 机器人、一个能查调用记录的后台。这个语言区的词汇围绕"谁在调用、以谁的名义、留下了什么痕迹"。

## 语言

**上游（Upstream）**：
被逆向的 DeepSeek 网页端服务本身（`chat.deepseek.com` 的内部接口）。它是唯一的事实来源，也是唯一会主动封禁我们的一方。
_Avoid_：backend、provider、DeepSeek API（那是指官方付费接口，是另一个东西）

**会话令牌（Session Token）**：
从浏览器 localStorage 取出的 `userToken`，以 `Authorization: Bearer` 形式使用。**约 6 小时失效，且没有任何免密码续期途径**——续期只能由人在浏览器里重新登录后粘贴。这不是缺陷，是上游没有提供的能力。
_Avoid_：api key、token、credential（这些词太宽，此处特指这个会过期的会话凭据）

**接入密钥（Access Key）**：
我们自己签发给调用方的长期密钥，用于 OpenAI 兼容接口的鉴权。它和会话令牌是两个生命周期完全不同的东西，**永远不要混为一谈**。
_Avoid_：api key、token（和上面的会话令牌撞词，是最危险的混淆）

**来源（Origin）**：
一次调用的发起方。取值为三类之一：接入密钥、QQ 用户、后台工作台。调用记录按来源分类，权限与保留策略也按来源分级。
_Avoid_：channel、client、caller

**调用记录（Call Log）**：
一次调用的完整留痕：时间、来源、模型、token 用量、延迟、状态，以及完整请求体与完整响应体。**"调用记录"是产品需求里的原词，保留它。**
_Avoid_：日志、history、log entry（"日志"指运行日志，是另一回事）

**通道（Channel）**：
QQ 侧消息的进出方式。每个通道是一个独立适配器；v1 只有官方 Agent 通道，OneBot 系是预留的第二个实现。
_Avoid_：platform、adapter、connector

**QQ 机器人凭据（Bot Credentials）**：
QQ 开放平台签发的 `AppID` + `AppSecret`。**AppSecret 用来做 Ed25519 回调签名校验**，不是用来调模型的，尤其不是模型 API key——官方 FAQ 里"401 not authorized"最常见的原因就是把这两者搞混。
_Avoid_：bot token、api key、secret（必须连名带姓地叫 AppSecret）

**被动回复窗口（Passive Reply Window）**：
收到用户消息后，可以"免费"回一条消息的时间窗：群聊 5 分钟、单聊 60 分钟。**超出窗口就必须改用主动消息**，而主动消息受独立配额约束。
_Avoid_：reply timeout、session、ttl

**主动消息（Proactive Message）**：
不在被动回复窗口内主动推送的消息。受配额限制（群聊 60 次/分、每群每天 1000 条），因此超时降级到它是有代价的，不是免费的兜底。
_Avoid_：push、broadcast、notification

**工作台（Workbench）**：
后台里可以直接和模型对话的界面。它和调用记录共用同一条管道——工作台发出的消息本身也会产生调用记录。
_Avoid_：chat UI、playground、console

**审计台（Audit View）**：
后台里筛选、翻页、查看单条调用记录全文的界面。
_Avoid_：dashboard、admin、logs page
