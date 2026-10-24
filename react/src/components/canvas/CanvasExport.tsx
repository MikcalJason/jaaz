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

  /** Render a base image + overlays onto an offscreen canvas at original resolution */
  const renderCompositeImage = async (
    base: ExcalidrawImageElement,
    overlays: { id: string; type: string; x: number; y: number; width: number; height: number; fileId?: string; fontSize?: number; strokeColor?: string; text?: string; angle?: number }[],
    files: ReturnType<typeof excalidrawAPI.getFiles>,
  ): Promise<HTMLCanvasElement | null> => {
    const file = base.fileId ? files[base.fileId] : null
    if (!file?.dataURL) return null
    if (!base.width || !base.height) return null

    // Load base image
    const img = new Image(); img.src = file.dataURL
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject() }).catch(() => null)
    if (!img.naturalWidth) return null

    const origW = img.naturalWidth, origH = img.naturalHeight
    const scale = origW / base.width

    const canvas = document.createElement('canvas')
    canvas.width = origW; canvas.height = origH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(img, 0, 0, origW, origH)

    for (const el of overlays) {
      const rx = (el.x - base.x) * scale, ry = (el.y - base.y) * scale
      if (el.type === 'image' && el.fileId) {
        const of = files[el.fileId]; if (!of?.dataURL) continue
        const oi = new Image(); oi.src = of.dataURL
        await new Promise<void>((resolve) => { oi.onload = () => resolve() })
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
      // Sort groups by file name (if available), fall back to fileId
      groups.sort((a, b) => {
        const nameA = (a.base as any).customData?.fileName || a.base.fileId || ''
        const nameB = (b.base as any).customData?.fileName || b.base.fileId || ''
        return nameA.localeCompare(nameB)
      })

      // Create PDF
      const pdf = new jsPDF('portrait', 'mm', 'a4')
      const pageW = pdf.internal.pageSize.getWidth()
      const pageH = pdf.internal.pageSize.getHeight()
      const margin = 10
      const total = groups.length

      // Process one group at a time to keep memory low
      for (let i = 0; i < total; i++) {
        const { base, overlays } = groups[i]
        if (i > 0) pdf.addPage()

        // Show progress
        toast.loading(t('canvas:messages.exportingPDFProgress', { current: i + 1, total }), { id: toastId })

        const allOverlays = [
          ...overlays,
          ...getOverlappingElements(base, elements as any, new Set()),
        ].filter((el, idx, arr) => arr.findIndex(e => e.id === el.id) === idx)

        const canvas = await renderCompositeImage(base, allOverlays as any, files)
        if (!canvas) continue

        // Convert to chosen format (PNG or JPEG)
        const dataUrl = canvas.toDataURL(pdfQuality.mime, pdfQuality.quality)

        // Scale to fit page
        const ratio = canvas.width / canvas.height
        let dw = pageW - margin * 2, dh = dw / ratio
        if (dh > pageH - margin * 2) { dh = pageH - margin * 2; dw = dh * ratio }
        pdf.addImage(dataUrl, pdfQuality.mime === 'image/png' ? 'PNG' : 'JPEG',
          margin + (pageW - margin * 2 - dw) / 2, margin + (pageH - margin * 2 - dh) / 2, dw, dh)
      }

      pdf.save(`export-${new Date().toISOString().slice(0, 10)}.pdf`)
      toast.success(t('canvas:messages.exportPDFSuccess'), { id: toastId, duration: 4000 })
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
