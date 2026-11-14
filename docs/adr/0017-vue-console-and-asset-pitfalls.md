# 管理后台改用 Vue 3：三个静态资源的坑，每一个都表现成别的问题

界面从**服务端字符串拼 HTML** 改成 **Vue 3 SPA**（`web/`，Vite 构建）。`src/admin/ui.ts` 从 1339 行降到约 120 行 —— 只剩服务端必须拥有的东西：**凭据校验**和一条聚合查询。

## 为什么值得改

服务端渲染意味着**表现层在 Worker 里**，每次请求都在花那 10 ms CPU 预算（[ADR-0005](0005-no-clock-on-workers-free.md)），而且改一个按钮要重新部署。搬到浏览器后，Worker 只做只有它能做的事：读 D1、调上游。

## 坑一：TOML 的表归属 —— 配置被静默忽略

```toml
[observability]
enabled = true
assets = { directory = "web/dist" }    # ← 这属于 [observability]，不是顶层
```

TOML 把键分配给**最近的表头**。wrangler 报了一句：

```
Unexpected fields found in observability field: "assets"
```

然后**照常部署成功**，只是**没有上传任何静态资源**。所以唯一的信号就是那行警告 —— 而 `deploy` 的退出码是 0。

## 坑二：`binding` 不给就是没有绑定

`assets` 里只写 `directory` **不会**生成 `env.ASSETS`。资源**照样上传**、**照样能按 URL 访问**，但 Worker **取不到它们**。

这个失败方式特别容易误导，因为**文件确实部署了**：

```
/index.html  → 200   ← 资源在
/admin       → 500   ← 但 Worker 说"静态资源未绑定"
```

必须显式写 `binding = "ASSETS"`。

## 坑三：`/admin/index.html` 返回 307，不是 404

资源绑定里实测：

```
/index.html                    → 404
/admin/index.html              → 307 → /admin/     ← 规范化重定向
/admin/assets/index-*.js       → 200  text/javascript
```

asset worker 的 `html_handling` 把显式的 `index.html` **重定向**到目录形式。而我的代码把任何非 2xx 当作失败，于是**对一个存在的文件报"找不到"**。

**是那条错误信息里的 `返回 307` 定位了它。** 如果当时只返回一个空的 500，这个坑会耗掉长得多的时间 —— 这就是为什么错误信息要带上观察到的状态码。

## 关键安全属性：静态资源不能绕过认证

**Cloudflare 默认在 Worker 之前先匹配静态资源。** 那样 `run_worker_first` 不配的话，任何人**不需要密码**就能拿到控制台外壳和它的 bundle。

```toml
assets = { directory = "web/dist", binding = "ASSETS", run_worker_first = ["/admin", "/admin/*"] }
```

`run_worker_first` 在这里**是安全设置，不是性能设置**。它接受布尔值或路径数组（对照 wrangler 自己的 config schema 确认过）。

**实测验证**：无凭据请求 `/admin`、`/admin/`、`/admin/qq`、`/admin/assets/*.js`、`/admin/assets/*.css` **全部 401**。

## 一个连带问题：catch-all 必须注册在最后

Hono **按注册顺序匹配**。我先写的 catch-all 排在了前面，于是会**吞掉**它之后的所有路由：

- `/admin/api/*` 会返回 HTML，浏览器 `JSON.parse` 失败；
- `/admin/sha3_wasm_bg.wasm` 会返回 HTML 页面，`WebAssembly.instantiate` 报**魔数错误**。

两个症状都出现过，而且**看起来都和路由顺序无关**。

## 还有：资源查找与客户端路由必须共存

因为 `run_worker_first` 把所有 `/admin/*` 交给 Worker，Worker 必须自己判断**哪个是资源、哪个是客户端路由** —— asset worker 不再有机会先处理。

无条件返回外壳会让 `/admin/assets/index-*.js` 回答 **731 字节的 HTML**：浏览器拿到 HTML 却期望 JavaScript，控制台启动失败，报一个既没提路径也没提原因的 MIME 错误。

正确做法是**先查资源，404 才回退到外壳**。

## 顺带澄清一个我搞错的方向

我一度以为要**剥掉 `/admin` 前缀**再查资源（因为公开访问 `/assets/…` 是 404）。那是错的 —— 那个 404 来自**公开 URL 被 catch-all 拦下**，不是资源不存在。直接探测绑定证明路径就是原始的 `/admin/…`：

```
/index.html                    → 404
/admin/index.html              → 307
/admin/assets/index-*.js       → 200
```

**从公开 URL 探测来推断绑定行为，会把"我的路由拦了它"误读成"文件不在那里"。**

## 实测结果

```
认证：5 条路径无凭据全部 401
外壳：/admin 与 /admin/qq 都返回 200 且含 Vue 挂载点
bundle：引用路径可访问，是 99 KB 的真实应用
API：4 个 JSON 端点返回 JSON（不是 HTML）
wasm：26,612 字节，魔数正确
变更：未知群标识返回 400 + 解释
```

## 已考虑并否决

- **保留服务端渲染的页面，另加一个 Vue 页面**：两套 UI 覆盖同一份数据，必然分叉，而没人维护的那套会烂掉。所以旧渲染器是**删除**而非保留。
- **把 bundle 内联进 Worker**：每次请求都花 Worker 的 CPU，且无法边缘缓存 —— 正好抵消这次改动的意义。
- **引 vue-router**：六个视图、无嵌套、无守卫、除查询串外无路由参数。自己写 20 行哈希路由更小，而且不需要服务端重写规则。
