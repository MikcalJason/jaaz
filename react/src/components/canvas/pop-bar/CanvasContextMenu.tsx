import { useCanvas } from '@/contexts/canvas'
import {
  ExcalidrawFreeDrawElement,
  ExcalidrawImageElement,
} from '@excalidraw/excalidraw/element/types'
import { BinaryFiles } from '@excalidraw/excalidraw/types'
import { Eraser, Loader2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

/**
 * Load an image from a data URL and return its natural dimensions
 */
function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
}

/**
 * Create a binary mask image from freedraw strokes overlaid on an image.
 */
function createMaskFromFreedraw(
  imageElement: ExcalidrawImageElement,
  freedrawElements: ExcalidrawFreeDrawElement[],
  imageNaturalWidth: number,
  imageNaturalHeight: number
): string {
  const canvas = document.createElement('canvas')
  canvas.width = imageNaturalWidth
  canvas.height = imageNaturalHeight
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const scaleX = imageNaturalWidth / imageElement.width
  const scaleY = imageNaturalHeight / imageElement.height

  ctx.strokeStyle = '#ffffff'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const fd of freedrawElements) {
    if (!fd.points || fd.points.length === 0) continue
    const baseWidth = fd.strokeWidth || 2
    const scaledWidth = baseWidth * Math.max(scaleX, scaleY) * 3
    ctx.lineWidth = Math.max(scaledWidth, 14)

    const offsetX = fd.x - imageElement.x
    const offsetY = fd.y - imageElement.y

    ctx.beginPath()
    const points = fd.points as readonly (readonly [number, number])[]
    const firstPoint = points[0]
    ctx.moveTo(
      (offsetX + firstPoint[0]) * scaleX,
      (offsetY + firstPoint[1]) * scaleY
    )
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i]
      ctx.lineTo((offsetX + px) * scaleX, (offsetY + py) * scaleY)
    }
    ctx.stroke()
  }

  return canvas.toDataURL('image/png')
}

type MenuState = {
  x: number
  y: number
  imageElement: ExcalidrawImageElement
  freedrawElements: ExcalidrawFreeDrawElement[]
} | null

const CanvasContextMenu = () => {
  const { excalidrawAPI, canvasId } = useCanvas()
  const { t } = useTranslation()
  const [menu, setMenu] = useState<MenuState>(null)
  const [loading, setLoading] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Listen for right-click on canvas
  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      if (!excalidrawAPI) return

      const appState = excalidrawAPI.getAppState()
      const selectedIds = appState.selectedElementIds
      const allElements = excalidrawAPI.getSceneElements()

      // Find selected image and freedraw elements
      const imageElement = allElements.find(
        (el) => el.type === 'image' && selectedIds[el.id]
      ) as ExcalidrawImageElement | undefined
      const freedrawElements = allElements.filter(
        (el) => el.type === 'freedraw' && selectedIds[el.id]
      ) as ExcalidrawFreeDrawElement[]

      // Only show menu when 1 image + at least 1 freedraw selected
      if (!imageElement?.fileId || freedrawElements.length === 0) {
        setMenu(null)
        return
      }

      e.preventDefault()
      e.stopPropagation()

      setMenu({
        x: e.clientX,
        y: e.clientY,
        imageElement,
        freedrawElements,
      })
    },
    [excalidrawAPI]
  )

  // Close menu on click outside or Escape
  useEffect(() => {
    if (!menu) return

    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }

    // Delay adding listeners so the current right-click doesn't immediately close it
    const timer = setTimeout(() => {
      document.addEventListener('click', close)
      document.addEventListener('contextmenu', close)
      document.addEventListener('keydown', onKey)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', close)
      document.removeEventListener('contextmenu', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Attach contextmenu listener to the Excalidraw container
  useEffect(() => {
    // Excalidraw renders its interactive canvas — find it
    const container = document.querySelector('.excalidraw')
    if (!container) return

    container.addEventListener('contextmenu', handleContextMenu)
    return () => container.removeEventListener('contextmenu', handleContextMenu)
  }, [handleContextMenu])

  const handleInpaint = useCallback(async () => {
    if (!menu || !excalidrawAPI) return

    const { imageElement, freedrawElements } = menu
    setLoading(true)

    try {
      const files = excalidrawAPI.getFiles() as BinaryFiles
      const imageFile = files[imageElement.fileId!]
      if (!imageFile?.dataURL) {
        toast.error(t('canvas:popbar.inpaintNoImageData'))
        return
      }

      const img = await loadImageFromDataUrl(imageFile.dataURL)
      const naturalW = img.naturalWidth
      const naturalH = img.naturalHeight

      const maskBase64 = createMaskFromFreedraw(
        imageElement,
        freedrawElements,
        naturalW,
        naturalH
      )

      const response = await fetch(`/api/canvas/${canvasId}/inpaint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_b64: imageFile.dataURL,
          mask_b64: maskBase64,
        }),
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.detail || 'Inpaint request failed')
      }

      const result = await response.json()
      const inpaintedB64: string = result.inpainted_b64
      const newFileId = 'im_inpaint_' + Date.now()

      excalidrawAPI.addFiles([
        {
          id: newFileId,
          mimeType: 'image/png',
          dataURL: inpaintedB64,
          created: Date.now(),
        },
      ])

      const currentElements = excalidrawAPI.getSceneElements()
      const freedrawIds = new Set(freedrawElements.map((el) => el.id))
      const currentAppState = excalidrawAPI.getAppState()

      const updatedElements = currentElements
        .filter((el) => !freedrawIds.has(el.id))
        .map((el) => {
          if (el.id === imageElement.id && el.type === 'image') {
            return { ...el, fileId: newFileId, width: naturalW, height: naturalH }
          }
          return el
        })

      excalidrawAPI.updateScene({ elements: updatedElements })
      excalidrawAPI.updateScene({
        appState: {
          selectedElementIds: {},
          scrollX: currentAppState.scrollX,
          scrollY: currentAppState.scrollY,
          zoom: currentAppState.zoom,
        },
      })

      toast.success(t('canvas:popbar.inpaintSuccess'))
    } catch (e) {
      console.error('Inpaint failed:', e)
      toast.error(t('canvas:popbar.inpaintFailed'))
    } finally {
      setLoading(false)
      setMenu(null)
    }
  }, [menu, excalidrawAPI, canvasId, t])

  if (!menu) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[120px]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer disabled:opacity-50"
        disabled={loading}
        onClick={handleInpaint}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Eraser className="size-3.5" />
        )}
        {t('canvas:popbar.inpaint')}
      </button>
    </div>
  )
}

export default memo(CanvasContextMenu)
