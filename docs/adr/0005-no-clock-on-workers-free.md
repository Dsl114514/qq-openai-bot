# Worker 里没有任何可用时钟；CPU 预算只能靠"被杀掉"来探测

部署到真实 Cloudflare 免费版账户后，逐个实测了三种计时手段，**三种全部不可用**：

| 手段 | 实测结果 |
|---|---|
| `performance.cpuTime` | `undefined`（`/health` 返回 `cpuTimeAvailable: false`） |
| `performance.now()` | 存在，但**不推进**：20,000 次哈希的差值为 0 |
| `Date.now()` | 存在，但**同样不推进**：50,000 次哈希的差值为 0 |

也就是说，在部署环境里时间是不可观测的。`wallMs: 0`、`usPerHash: null` 不是测量精度问题，而是**没有任何时钟可以读**。

## 为什么这条值得单独记下来

因为它**推翻了 ADR-0001 里那个"把 `[0, difficulty)` 按测得速度切成若干段"的计划**。分块仍然必要，但"按测量算分块大小"这条路根本不存在 —— 没有时钟就没有吞吐率，没有吞吐率就没有预算公式。

它还制造了一个**沉默失灵陷阱**：`performance.now()` 存在、可调用、返回数字，只是永远返回同一个值。早期版本用 `t > 0` 判断"时钟是否可用"，常量时钟轻松通过，于是代码报告 `clockPrecise: true` 并给出 `usPerHash: null` 的"精确"测量。**一个坏掉的时钟比一个缺失的时钟更危险**，因为前者看起来在正常工作。

## 实测出来的东西

既然测不出时间，就只能测**边界**。CPU 超限时调用会被终止，这本身是可观测信号：

```
count=106250   HTTP 200   1302 ms
count=148437   HTTP 200   1455 ms   ← 最大成功
count=162500   killed                ← 被杀
count=500000   killed    10627 ms   ← 连接被断，不是 503
```

- **CPU 天花板约 15 万次哈希**（≈67 ns/hash，比本机 19.8 µs/hash 快约 300 倍）。
  这反过来修正了 ADR-0001 的估算：一次难度 144,000 的挑战只需**几次**调用，不是原文估的 100–200 次。
- **超限有两种表现**：小幅度超限返回 `HTTP 503`，大幅超限直接断开连接（客户端看到 error 1102）。所以驱动必须把**两种情况都当作"被杀"**，不能只判状态码。
- **阈值不稳定**：同一份工作量的真实墙钟从 3317 ms（新 isolate）降到约 770 ms（热 isolate），**4 倍差距**。所以冷 isolate 上会失败的分块，热 isolate 上能通过。

## 后果

- 分块大小**不是算出来的，是探测出来的**：`scripts/probe-ceiling.mjs` 二分搜索真正的天花板，`scripts/chat.mjs --chunk` 取其中一小部分。
- 驱动**必须能容忍被杀**：`chunkWithFallback` 在遇到被杀时把区间二分后重试，递归直到放得下。这是把"失败"当信号用，而不是当错误报。
- `/pow/calibrate` **不再编造速率**。时钟不可用时它明确返回 `usPerHash: null`、`suggestedChunk: null`，并说明原因 —— 给一个看似自信的错数字，比不给更糟。
- 分块设计**不依赖任何未公开机制**（如 rollover CPU），符合 ADR-0001 的原始约束。

## 已经修改过的错误假设

- 曾把 `performance_now_sub_ms` 写进 `compatibility_flags`。**这个标志不存在**，部署被拒（`No such compatibility flag`, code 10021）。查证 workerd 的 `compatibility-date.capnp` 后确认：相关标志只有 `precise_timers`，且标着 `$experimental`（生产账号不可用）。该行已删除，`wrangler.toml` 现在不带任何兼容标志。
- 曾用 `t > 0` 判断时钟可用性（见上，常量时钟能通过）。现在 `wallMs()` 直接返回 `Date.now()` 并且 **`precise` 恒为 `false`**。

## 已考虑并否决

- **`precise_timers`**：只提供 3 ms 粒度，且是 experimental 标志，生产账号不可用。
- **用多次请求的客户端墙钟反推服务端 CPU**：客户端时间包含网络与排队，与 CPU 消耗无稳定关系，得到的数字不可用于定分块。
- **硬编码一个"看起来安全"的分块大小**：阈值随 isolate 冷热浮动 4 倍，任何硬编码值在冷 isolate 上都会失效；而失败必须能被自动处理，所以重试逻辑无论如何都得有。
