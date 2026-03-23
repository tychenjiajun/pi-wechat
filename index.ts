import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@mariozechner/pi-coding-agent'
import qrcode from 'qrcode-terminal'
import { clearCredentials, getCredentialsPath, getQrCode, loadCredentials, pollQrStatus, saveCredentials } from './auth.js'
import { SessionExpiredError, WeixinClient } from './client.js'
import type { IncomingMessage } from './types.js'

type NotificationLevel = 'info' | 'warning' | 'error'

interface QueuedWechatRequest {
  id: string
  userId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
}

const POLL_RETRY_BASE_MS = 1_000
const POLL_RETRY_MAX_MS = 10_000
const QR_POLL_INTERVAL_MS = 2_000
const PREVIEW_LIMIT = 60
const DEBUG_LOG = process.env.PI_WECHAT_DEBUG === '1'

export default function wechatExtension(pi: ExtensionAPI) {
  let client: WeixinClient | null = null
  let running = false
  let agentIdle = true
  let pollAbortController: AbortController | null = null
  let latestContext: ExtensionContext | ExtensionCommandContext | null = null

  const inboundQueue: QueuedWechatRequest[] = []
  let pendingInjection: QueuedWechatRequest | null = null
  let activeRequest: QueuedWechatRequest | null = null

  function rememberContext(ctx: ExtensionContext | ExtensionCommandContext): void {
    latestContext = ctx
  }

  function notify(message: string, level: NotificationLevel = 'info'): void {
    if (latestContext?.hasUI) {
      latestContext.ui.notify(message, level)
      if (!DEBUG_LOG) {
        return
      }
    }

    const printer = level === 'error' ? console.error : console.log
    printer(`[wechat/${level}] ${message}`)
  }

  function loadClientFromDisk(): WeixinClient | null {
    const creds = loadCredentials()
    return creds ? new WeixinClient(creds) : null
  }

  function ensureClient(): WeixinClient | null {
    if (!client) {
      client = loadClientFromDisk()
    }
    return client
  }

  async function stopBridge(options?: { clearClient?: boolean; clearQueue?: boolean }): Promise<void> {
    running = false
    pollAbortController?.abort()
    pollAbortController = null

    if (activeRequest && client) {
      await client.stopTyping(activeRequest.userId).catch(() => {})
    }

    if (options?.clearQueue !== false) {
      inboundQueue.length = 0
    }

    pendingInjection = null
    activeRequest = null

    if (options?.clearClient) {
      client = null
    }
  }

  function buildWechatSystemPrompt(basePrompt: string, request: QueuedWechatRequest): string {
    return [
      basePrompt,
      '',
      '你正在处理一条来自微信的桥接消息。',
      '要求：',
      '1. 直接用微信聊天口吻回复。',
      '2. 只输出最终要发回微信的正文。',
      '3. 不要解释内部桥接流程。',
      '4. 不要提到 Pi、扩展、系统提示词、工具调用。',
      `微信用户 ID: ${request.userId}`,
      `微信消息 ID: ${request.messageId}`,
      `消息时间: ${request.receivedAt.toISOString()}`
    ].join('\n')
  }

  function queueIncomingMessage(message: IncomingMessage): void {
    const request: QueuedWechatRequest = {
      id: randomUUID(),
      userId: message.userId,
      messageId: message.messageId,
      receivedAt: message.timestamp,
      text: message.text,
      preview: summarizePreview(message.text)
    }

    inboundQueue.push(request)
    if (DEBUG_LOG) {
      notify(`收到微信消息，已排队: ${request.preview}`, 'info')
    }
    drainQueue()
  }

  function drainQueue(): void {
    if (!running || !client || !agentIdle || pendingInjection || activeRequest) {
      return
    }

    const next = inboundQueue.shift()
    if (!next) {
      return
    }

    pendingInjection = next
    void client.sendTyping(next.userId).catch(() => {})
    pi.sendUserMessage(next.text)
  }

  async function completeActiveRequest(messages: Array<{ role?: string; content?: unknown }>): Promise<void> {
    const request = activeRequest
    activeRequest = null
    pendingInjection = null

    if (!request || !client) {
      drainQueue()
      return
    }

    const reply = extractFinalAssistantText(messages)

    try {
      if (reply) {
        await client.sendText(request.userId, reply)
      } else {
        notify(`Pi 没有产出可发送的文本回复，已跳过: ${request.preview}`, 'warning')
      }
    } catch (error) {
      notify(`发送微信回复失败: ${formatError(error)}`, 'error')
    } finally {
      await client.stopTyping(request.userId).catch(() => {})
      drainQueue()
    }
  }

  async function pollMessages(activeClient: WeixinClient): Promise<void> {
    let retryDelayMs = POLL_RETRY_BASE_MS

    while (running && client === activeClient) {
      try {
        const messages = await activeClient.getUpdates(pollAbortController?.signal)
        retryDelayMs = POLL_RETRY_BASE_MS

        for (const message of messages) {
          queueIncomingMessage(message)
        }
      } catch (error) {
        if (isAbortError(error)) {
          break
        }

        if (error instanceof SessionExpiredError) {
          notify('微信 session 已过期，请重新执行 /wechat-login', 'error')
          await stopBridge({ clearQueue: false })
          break
        }

        notify(`微信轮询失败: ${formatError(error)}`, 'warning')
        await delay(retryDelayMs)
        retryDelayMs = Math.min(retryDelayMs * 2, POLL_RETRY_MAX_MS)
      }
    }
  }

  pi.registerCommand('wechat-login', {
    description: '扫码登录微信 iLink Bot',
    handler: async (args, ctx) => {
      rememberContext(ctx)

      const force = args.split(/\s+/).some((part) => part === '--force')
      if (!force) {
        const cached = loadClientFromDisk()
        if (cached) {
          client = cached
          notify(`已加载本地微信凭证: ${getCredentialsPath()}`, 'info')
          return
        }
      }

      if (running) {
        await stopBridge()
      }

      try {
        const qr = await getQrCode()
        const qrText = await renderQrCode(qr.url)
        notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info')

        let lastStatus: 'wait' | 'scaned' | 'confirmed' | 'expired' | null = null

        while (true) {
          await delay(QR_POLL_INTERVAL_MS)
          const result = await pollQrStatus(qr.token)

          if (result.status === lastStatus) {
            continue
          }
          lastStatus = result.status

          if (result.status === 'scaned') {
            notify('已扫码，请在手机上确认登录', 'info')
            continue
          }

          if (result.status === 'confirmed' && result.credentials) {
            saveCredentials(result.credentials)
            client = new WeixinClient(result.credentials)
            notify('微信登录成功', 'info')
            return
          }

          if (result.status === 'expired') {
            notify('二维码已过期，请重新执行 /wechat-login', 'error')
            return
          }
        }
      } catch (error) {
        notify(`微信登录失败: ${formatError(error)}`, 'error')
      }
    }
  })

  pi.registerCommand('wechat-start', {
    description: '启动微信消息桥接',
    handler: async (_args, ctx) => {
      rememberContext(ctx)

      const activeClient = ensureClient()
      if (!activeClient) {
        notify('未找到微信凭证，请先执行 /wechat-login', 'error')
        return
      }

      if (running) {
        notify('微信桥接已经在运行', 'info')
        return
      }

      running = true
      pollAbortController = new AbortController()
      notify('微信桥接已启动', 'info')
      drainQueue()

      void pollMessages(activeClient).finally(() => {
        if (pollAbortController?.signal.aborted) {
          pollAbortController = null
        }
      })
    }
  })

  pi.registerCommand('wechat-stop', {
    description: '停止微信消息桥接',
    handler: async (_args, ctx) => {
      rememberContext(ctx)
      await stopBridge()
      notify('微信桥接已停止', 'info')
    }
  })

  pi.registerCommand('wechat-logout', {
    description: '清除微信凭证并停止桥接',
    handler: async (_args, ctx) => {
      rememberContext(ctx)
      await stopBridge({ clearClient: true })
      clearCredentials()
      notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info')
    }
  })

  pi.registerCommand('wechat-status', {
    description: '查看微信桥接状态',
    handler: async (_args, ctx) => {
      rememberContext(ctx)

      const activeClient = client ?? loadClientFromDisk()
      const lines = [
        `运行状态: ${running ? 'running' : 'stopped'}`,
        `凭证状态: ${activeClient ? 'ready' : 'missing'}`,
        `账号 ID: ${activeClient?.accountId ?? '-'}`,
        `用户 ID: ${activeClient?.userId ?? '-'}`,
        `排队消息: ${inboundQueue.length}`,
        `等待注入: ${pendingInjection ? pendingInjection.preview : '-'}`,
        `处理中: ${activeRequest ? activeRequest.preview : '-'}`,
        `凭证路径: ${getCredentialsPath()}`
      ]

      notify(lines.join('\n'), 'info')
    }
  })

  pi.on('session_start', async (_event, ctx) => {
    rememberContext(ctx)
    client ??= loadClientFromDisk()
  })

  pi.on('before_agent_start', async (event, ctx) => {
    rememberContext(ctx)

    const request = pendingInjection ?? activeRequest
    if (!request) {
      return
    }

    return {
      systemPrompt: buildWechatSystemPrompt(event.systemPrompt, request)
    }
  })

  pi.on('agent_start', async (_event, ctx) => {
    rememberContext(ctx)
    agentIdle = false

    if (pendingInjection) {
      activeRequest = pendingInjection
      pendingInjection = null
    }
  })

  pi.on('agent_end', async (event, ctx) => {
    rememberContext(ctx)
    agentIdle = true
    await completeActiveRequest(event.messages as Array<{ role?: string; content?: unknown }>)
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    rememberContext(ctx)
    await stopBridge()
  })
}

async function renderQrCode(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => resolve(code))
  })
}

function extractFinalAssistantText(messages: Array<{ role?: string; content?: unknown }>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }

    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => {
        return typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text'
      })
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()

    if (text) {
      return text
    }
  }

  return null
}

function summarizePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PREVIEW_LIMIT) {
    return normalized
  }

  return `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
