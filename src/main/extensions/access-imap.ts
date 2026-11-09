import tls from 'node:tls'

const CONNECT_TIMEOUT_MS = 12_000
const COMMAND_TIMEOUT_MS = 20_000
const MAX_BODY_CHARS = 20_000

export interface MailCredentials {
  email: string
  appPassword: string
  host: string
  port: number
}

export interface MailSummary {
  uid: number
  seq: number
  from: string
  subject: string
  date: string
}

export interface MailInbox {
  total: number
  messages: MailSummary[]
}

export interface MailMessage extends MailSummary {
  text: string
}

interface ResponseEvent {
  line: string
  literal?: Buffer
}

interface Response {
  status: 'OK' | 'NO' | 'BAD'
  events: ResponseEvent[]
}

/**
 * Read-only Gmail IMAP over TLS. Uses EXAMINE and BODY.PEEK so opening the
 * extension never marks messages as read. Credentials stay inside this call.
 */
export async function fetchInbox(credentials: MailCredentials, limit = 15): Promise<MailInbox> {
  const session = await ImapSession.connect(credentials)
  try {
    await session.login(credentials)
    const total = await session.examineInbox()
    const messages = total === 0 ? [] : await session.fetchHeaders(total, limit)
    return { total, messages }
  } finally {
    await session.close()
  }
}

export async function fetchMessage(credentials: MailCredentials, uid: number): Promise<MailMessage> {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('Mailbox message id is invalid')
  const session = await ImapSession.connect(credentials)
  try {
    await session.login(credentials)
    await session.examineInbox()
    return await session.fetchMessage(uid)
  } finally {
    await session.close()
  }
}

class ImapSession {
  private buffer = Buffer.alloc(0)
  private ended = false
  private failure: Error | undefined
  private readonly waiters = new Set<() => void>()
  private tag = 0

  private constructor(private readonly socket: tls.TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake()
    })
    socket.on('error', (error) => {
      this.failure = error
      this.ended = true
      this.wake()
    })
    socket.on('close', () => {
      this.ended = true
      this.wake()
    })
  }

  static async connect(credentials: MailCredentials): Promise<ImapSession> {
    const socket = tls.connect({ host: credentials.host, port: credentials.port, servername: credentials.host })
    const session = new ImapSession(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Could not reach ${credentials.host}:${credentials.port} in time`))
      }, CONNECT_TIMEOUT_MS)
      socket.once('secureConnect', () => { clearTimeout(timer); resolve() })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(mailboxError(error, credentials.host))
      })
    })
    await session.readLine(CONNECT_TIMEOUT_MS)
    return session
  }

  async login(credentials: MailCredentials): Promise<void> {
    const command = this.nextTag()
    const password = credentials.appPassword.replace(/\s+/g, '')
    this.send(`${command} LOGIN ${quote(credentials.email)} ${quote(password)}`)
    const response = await this.readResponse(command)
    if (response.status === 'OK') return
    const text = response.events.map((event) => event.line).join('\n')
    if (/AUTHENTICATIONFAILED|Invalid credentials|Application-specific password required/i.test(text)) {
      throw new Error('Gmail rejected this app password. Create a new app password in your Google Account and save it again.')
    }
    if (/UNAVAILABLE|temporarily/i.test(text)) {
      throw new Error('Gmail temporarily refused the sign-in. Try again in a few minutes.')
    }
    throw new Error('Gmail rejected the mailbox sign-in')
  }

  async examineInbox(): Promise<number> {
    const command = this.nextTag()
    this.send(`${command} EXAMINE "INBOX"`)
    const response = await this.readResponse(command)
    if (response.status !== 'OK') throw new Error('Could not open the Gmail inbox')
    let total = 0
    for (const event of response.events) {
      const match = event.line.match(/^\*\s+(\d+)\s+EXISTS/i)
      if (match) total = Number(match[1])
    }
    return total
  }

  async fetchHeaders(total: number, limit: number): Promise<MailSummary[]> {
    const end = total
    const start = Math.max(1, end - Math.max(1, Math.min(limit, 30)) + 1)
    const command = this.nextTag()
    this.send(`${command} FETCH ${start}:${end} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`)
    const response = await this.readResponse(command)
    if (response.status !== 'OK') throw new Error('Could not read the Gmail inbox')
    const messages: MailSummary[] = []
    for (const event of response.events) {
      if (!event.literal) continue
      const fetch = event.line.match(/^\*\s+(\d+)\s+FETCH\s+\(/i)
      const uid = event.line.match(/\bUID\s+(\d+)/i)
      if (!fetch || !uid) continue
      const headers = parseHeaders(event.literal.toString('utf8'))
      messages.push({
        seq: Number(fetch[1]),
        uid: Number(uid[1]),
        from: decodeHeader(headers.from ?? ''),
        subject: decodeHeader(headers.subject ?? '(no subject)'),
        date: headers.date ?? '',
      })
    }
    return messages.sort((left, right) => right.uid - left.uid).slice(0, limit)
  }

  async fetchMessage(uid: number): Promise<MailMessage> {
    const command = this.nextTag()
    this.send(`${command} UID FETCH ${uid} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT]<0.${MAX_BODY_CHARS}>)`)
    const response = await this.readResponse(command)
    if (response.status !== 'OK') throw new Error('Could not read that Gmail message')
    const headerEvent = response.events.find((event) => event.literal && /BODY\[HEADER\.FIELDS/i.test(event.line))
    const bodyEvent = response.events.find((event) => event.literal && /BODY\[TEXT\]/i.test(event.line))
    const headers = parseHeaders(headerEvent?.literal?.toString('utf8') ?? '')
    const bodyText = bodyEvent?.literal
      ? bodyEvent.literal.toString('utf8')
      : extractQuotedBody(response.events) ?? ''
    return {
      uid,
      seq: 0,
      from: decodeHeader(headers.from ?? ''),
      subject: decodeHeader(headers.subject ?? '(no subject)'),
      date: headers.date ?? '',
      text: mimeToText(bodyText),
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.ended) {
        this.send(`${this.nextTag()} LOGOUT`)
        await this.readLine(2_000).catch(() => undefined)
      }
    } finally {
      this.socket.destroy()
    }
  }

  private nextTag(): string {
    this.tag += 1
    return `A${this.tag}`
  }

  private send(line: string): void {
    if (this.ended) throw new Error('Mailbox connection is closed')
    this.socket.write(`${line}\r\n`)
  }

  private async readResponse(tag: string): Promise<Response> {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    const events: ResponseEvent[] = []
    for (;;) {
      let line: string
      let literal: Buffer | undefined
      const event = await this.readEvent(deadline)
      line = event.line
      literal = event.literal
      events.push({ line, ...(literal ? { literal } : {}) })
      if (new RegExp(`^${tag}\\s+(OK|NO|BAD)\\b`, 'i').test(line)) {
        const status = line.match(/\s(OK|NO|BAD)\b/i)![1]!.toUpperCase() as 'OK' | 'NO' | 'BAD'
        return { status, events }
      }
    }
  }

  private async readEvent(deadline: number): Promise<ResponseEvent> {
    const line = await this.readLineUntil(deadline)
    const match = line.match(/\{(\d+)\}$/)
    if (!match) return { line }
    const size = Number(match[1])
    if (size > 8 * 1024 * 1024) throw new Error('The mailbox returned an oversized response')
    const literal = await this.readExact(size, deadline)
    return { line, literal }
  }

  private async readLine(timeoutMs: number): Promise<string> {
    return this.readLineUntil(Date.now() + timeoutMs)
  }

  private async readLineUntil(deadline: number): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\r\n')
      if (end >= 0) {
        const line = this.buffer.subarray(0, end).toString('utf8')
        this.buffer = this.buffer.subarray(end + 2)
        return line
      }
      await this.waitForData(deadline)
    }
  }

  private async readExact(size: number, deadline: number): Promise<Buffer> {
    while (this.buffer.length < size) await this.waitForData(deadline)
    const slice = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return slice
  }

  private async waitForData(deadline: number): Promise<void> {
    if (this.failure) throw mailboxError(this.failure, 'the mailbox server')
    if (this.ended) throw new Error('Mailbox connection closed before the server answered')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('The mailbox server did not answer in time')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake)
        reject(new Error('The mailbox server did not answer in time'))
      }, remaining)
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        if (this.failure) reject(mailboxError(this.failure, 'the mailbox server'))
        else resolve()
      }
      this.waiters.add(wake)
    })
    if (this.failure) throw mailboxError(this.failure, 'the mailbox server')
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}

function mailboxError(error: unknown, host: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/certificate|self signed|unable to verify/i.test(message)) {
    return new Error(`The TLS certificate for ${host} could not be verified`)
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return new Error(`Could not find the mailbox server ${host}`)
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(message)) return new Error(`Could not reach the mailbox server ${host}`)
  return new Error(`Mailbox connection failed: ${message}`)
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function extractQuotedBody(events: Array<{ line: string; literal?: Buffer | undefined }>): string | undefined {
  for (const event of events) {
    const match = event.line.match(/BODY\[TEXT\](?:<\d+>)?\s+(?:"((?:[^"\\]|\\.)*)"|NIL)/i)
    if (match) {
      if (match[1] === undefined) return ''
      return match[1].replace(/\\(.)/g, '$1')
    }
  }
  return undefined
}

export function mimeToText(raw: string): string {
  const boundaryMatch = raw.match(/^--([^\r\n]+)\r?\n/)
  if (boundaryMatch) {
    const boundary = boundaryMatch[1]!
    const sections = raw.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?\\r?\\n?`))
    const plain: string[] = []
    const html: string[] = []
    for (const section of sections) {
      const part = parseMimePart(section)
      if (!part || part.attachment) continue
      if (part.type === 'text/plain') plain.push(part.text)
      else if (part.type === 'text/html') html.push(part.text)
    }
    if (plain.length > 0) {
      const text = plain.find((value) => value.trim())
      if (text) return limitText(text)
    }
    if (html.length > 0) {
      const text = html.find((value) => value.trim())
      if (text) return htmlToText(text)
    }
  }
  const single = parseMimePart(raw)
  if (single && !single.attachment) {
    if (single.type === 'text/html') return htmlToText(single.text)
    if (single.type === 'text/plain') return limitText(single.text)
  }
  return htmlToText(raw)
}

interface MimePart {
  type: string
  text: string
  attachment: boolean
}

function parseMimePart(section: string): MimePart | undefined {
  const normalized = section.replace(/^\r?\n/, '')
  if (!normalized.trim() || normalized.startsWith('--')) return undefined
  const separator = normalized.indexOf('\r\n\r\n')
  if (separator < 0) {
    const text = decodeTransfer(normalized.replace(/\r?\n$/, ''), '')
    return { type: 'text/plain', text, attachment: false }
  }
  const headers = parseHeaders(normalized.slice(0, separator))
  const body = normalized.slice(separator + 4).replace(/\r?\n$/, '')
  const contentType = (headers['content-type'] ?? 'text/plain').toLowerCase()
  const type = contentType.split(';')[0]!.trim()
  const attachment = /attachment/i.test(headers['content-disposition'] ?? '')
  if (!type.startsWith('text/')) return undefined
  return {
    type: type === 'text/html' ? 'text/html' : 'text/plain',
    text: decodeTransfer(body, headers['content-transfer-encoding'] ?? '', contentType),
    attachment,
  }
}

function decodeTransfer(body: string, encoding: string, contentType = ''): string {
  const normalized = encoding.toLowerCase().trim()
  let buffer: Buffer
  if (normalized === 'base64') {
    buffer = Buffer.from(body.replace(/\s+/g, ''), 'base64')
  } else if (normalized === 'quoted-printable') {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    buffer = Buffer.from(bytes, 'latin1')
  } else {
    buffer = Buffer.from(body, 'utf8')
  }
  const charset = /charset="?([^";]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8'
  const text = charset.includes('iso-8859') || charset.includes('latin1')
    ? buffer.toString('latin1')
    : buffer.toString('utf8')
  return text
}

function limitText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY_CHARS)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {}
  let current = ''
  for (const rawLine of block.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(rawLine)) {
      if (current) headers[current] = `${headers[current]} ${rawLine.trim()}`
      continue
    }
    const separator = rawLine.indexOf(':')
    if (separator <= 0) {
      current = ''
      continue
    }
    current = rawLine.slice(0, separator).trim().toLowerCase()
    headers[current] = rawLine.slice(separator + 1).trim()
  }
  return headers
}

export function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (original, charset: string, encoding: string, data: string) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(data, 'base64').toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'latin1')
      }
      const decoded = data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      return Buffer.from(decoded, 'latin1').toString('utf8')
    } catch {
      return original
    }
  })
}

export function htmlToText(value: string): string {
  const withoutBlocks = value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
  const decoded = withoutBlocks
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
  return decoded
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS)
}
