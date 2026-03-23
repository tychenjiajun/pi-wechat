# pi-wechat

[English](./README.md) | 简体中文

`pi-wechat` 是一个给 [pi](https://github.com/badlogic/pi-mono) 使用的 TypeScript 扩展，用来把微信 iLink Bot 的消息桥接到 pi 会话里。

它可以：

- 通过二维码登录微信 iLink Bot
- 在后台长轮询微信消息
- 把每条微信消息注入到当前 pi 会话
- 等整个 agent loop 完成后，把最终回复发回微信
- 在 pi 工作期间同步微信输入态

## 这是什么

这个项目是一个 pi 扩展，不是独立运行的聊天机器人进程。

桥接方式是把微信消息直接送进“当前 pi 会话”。这样实现更贴近 pi 的扩展模型，也更简单，但代价是这个会话会承载所有桥接上下文。

推荐用法：

- 为微信桥接单独开一个 pi 会话
- 不要在同一个会话里混用本地终端聊天和实时微信流量

当前能力：

- 稳定的文本消息桥接
- 登录凭证持久化
- 重试和 session 过期处理
- 输入态支持

当前限制：

- 图片、语音、视频、文件消息目前会转成占位文本
- 这不是多用户路由服务
- 目前不会为每个微信会话自动拆分独立的 pi session

## 安装

使用 pi 从下面两种来源之一安装扩展。

### 方式 A：从 npm 安装

```bash
pi install npm:pi-wechat
```

### 方式 B：从 GitHub 安装

```bash
pi install git:github.com/yangyang0507/pi-wechat
```

### 重新加载 pi 资源

如果 pi 已经启动：

```text
/reload
```

## 快速开始

在 pi 里执行：

```text
/wechat-login
/wechat-start
```

然后：

1. 用微信扫描 pi 中显示的二维码
2. 在手机上确认登录
3. 从微信给 bot 发消息
4. 等 pi 完整跑完 agent loop
5. 在微信里收到最终回复

## 使用教程

### 登录

执行：

```text
/wechat-login
```

扩展会请求微信 iLink Bot 的二维码，在 pi 界面里渲染出来，并等待你确认登录。

凭证默认保存到：

```text
~/.pi-wechat/credentials.json
```

如果要强制重新扫码：

```text
/wechat-login --force
```

### 启动桥接

执行：

```text
/wechat-start
```

这会启动长轮询循环。收到的微信消息会按顺序排队，再逐条注入当前 pi 会话。

### 停止桥接

执行：

```text
/wechat-stop
```

这会停止轮询，并清空内存中的桥接状态。

### 查看状态

执行：

```text
/wechat-status
```

可以看到桥接是否运行、凭证是否已加载、当前是否有排队消息等信息。

### 清除本地凭证

执行：

```text
/wechat-logout
```

这会停止桥接，并删除本地保存的凭证文件。

## Slash Commands

- `/wechat-login` - 二维码登录
- `/wechat-login --force` - 强制重新登录
- `/wechat-start` - 启动桥接
- `/wechat-stop` - 停止桥接
- `/wechat-status` - 查看桥接状态
- `/wechat-logout` - 删除凭证并停止桥接

## 回复是怎么发回微信的

当一条微信消息到来时：

1. 扩展从 iLink Bot API 收到消息
2. 消息正文作为用户消息注入 pi
3. 微信回复约束通过隐藏的 `before_agent_start` system prompt 注入
4. pi 跑完整个 agent loop，必要时可以调用工具
5. 在 `agent_end` 后，扩展提取最终 assistant 文本
6. 这段最终文本被发回微信

这里故意选 `agent_end` 而不是 `turn_end`，因为如果 assistant 中间调用了工具，`turn_end` 很容易把中间结果过早发回微信。

## 开发

安装依赖：

```bash
npm install
```

执行基础校验：

```bash
npm run check
```

## 发布

如果后面要发布到 npm：

```bash
npm run check
npm login
npm publish --access public
```

## 调试日志

默认情况下，扩展会尽量减少 UI 噪音；如果 pi 已经能显示通知，就不会额外输出大量 console 日志。

如果需要打开桥接调试日志：

```bash
PI_WECHAT_DEBUG=1 pi
```

## 参考

- pi 扩展运行时：[badlogic/pi-mono](https://github.com/badlogic/pi-mono)
- 微信协议 SDK 参考：[epiral/weixin-bot](https://github.com/epiral/weixin-bot)
- Agent 桥接设计参考：[wong2/weixin-agent-sdk](https://github.com/wong2/weixin-agent-sdk)
