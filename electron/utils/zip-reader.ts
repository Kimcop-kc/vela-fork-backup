/**
 * 最小 ZIP 读取器（零依赖）
 *
 * 只做 Skill 分发需要的事：把 zip 解成「包内路径 → 内容」列表。
 * 支持 store(0) 与 deflate(8) 两种存储方式；ZIP64 直接报错。
 * 包内路径一律归一化成 `/` 分隔的相对路径，并挡掉绝对路径与 `..` 穿越。
 */

import zlib from 'node:zlib'

export interface ReadZipEntry {
  path: string
  data: Buffer
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** 解压后总大小上限（64MB）与条目数上限，挡住解压炸弹 */
const MAX_TOTAL_SIZE = 64 * 1024 * 1024
const MAX_ENTRIES = 2000

/** 从尾部往前找中央目录结束记录（注释最长 64KB） */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/** 归一化包内路径；目录项与非法路径返回 null */
export function normalizeZipEntryPath(raw: string): string | null {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!cleaned || cleaned.endsWith('/')) return null
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return null
  if (cleaned.split('/').some(segment => segment === '..')) return null
  return cleaned
}

/** 解析 zip，按包内顺序返回文件条目 */
export function readZip(buffer: Buffer): ReadZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是有效的 zip 文件')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的压缩包')
  }
  if (entryCount > MAX_ENTRIES) throw new Error(`压缩包条目过多（${entryCount} 个）`)

  const result: ReadZipEntry[] = []
  let totalSize = 0
  let offset = cdOffset

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CD_SIG) {
      throw new Error('压缩包中央目录已损坏')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf-8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    const entryPath = normalizeZipEntryPath(name)
    if (!entryPath) continue

    totalSize += uncompressedSize
    if (totalSize > MAX_TOTAL_SIZE) throw new Error('压缩包解压后过大（超过 64MB）')
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error('压缩包本地文件头已损坏')
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)

    if (method === 0) result.push({ path: entryPath, data: Buffer.from(raw) })
    else if (method === 8) result.push({ path: entryPath, data: zlib.inflateRawSync(raw) })
    else throw new Error(`压缩包含不支持的压缩方式（method ${method}）`)
  }

  return result
}

/** 所有条目都在同一个顶层目录下时去掉它（GitHub zipball 的固定形态） */
export function stripArchiveRoot(entries: ReadZipEntry[]): ReadZipEntry[] {
  if (entries.length < 2) return entries
  const root = entries[0].path.split('/')[0]
  if (!entries.every(entry => entry.path.startsWith(`${root}/`))) return entries
  return entries.map(entry => ({ ...entry, path: entry.path.slice(root.length + 1) }))
}
