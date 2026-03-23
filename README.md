# pi-wechat

English | [简体中文](./README.zh-CN.md)

`pi-wechat` is a TypeScript extension for [pi](https://github.com/badlogic/pi-mono) that bridges WeChat iLink Bot conversations into a pi session.

It lets you:

- log in to WeChat iLink Bot with a QR code
- long-poll incoming WeChat messages in the background
- inject each incoming message into the current pi session
- send the final assistant reply from the completed agent loop back to WeChat
- keep WeChat typing state in sync while pi is working

## What This Extension Is

This project is a pi extension, not a standalone chatbot process.

The bridge works by feeding WeChat messages into the current pi session. That design keeps the implementation small and aligned with pi's extension model, but it also means the session becomes the shared context for all bridged messages.

Recommended usage:

- run the bridge in a dedicated pi session
- avoid mixing manual terminal prompts and live WeChat traffic in the same session

Current scope:

- stable text message bridge
- login persistence
- retry and session-expiry handling
- typing indicator support

Current limitations:

- image, voice, video, and file messages are converted to placeholder text
- this is not a multi-user routing server
- this does not isolate each WeChat conversation into a separate pi session

## Install

Install the extension with pi using one of these package sources.

### Option A: install from npm

```bash
pi install npm:pi-wechat
```

### Option B: install from GitHub

```bash
pi install git:github.com/yangyang0507/pi-wechat
```

### Reload pi resources

If pi is already running:

```text
/reload
```

## Quick Start

Inside pi:

```text
/wechat-login
/wechat-start
```

Then:

1. scan the QR code in pi with WeChat
2. confirm the login on your phone
3. send a message to the bot from WeChat
4. wait for pi to finish the full agent loop
5. receive the final assistant text reply back in WeChat

## Usage Tutorial

### Login

Run:

```text
/wechat-login
```

The extension fetches a WeChat iLink Bot QR code, renders it in the pi UI, and waits for confirmation.

Credentials are stored locally at:

```text
~/.pi-wechat/credentials.json
```

To force a fresh login:

```text
/wechat-login --force
```

### Start the bridge

Run:

```text
/wechat-start
```

This starts the long-poll loop. Incoming WeChat messages are queued and injected into the current pi session one by one.

### Stop the bridge

Run:

```text
/wechat-stop
```

This stops polling and clears in-memory bridge state.

### Check bridge status

Run:

```text
/wechat-status
```

This shows whether the bridge is running, whether credentials are loaded, and whether there are queued messages.

### Clear saved credentials

Run:

```text
/wechat-logout
```

This stops the bridge and removes the local credential file.

## Slash Commands

- `/wechat-login` - log in with QR code
- `/wechat-login --force` - force a fresh QR login
- `/wechat-start` - start polling and bridging messages
- `/wechat-stop` - stop the bridge
- `/wechat-status` - show bridge state
- `/wechat-logout` - remove saved credentials and stop the bridge

## How Replies Work

When a WeChat message arrives:

1. the extension receives it from the iLink Bot API
2. the message text is injected into pi as a user message
3. bridge-specific reply instructions are added through the hidden `before_agent_start` system prompt layer
4. pi runs the full agent loop, including tools if needed
5. after `agent_end`, the extension extracts the final assistant text
6. that final text is sent back to WeChat

This is intentional: replying on `agent_end` avoids prematurely sending intermediate turn results when the assistant uses tools.

## Development

Install dependencies:

```bash
npm install
```

Run a basic extension load check:

```bash
npm run check
```

## Publish

Once you are ready to distribute it through npm:

```bash
npm run check
npm login
npm publish --access public
```

## Debug Logging

By default, the extension keeps UI noise low and avoids extra console logging when pi UI notifications are available.

To enable bridge debug logs:

```bash
PI_WECHAT_DEBUG=1 pi
```

## References

- pi extension runtime: [badlogic/pi-mono](https://github.com/badlogic/pi-mono)
- WeChat protocol SDK reference: [epiral/weixin-bot](https://github.com/epiral/weixin-bot)
- Agent bridge design reference: [wong2/weixin-agent-sdk](https://github.com/wong2/weixin-agent-sdk)
