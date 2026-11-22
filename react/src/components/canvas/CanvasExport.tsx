import { useCanvas } from '@/contexts/canvas'
import { saveAs } from 'file-saver'
import JSZip from 'jszip'
import { ChevronDown, FileText, ImageDown, Layers } from 'lucide-react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { jsPDF } from 'jspdf'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { ExcalidrawImageElement } from '@excalidraw/excalidraw/element/types'

type PDFQuality = { label: string; mime: string; quality?: number }

const PDF_QUALITIES: PDFQuality[] = [
  { label: 'PNG', mime: 'image/png' },
  { label: 'JPEG 1.0', mime: 'image/jpeg', quality: 1.0 },
  { label: 'JPEG 0.9', mime: 'image/jpeg', quality: 0.9 },
  { label: 'JPEG 0.85', mime: 'image/jpeg', quality: 0.85 },
]

// Per-page render caps. Rendering every page at the original image resolution
// blows up canvas + jsPDF memory on large canvases (blank PDF pages / white tab).
const MAX_RENDER_DIM = 2400
const MAX_RENDER_PIXELS = 4_000_000
// A single unreachable/corrupt data URL must never freeze the whole export.
const IMAGE_LOAD_TIMEOUT_MS = 20_000
// PNG pages above this base64 size are re-encoded as JPEG to keep memory sane.
const MAX_PNG_DATAURL_LENGTH = 6_000_000

/**
 * File-name comparator: numbers compare by value ("2.png" < "10.png") and
 * Chinese compares by pinyin (阿 < 波 < 陈) instead of code point.
 */
const NAME_COLLATOR = (() => {
  const options: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }
  try {
    return new Intl.Collator('zh-Hans-CN-u-co-pinyin', options)
  } catch {
    return new Intl.Collator('zh-CN', options)
  }
})()

const stripExtension = (name: string) => name.replace(/\.[^./\\]+$/, '')

/** Best-effort file name for an image element (batch import / linked file). */
const getImageFileName = (el: ExcalidrawImageElement): string => {
  const customName = (el.customData as Record<string, unknown> | undefined)?.fileName
  if (typeof customName === 'string' && customName.trim()) return customName.trim()

  const link = (el as unknown as { link?: string | null }).link
  if (link) {
    const segment = link.split(/[?#]/)[0].split('/').filter(Boolean).pop()
    if (segment) {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }
  }
  return ''
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = {
  十: 10, 百: 100, 千: 1000, 万: 10_000, 亿: 100_000_000,
}
const CN_NUMERAL_CHARS = [...Object.keys(CN_DIGITS), ...Object.keys(CN_UNITS)].join('')

/** 一 / 十 / 二十三 / 一百零五 / 一万 → number; null when the text is not a numeral. */
const parseChineseNumber = (text: string): number | null => {
  let total = 0
  let section = 0
  let digit = 0
  let seen = false

  for (const ch of text) {
    const d = CN_DIGITS[ch]
    if (d !== undefined) { digit = d; seen = true; continue }

    const unit = CN_UNITS[ch]
    if (unit === undefined) return null
    seen = true

    if (unit >= 100_000_000) {
      total = (total + section + digit) * unit
      section = 0
    } else if (unit >= 10_000) {
      section = (section + digit) * unit
      total += section
      section = 0
    } else {
      section += (digit || 1) * unit
    }
    digit = 0
  }

  return seen ? total + section + digit : null
}

const SORT_SPLIT_RE = new RegExp(`(\\d+|[${CN_NUMERAL_CHARS}]+)`, 'g')

/** Split a file name into text / number chunks, so 十 and 10 both compare as 10. */
const tokenizeFileName = (name: string): string[] => {
  if (!name) return []
  return stripExtension(name)
    .split(SORT_SPLIT_RE)
    .filter((part) => part.length > 0)
}

const tokenToNumber = (token: string): number | null => {
  if (/^\d+$/.test(token)) {
    const value = Number(token)
    return Number.isFinite(value) ? value : null
  }
  return parseChineseNumber(token)
}

/** Compare tokenized names: numeric chunks by value (10 > 2, 十 = 10), text by pinyin. */
const compareNameTokens = (a: string[], b: string[]): number => {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const numA = tokenToNumber(a[i])
    const numB = tokenToNumber(b[i])
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA < numB ? -1 : 1
      continue
    }
    const byText = NAME_COLLATOR.compare(a[i], b[i])
    if (byText !== 0) return byText
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length - b.length
}

const CanvasExport = () => {
  const { excalidrawAPI } = useCanvas()
  const { t } = useTranslation()
  const [pdfQuality, setPdfQuality] = useState<PDFQuality>(PDF_QUALITIES[0])

  const downloadImage = async (imageUrl: string): Promise<string> => {
    const image = new Image()
    image.src = imageUrl
    return new Promise((resolve, reject) => {
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(image, 0, 0)
        const dataURL = canvas.toDataURL('image/png')
        resolve(dataURL)
      }
      image.onerror = () => {
        reject(new Error('Failed to load image'))
      }
    })
  }

  const handleExportImages = async () => {
    if (!excalidrawAPI) return
    const toastId = toast.loading(t('canvas:messages.exportingAssets'))
    try {
      const appState = excalidrawAPI.getAppState()
      const elements = excalidrawAPI.getSceneElements()

      const selectedIds = Object.keys(appState.selectedElementIds).filter(
        (id) => appState.selectedElementIds[id]
      )

      const images = elements.filter(
        (element) =>
          selectedIds.includes(element.id) &&
          (element.type === 'image' || element.type === 'embeddable')
      )

      if (images.length === 0) {
        toast.error(t('canvas:messages.nothingSelected'))
        return
      }

      const files = excalidrawAPI.getFiles()

      // Separate embeddable elements (videos) and regular images
      const embeddableElements = images.filter(element => element.type === 'embeddable')
      const imageElements = images.filter(element => element.type === 'image')

      // Get video URLs from embeddable elements
      const videoUrls = embeddableElements
        .map((element) => {
          if ('link' in element && element.link) {
            return element.link
          }
          return null
        })
        .filter((url) => url !== null)

      // Get image URLs from regular image elements
      const imageUrls = imageElements
        .map((element) => {
          if ('fileId' in element && element.fileId) {
            const file = files[element.fileId]
            return file?.dataURL
          }
          return null
        })
        .filter((url) => url !== null)

      if (imageUrls.length === 0 && videoUrls.length === 0) {
        toast.error(t('canvas:messages.nothingSelected'))
        return
      }

      // Generate random ID for the asset package
      const randomId = Math.random().toString(36).substring(2, 15)
      const packageName = `Asset-${randomId}.zip`

      // If only one image and no videos, save directly
      if (imageUrls.length === 1 && videoUrls.length === 0) {
        const imageUrl = imageUrls[0]
        const dataURL = await downloadImage(imageUrl)
        saveAs(dataURL, `Asset-${randomId}.png`)
        return
      }

      // If only one video and no images, save directly
      if (videoUrls.length === 1 && imageUrls.length === 0) {
        const videoUrl = videoUrls[0]
        const response = await fetch(videoUrl)
        const blob = await response.blob()
        saveAs(blob, `Asset-${randomId}.mp4`)
        return
      }

      // Create a zip package for multiple assets or mixed types
      const zip = new JSZip()

      // Add videos to zip
      await Promise.all(
        videoUrls.map(async (videoUrl, index) => {
          const response = await fetch(videoUrl)
          const blob = await response.blob()
          zip.file(`video-${index + 1}.mp4`, blob)
        })
      )

      // Add images to zip
      await Promise.all(
        imageUrls.map(async (imageUrl, index) => {
          const dataURL = await downloadImage(imageUrl)
          if (dataURL) {
            zip.file(
              `image-${index + 1}.png`,
              dataURL.replace('data:image/png;base64,', ''),
              { base64: true }
            )
          }
        })
      )

      const content = await zip.generateAsync({ type: 'blob' })
      saveAs(content, packageName)
    } catch (error) {
      toast.error(t('canvas:messages.failedToExportImages'), {
        id: toastId,
        duration: 4000,
      })
    }
  }

  // ---- shared helpers ----

  /** Find elements overlapping with a base image */
  const getOverlappingElements = (
    base: ExcalidrawImageElement,
    allElements: readonly { id: string; type: string; x: number; y: number; width: number; height: number }[],
    extraIds: Set<string>,
  ) => {
    const bl = base.x, bt = base.y, br = base.x + base.width, bb = base.y + base.height
    return allElements.filter(el => {
      if (el.id === base.id) return false
      if (extraIds.has(el.id)) return true
      if (el.type === 'text' || el.type === 'image') {
        const elr = el.x + el.width, elb = el.y + el.height
        return el.x < br && elr > bl && el.y < bb && elb > bt
      }
      return false
    })
  }

  /**
   * Load an image with a hard timeout: a corrupt/unreachable dataURL resolves to
   * null instead of leaving the await pending forever (which "freezes" the export).
   */
  const loadImage = (src: string, timeoutMs = IMAGE_LOAD_TIMEOUT_MS): Promise<HTMLImageElement | null> =>
    new Promise((resolve) => {
      const img = new Image()
      let settled = false
      const finish = (result: HTMLImageElement | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        img.onload = null
        img.onerror = null
        resolve(result)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      img.onload = () => finish(img.naturalWidth && img.naturalHeight ? img : null)
      img.onerror = () => finish(null)
      img.src = src
    })

  /** Render a base image + overlays onto an offscreen canvas, capped to a safe resolution */
  const renderCompositeImage = async (
    base: ExcalidrawImageElement,
    overlays: { id: string; type: string; x: number; y: number; width: number; height: number; fileId?: string; fontSize?: number; strokeColor?: string; text?: string; angle?: number }[],
    files: ReturnType<typeof excalidrawAPI.getFiles>,
  ): Promise<HTMLCanvasElement | null> => {
    const file = base.fileId ? files[base.fileId] : null
    if (!file?.dataURL) return null
    if (!base.width || !base.height) return null

    // Load base image
    const img = await loadImage(file.dataURL)
    if (!img) return null

    const origW = img.naturalWidth, origH = img.naturalHeight
    if (!origW || !origH) return null

    // Cap the render resolution so many pages don't exhaust canvas/jsPDF memory.
    let renderScale = 1
    const maxDim = Math.max(origW, origH)
    if (maxDim > MAX_RENDER_DIM) renderScale = MAX_RENDER_DIM / maxDim
    const scaledPixels = origW * origH * renderScale * renderScale
    if (scaledPixels > MAX_RENDER_PIXELS) {
      renderScale *= Math.sqrt(MAX_RENDER_PIXELS / scaledPixels)
    }
    const renderW = Math.max(1, Math.round(origW * renderScale))
    const renderH = Math.max(1, Math.round(origH * renderScale))
    const scale = renderW / base.width

    const canvas = document.createElement('canvas')
    canvas.width = renderW; canvas.height = renderH
    const ctx = canvas.getContext('2d')
    if (!ctx) { canvas.width = 0; canvas.height = 0; return null }

    ctx.drawImage(img, 0, 0, renderW, renderH)

    for (const el of overlays) {
      const rx = (el.x - base.x) * scale, ry = (el.y - base.y) * scale
      if (el.type === 'image' && el.fileId) {
        const of = files[el.fileId]; if (!of?.dataURL) continue
        const oi = await loadImage(of.dataURL)
        // Skip a broken overlay rather than blocking the whole page.
        if (!oi) continue
        ctx.drawImage(oi, rx, ry, el.width * scale, el.height * scale)
      } else if (el.type === 'text' && el.fontSize) {
        ctx.save()
        if (el.angle) { const cx = rx + (el.width * scale) / 2, cy = ry + (el.height * scale) / 2; ctx.translate(cx, cy); ctx.rotate(el.angle); ctx.translate(-cx, -cy) }
        ctx.font = `${Math.round(el.fontSize * scale)}px sans-serif`
        ctx.fillStyle = el.strokeColor || '#1e1e1e'
        ctx.textBaseline = 'top'; ctx.textAlign = 'left'
        const lines = (el.text || '').split('\n'), lh = el.fontSize * scale * 1.3
        lines.forEach((line, i) => ctx.fillText(line, rx, ry + i * lh))
        ctx.restore()
      }
    }
    return canvas
  }

  // ---- composite export (single image + overlays) ----

  const handleCompositeExport = async () => {
    if (!excalidrawAPI) return
    const toastId = toast.loading(t('canvas:messages.compositing'))

    try {
      const appState = excalidrawAPI.getAppState()
      const elements = excalidrawAPI.getSceneElements()
      const files = excalidrawAPI.getFiles()

      const selectedIds = Object.keys(appState.selectedElementIds).filter(id => appState.selectedElementIds[id])
      if (selectedIds.length === 0) {
        toast.error(t('canvas:messages.nothingSelected'), { id: toastId, duration: 4000 }); return
      }

      const base = elements.find(el => selectedIds.includes(el.id) && el.type === 'image') as ExcalidrawImageElement | undefined
      if (!base) { toast.error(t('canvas:messages.compositeNeedImage'), { id: toastId, duration: 4000 }); return }

      const overlays = getOverlappingElements(base, elements as any, new Set(selectedIds))
      const seenIds = new Set([base.id, ...overlays.map(e => e.id)])
      const extraSelected = elements.filter(el => selectedIds.includes(el.id) && !seenIds.has(el.id))
      const allOverlays = [...overlays, ...extraSelected]

      const canvas = await renderCompositeImage(base, allOverlays as any, files)
      if (!canvas) throw new Error('Render failed')

      const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
      if (blob) {
        saveAs(blob, `composite-${Date.now()}.png`)
        toast.success(t('canvas:messages.compositeSuccess'), { id: toastId, duration: 4000 })
      } else throw new Error('No blob')
    } catch (error) {
      console.error('Composite export error:', error)
      toast.error(t('canvas:messages.compositeFailed'), { id: toastId, duration: 4000 })
    }
  }

  // ---- PDF export (all images as pages, each composited with its overlays) ----

  const handleExportPDF = async () => {
    if (!excalidrawAPI) return
    const toastId = toast.loading(t('canvas:messages.exportingPDF'))

    try {
      const elements = excalidrawAPI.getSceneElements()
      const files = excalidrawAPI.getFiles()

      const allImages = elements.filter(el => el.type === 'image' && (el as any).fileId) as ExcalidrawImageElement[]
      if (allImages.length === 0) {
        toast.error(t('canvas:messages.noImagesToExport'), { id: toastId, duration: 4000 }); return
      }

      // Sort by area descending → group overlays under base images
      const sorted = [...allImages].sort((a, b) => (b.width * b.height) - (a.width * a.height))
      const processed = new Set<string>()
      const groups: { base: ExcalidrawImageElement; overlays: ExcalidrawImageElement[] }[] = []

      for (const img of sorted) {
        if (processed.has(img.id)) continue
        let isOverlay = false
        for (const g of groups) {
          const bl = g.base.x, bt = g.base.y, br = g.base.x + g.base.width, bb = g.base.y + g.base.height
          if (img.x < br && img.x + img.width > bl && img.y < bb && img.y + img.height > bt) {
            g.overlays.push(img); processed.add(img.id); isOverlay = true; break
          }
        }
        if (!isOverlay) { groups.push({ base: img, overlays: [] }); processed.add(img.id) }
      }
      // Sort groups by extracted file name: numbers (2/十/二十三) by value,
      // Chinese by pinyin. Images without a name keep their creation order.
      const sortKeys = new Map<string, { name: string; tokens: string[]; created: number }>()
      for (const g of groups) {
        const name = getImageFileName(g.base)
        sortKeys.set(g.base.id, {
          name,
          tokens: tokenizeFileName(name),
          created: g.base.fileId ? files[g.base.fileId]?.created ?? 0 : 0,
        })
      }
      const fileNameOf = (el: ExcalidrawImageElement) => sortKeys.get(el.id)?.name ?? ''

      groups.sort((a, b) => {
        const keyA = sortKeys.get(a.base.id)!
        const keyB = sortKeys.get(b.base.id)!
        const hasA = keyA.name.length > 0
        const hasB = keyB.name.length > 0

        if (hasA && hasB) {
          const byTokens = compareNameTokens(keyA.tokens, keyB.tokens)
          if (byTokens !== 0) return byTokens
          const byFull = NAME_COLLATOR.compare(keyA.name, keyB.name)
          if (byFull !== 0) return byFull
        } else if (hasA !== hasB) {
          return hasA ? -1 : 1
        }

        if (keyA.created !== keyB.created) return keyA.created - keyB.created
        return String(a.base.fileId ?? '').localeCompare(String(b.base.fileId ?? ''))
      })

      // Create PDF
      const pdf = new jsPDF('portrait', 'mm', 'a4')
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      const margin = 10
      const total = groups.length

      // Process one group at a time to keep memory low
      let pagesAdded = 0
      const failedPages: string[] = []

      for (let i = 0; i < total; i++) {
        const { base, overlays } = groups[i]
        const label = fileNameOf(base) || base.fileId || `#${i + 1}`

        // Show progress
        toast.loading(t('canvas:messages.exportingPDFProgress', { current: i + 1, total }), { id: toastId })

        const allOverlays = [
          ...overlays,
          ...getOverlappingElements(base, elements as any, new Set()),
        ].filter((el, idx, arr) => arr.findIndex(e => e.id === el.id) === idx)

        let canvas: HTMLCanvasElement | null = null
        try {
          canvas = await renderCompositeImage(base, allOverlays as any, files)
          if (!canvas) { failedPages.push(String(label)); continue }

          const ratio = canvas.width / canvas.height

          // Convert to chosen format (PNG or JPEG). An empty/oversized PNG result
          // is re-encoded as JPEG, otherwise jsPDF ends up with a blank page.
          let dataUrl = canvas.toDataURL(pdfQuality.mime, pdfQuality.quality)
          let format: 'PNG' | 'JPEG' = pdfQuality.mime === 'image/png' ? 'PNG' : 'JPEG'
          if (
            format === 'PNG' &&
            (!dataUrl || dataUrl.length < 100 || dataUrl.length > MAX_PNG_DATAURL_LENGTH)
          ) {
            dataUrl = canvas.toDataURL('image/jpeg', 0.92)
            format = 'JPEG'
          }
          if (!dataUrl || dataUrl.length < 100) throw new Error(`Empty image data for ${label}`)

          // Scale to fit page
          let dw = pageW - margin * 2, dh = dw / ratio
          if (dh > pageH - margin * 2) { dh = pageH - margin * 2; dw = dh * ratio }

          // Only add a page once we actually have an image (avoid blank pages)
          if (pagesAdded > 0) pdf.addPage()
          pdf.addImage(dataUrl, format,
            margin + (pageW - margin * 2 - dw) / 2, margin + (pageH - margin * 2 - dh) / 2, dw, dh)
          pagesAdded++
        } catch (pageError) {
          console.error(`PDF page failed (${label}):`, pageError)
          failedPages.push(String(label))
        } finally {
          // Release the backing store immediately so peak memory stays flat
          if (canvas) { canvas.width = 0; canvas.height = 0 }
        }

        // Yield to the event loop so the UI keeps painting (no white screen)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      if (pagesAdded === 0) throw new Error('No page could be rendered')

      toast.loading(t('canvas:messages.exportingPDFSaving'), { id: toastId })
      // Yield once more before the synchronous jsPDF serialization
      await new Promise((resolve) => setTimeout(resolve, 0))
      pdf.save(`export-${new Date().toISOString().slice(0, 10)}.pdf`)

      if (failedPages.length > 0) {
        toast.warning(
          t('canvas:messages.exportPDFPartial', { count: failedPages.length }),
          { id: toastId, duration: 5000 }
        )
      } else {
        toast.success(t('canvas:messages.exportPDFSuccess'), { id: toastId, duration: 4000 })
      }
    } catch (error) {
      console.error('PDF export error:', error)
      toast.error(t('canvas:messages.exportPDFFailed'), { id: toastId, duration: 4000 })
    }
  }

  return (
    <div className="inline-flex -space-x-px rounded-md shadow-xs rtl:space-x-reverse">
      <Button
        className="rounded-none shadow-none first:rounded-s-md last:rounded-e-md h-8"
        variant="outline"
        onClick={handleExportImages}
        title={t('canvas:exportImages')}
      >
        <ImageDown className="size-4" />
        {t('canvas:exportImages')}
      </Button>
      <Button
        className="rounded-none shadow-none first:rounded-s-md last:rounded-e-md h-8"
        variant="outline"
        onClick={handleCompositeExport}
        title={t('canvas:compositeExport')}
      >
        <Layers className="size-4" />
        {t('canvas:compositeExport')}
      </Button>
      <div className="inline-flex -space-x-px rounded-md shadow-xs rtl:space-x-reverse">
        <Button
          className="rounded-none shadow-none first:rounded-s-md h-8"
          variant="outline"
          onClick={handleExportPDF}
          title={t('canvas:exportPDF')}
        >
          <FileText className="size-4" />
          {t('canvas:exportPDF')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="rounded-none shadow-none last:rounded-e-md h-8 px-1.5" variant="outline">
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[120px]">
            {PDF_QUALITIES.map((q) => (
              <DropdownMenuItem key={q.label} onClick={() => setPdfQuality(q)}>
                <span>{q.label}</span>
                {pdfQuality.label === q.label && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export default CanvasExport
