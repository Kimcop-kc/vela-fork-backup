/**
 * 最小 ZIP 打包器（零依赖）
 *
 * 只做「够用」的事：把若干条目打成一个标准 ZIP（store / deflate），
 * 用于 EPUB（OCF 本质就是 ZIP）与项目备份包。
 *
 * 之所以自己写而不是引入 jszip / archiver：
 * 打包只发生在主进程，node:zlib 已经够用，少一个依赖少一份安装风险。
 */

import { deflateRawSync } from 'node:zlib'

/** 一个待打包条目 */
export interface ZipEntry {
  /** 包内路径，统一用 / 分隔 */
  path: string
  data: Buffer | string
  /** 强制不压缩（EPUB 规范要求 mimetype 必须是 store） */
  store?: boolean
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

/** 标准 CRC-32（ZIP 校验用） */
export function crc32(buffer: Buffer): number {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/** Date → DOS 时间/日期（ZIP 头里的老格式） */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function toBuffer(data: Buffer | string): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
}

/** 打一个 ZIP 包，返回完整字节 */
export function createZip(entries: ZipEntry[], createdAt: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(createdAt)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf-8')
    const raw = toBuffer(entry.data)
    const crc = crc32(raw)
    const deflated = entry.store ? null : deflateRawSync(raw)
    // 压不小就按原样存，避免「越压越大」
    const useDeflate = deflated !== null && deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)        // 需要的解压版本
    local.writeUInt16LE(0x0800, 6)    // 标志位：文件名按 UTF-8 编码
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)        // 扩展字段长度

    chunks.push(local, name, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)           // 制作版本
    cd.writeUInt16LE(20, 6)           // 解压版本
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30)           // 扩展字段
    cd.writeUInt16LE(0, 32)           // 注释
    cd.writeUInt16LE(0, 34)           // 起始磁盘
    cd.writeUInt16LE(0, 36)           // 内部属性
    cd.writeUInt32LE(0, 38)           // 外部属性
    cd.writeUInt32LE(offset, 42)      // 本地头偏移
    central.push(cd, name)

    offset += local.length + name.length + body.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)             // 本磁盘编号
  end.writeUInt16LE(0, 6)             // 中央目录起始磁盘
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)            // 注释长度

  return Buffer.concat([...chunks, centralBuffer, end])
}
