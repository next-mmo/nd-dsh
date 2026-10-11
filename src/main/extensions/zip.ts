import { deflateRawSync } from 'node:zlib'

/**
 * Minimal ZIP writer for bundling the extension starter kit.
 *
 * Deliberately dependency-free: Node's `deflateRawSync` provides the deflate
 * stream, and the container format is a few fixed-size structs. Output is
 * deterministic (fixed timestamps) so builds and tests can compare bytes.
 */

export interface ZipEntry {
  /** Archive-relative path with forward slashes; no absolute paths or `..`. */
  path: string
  data: string | Buffer
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Fixed MS-DOS timestamp (1980-01-01 00:00) keeps archives reproducible. */
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1 // month 1, day 1

function normalizeEntryPath(path: string): string {
  const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`Invalid zip entry path: ${path}`)
  }
  if (/^[a-z]:/i.test(cleaned)) throw new Error(`Invalid zip entry path: ${path}`)
  return cleaned
}

/**
 * Builds a ZIP-2.0 archive (deflate) from the given entries, in order.
 * Text entries are encoded UTF-8.
 */
export function createZipFile(entries: readonly ZipEntry[]): Buffer {
  if (entries.length === 0 || entries.length > 65_534) {
    throw new Error('A starter archive needs between 1 and 65534 entries')
  }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(normalizeEntryPath(entry.path), 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    if (raw.length > 0xffffffff) throw new Error(`Zip entry too large: ${entry.path}`)
    const crc = crc32(raw)
    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    name.copy(local, 30)
    locals.push(local, payload)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + payload.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, centralDirectory, end])
}
