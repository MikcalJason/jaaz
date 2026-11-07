/**
 * PNG Metadata Reader - 前端直接读取PNG文件的metadata
 *
 * PNG文件格式：
 * - PNG signature: 8字节
 * - Chunks: 每个chunk包含长度(4字节) + 类型(4字节) + 数据 + CRC(4字节)
 * - 文本信息存储在tEXt、zTXt、iTXt chunks中
 * - 优化：只读取metadata chunks，不读取图像数据
 */

interface PngChunk {
  length: number
  type: string
  data: Uint8Array
  crc: number
}

interface PngMetadata {
  success: boolean
  metadata: Record<string, any>
  has_metadata: boolean
  error?: string
}

/**
 * 从ArrayBuffer中读取4字节big-endian整数
 */
function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] << 24) |
    (buffer[offset + 1] << 16) |
    (buffer[offset + 2] << 8) |
    buffer[offset + 3]
  )
}

/**
 * 从ArrayBuffer中读取字符串
 */
function readString(
  buffer: Uint8Array,
  offset: number,
  length: number
): string {
  return new TextDecoder('utf-8').decode(buffer.slice(offset, offset + length))
}

/**
 * 检查PNG文件头
 */
function isPNG(buffer: Uint8Array): boolean {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buffer.length < 8) return false

  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== pngSignature[i]) return false
  }
  return true
}

/**
 * 解析PNG chunks，只解析metadata相关的chunks
 */
function parsePNGMetadataChunks(buffer: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = []
  let offset = 8 // 跳过PNG signature

  while (offset < buffer.length - 8) {
    if (offset + 8 > buffer.length) break

    const length = readUint32BE(buffer, offset)
    const type = readString(buffer, offset + 4, 4)

    // 如果没有足够的数据来读取完整的chunk，退出循环
    if (offset + 12 + length > buffer.length) break

    // 如果遇到图像数据chunk，说明metadata部分已经结束，可以停止解析
    if (type === 'IDAT') {
      break
    }

    const data = buffer.slice(offset + 8, offset + 8 + length)
    const crc = readUint32BE(buffer, offset + 8 + length)

    chunks.push({ length, type, data, crc })

    offset += 12 + length

    // 如果遇到IEND chunk，停止解析
    if (type === 'IEND') break
  }

  return chunks
}

/**
 * 解析tEXt chunk
 */
function parseTextChunk(data: Uint8Array): [string, string] | null {
  try {
    const text = new TextDecoder('latin1').decode(data)
    const nullIndex = text.indexOf('\0')
    if (nullIndex === -1) return null

    const keyword = text.substring(0, nullIndex)
    const value = text.substring(nullIndex + 1)

    return [keyword, value]
  } catch (error) {
    console.error('Error parsing tEXt chunk:', error)
    return null
  }
}

/**
 * 解析zTXt chunk (压缩文本)
 */
function parseZTextChunk(data: Uint8Array): [string, string] | null {
  try {
    const text = new TextDecoder('latin1').decode(data)
    const nullIndex = text.indexOf('\0')
    if (nullIndex === -1) return null

    const keyword = text.substring(0, nullIndex)
    // 跳过compression method byte
    const compressedData = data.slice(nullIndex + 2)

    // 这里需要zlib解压缩，为了简化我们先跳过 zTXt
    return [keyword, '[Compressed Text - Not Implemented]']
  } catch (error) {
    console.error('Error parsing zTXt chunk:', error)
    return null
  }
}

/**
 * 解析iTXt chunk (国际化文本)
 */
function parseITextChunk(data: Uint8Array): [string, string] | null {
  try {
    let offset = 0
    const text = new TextDecoder('utf-8').decode(data)

    // 查找第一个null字符（keyword结束）
    const keywordEnd = text.indexOf('\0')
    if (keywordEnd === -1) return null

    const keyword = text.substring(0, keywordEnd)
    offset = keywordEnd + 1

    // 跳过compression flag和compression method
    offset += 2

    // 查找language tag结束
    const languageEnd = text.indexOf('\0', offset)
    if (languageEnd === -1) return null
    offset = languageEnd + 1

    // 查找translated keyword结束
    const translatedEnd = text.indexOf('\0', offset)
    if (translatedEnd === -1) return null
    offset = translatedEnd + 1

    // 剩余的就是文本内容
    const value = text.substring(offset)

    return [keyword, value]
  } catch (error) {
    console.error('Error parsing iTXt chunk:', error)
    return null
  }
}

/** 合并多个 Uint8Array */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * 用 Range 请求读取指定字节区间。
 * 若服务端不支持 Range（返回 200 全量），只消费需要的字节后立即取消连接，
 * 避免为了几百字节 metadata 而下载整张大图。
 */
async function fetchRange(
  url: string,
  start: number,
  end: number
): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  })

  if (response.status === 416) return new Uint8Array(0)
  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch file: ${response.status}`)
  }

  if (response.status === 200 && response.body) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    const limit = end + 1
    let seen = 0

    try {
      while (seen < limit) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue

        const chunkStart = seen
        seen += value.byteLength
        if (seen <= start) continue
        chunks.push(
          chunkStart >= start ? value : value.subarray(start - chunkStart)
        )
      }
    } finally {
      await reader.cancel().catch(() => {})
    }

    return concatChunks(chunks)
  }

  return new Uint8Array(await response.arrayBuffer())
}

/**
 * 扫描已下载的数据是否已经覆盖到图像数据（IDAT/IEND）。
 * 返回 true 表示 metadata 部分已经完整，无需继续下载。
 */
function metadataComplete(buffer: Uint8Array): boolean {
  let offset = 8 // 跳过 PNG signature

  while (offset < buffer.length - 8) {
    const length = readUint32BE(buffer, offset)
    if (length < 0) return true

    // 当前 chunk 还没有下载完整
    if (offset + 12 + length > buffer.length) return false

    const type = readString(buffer, offset + 4, 4)
    if (type === 'IDAT' || type === 'IEND') return true

    offset += 12 + length
  }

  return false
}

const INITIAL_READ_SIZE = 32 * 1024
const MAX_READ_SIZE = 512 * 1024

/**
 * 渐进式读取PNG文件，只读取metadata部分。
 * 首次读 32KB（绝大多数情况一次请求即可命中 IDAT），不够再翻倍，
 * 相比旧实现每次 8KB 轮询，请求数减少一个数量级。
 */
async function readPNGHeaderAndMetadata(url: string): Promise<Uint8Array> {
  let requestedSize = INITIAL_READ_SIZE
  let buffer = await fetchRange(url, 0, requestedSize - 1)

  if (!isPNG(buffer)) {
    throw new Error('Not a valid PNG file')
  }

  while (requestedSize < MAX_READ_SIZE && !metadataComplete(buffer)) {
    const nextSize = Math.min(requestedSize * 2, MAX_READ_SIZE)
    const more = await fetchRange(url, requestedSize, nextSize - 1)
    if (more.byteLength === 0) break

    buffer = concatChunks([buffer, more])
    // 返回的数据少于请求量，说明已经读到文件末尾
    if (more.byteLength < nextSize - requestedSize) break
    requestedSize = nextSize
  }

  return buffer
}

// metadata 缓存 + 并发限制：网格里一次性渲染几十上百张 PNG 时，
// 不能同时发起大量请求，否则会把后端和浏览器连接池打满。
const METADATA_CACHE_LIMIT = 1000
const MAX_CONCURRENT_REQUESTS = 3
const metadataCache = new Map<string, PngMetadata>()
let activeRequests = 0
const requestQueue: Array<() => void> = []

function withRequestSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeRequests += 1
      task()
        .then(resolve, reject)
        .finally(() => {
          activeRequests -= 1
          const next = requestQueue.shift()
          if (next) next()
        })
    }

    if (activeRequests < MAX_CONCURRENT_REQUESTS) run()
    else requestQueue.push(run)
  })
}

function cacheMetadata(key: string, value: PngMetadata) {
  if (metadataCache.size >= METADATA_CACHE_LIMIT) {
    const oldestKey = metadataCache.keys().next().value
    if (oldestKey !== undefined) metadataCache.delete(oldestKey)
  }
  metadataCache.set(key, value)
}

/**
 * 从PNG文件中提取metadata (优化版本，带缓存与并发限制)
 */
export async function readPNGMetadata(url: string): Promise<PngMetadata> {
  const cached = metadataCache.get(url)
  if (cached) return cached

  const result = await withRequestSlot(async (): Promise<PngMetadata> => {
    try {
      const buffer = await readPNGHeaderAndMetadata(url)
      const chunks = parsePNGMetadataChunks(buffer)
      const metadata: Record<string, unknown> = {}

      // 处理文本chunks
      for (const chunk of chunks) {
        let parsed: [string, string] | null = null

        switch (chunk.type) {
          case 'tEXt':
            parsed = parseTextChunk(chunk.data)
            break
          case 'zTXt':
            parsed = parseZTextChunk(chunk.data)
            break
          case 'iTXt':
            parsed = parseITextChunk(chunk.data)
            break
        }

        if (parsed) {
          const [key, value] = parsed
          try {
            // 尝试解析JSON
            if (value.startsWith('{') || value.startsWith('[')) {
              metadata[key] = JSON.parse(value)
            } else {
              metadata[key] = value
            }
          } catch (e) {
            metadata[key] = value
          }
        }
      }

      return {
        success: true,
        metadata,
        has_metadata: Object.keys(metadata).length > 0,
      }
    } catch (error) {
      return {
        success: false,
        metadata: {},
        has_metadata: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  cacheMetadata(url, result)
  return result
}

/**
 * 检查文件是否为PNG格式 (优化版本)
 */
export async function isPNGFile(filePath: string): Promise<boolean> {
  try {
    const response = await fetch(filePath, {
      headers: { Range: 'bytes=0-7' }, // 只获取前8字节
    })

    if (!response.ok) return false

    const arrayBuffer = await response.arrayBuffer()
    const buffer = new Uint8Array(arrayBuffer)

    return isPNG(buffer)
  } catch (error) {
    console.error('Error checking PNG file:', error)
    return false
  }
}
