import { describe, expect, it } from 'vitest'
import { decodeHeader, extractQuotedBody, htmlToText, mimeToText, parseHeaders } from '../src/main/extensions/access-imap.js'

describe('mail parsing', () => {
  it('parses folded headers case-insensitively', () => {
    const headers = parseHeaders([
      'From: Example Sender <sender@example.com>',
      'Subject: A long',
      ' folded subject',
      'Date: Mon, 9 Nov 2026 10:00:00 +0000',
    ].join('\r\n'))
    expect(headers.from).toBe('Example Sender <sender@example.com>')
    expect(headers.subject).toBe('A long folded subject')
    expect(headers.date).toBe('Mon, 9 Nov 2026 10:00:00 +0000')
  })

  it('decodes RFC 2047 headers', () => {
    expect(decodeHeader('=?UTF-8?B?SGVsbG8gV29ybGQ=?=')).toBe('Hello World')
    expect(decodeHeader('=?UTF-8?Q?Caf=C3=A9?=')).toBe('Café')
  })

  it('reads quoted-string bodies and NIL', () => {
    expect(extractQuotedBody([{ line: ' BODY[TEXT]<0> "Hello \\"there\\""' }])).toBe('Hello "there"')
    expect(extractQuotedBody([{ line: ' BODY[TEXT]<0> NIL' }])).toBe('')
    expect(extractQuotedBody([{ line: ' BODY[HEADER.FIELDS (FROM)] {12}' }])).toBeUndefined()
  })

  it('extracts readable text from MIME bodies', () => {
    const multipart = [
      '--outer-boundary',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      'SGVsbG8gZnJvbSB0aGUgaW5ib3g=',
      '--outer-boundary',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      '<p>HTML fallback</p>',
      '--outer-boundary--',
    ].join('\r\n')
    expect(mimeToText(multipart)).toBe('Hello from the inbox')

    const htmlOnly = ['--b', 'Content-Type: text/html', '', '<p>Hi&nbsp;there</p>', '--b--'].join('\r\n')
    expect(mimeToText(htmlOnly)).toBe('Hi there')

    const quoted = ['--q', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=C3=A9', '--q--'].join('\r\n')
    expect(mimeToText(quoted)).toBe('Café')

    const single = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', 'UGxhaW4gdGV4dA=='].join('\r\n')
    expect(mimeToText(single)).toBe('Plain text')
  })

  it('converts HTML mail to bounded plain text', () => {
    const text = htmlToText('<style>.x{}</style><p>Hello&nbsp;<strong>there</strong></p><script>alert(1)</script><p>Bye &amp; thanks</p>')
    expect(text).toBe('Hello there\n\nBye & thanks')
    expect(htmlToText('x'.repeat(50_000))).toHaveLength(20_000)
  })
})
