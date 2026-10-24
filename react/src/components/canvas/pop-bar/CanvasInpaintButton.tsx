import { Button } from '@/components/ui/button'
import { useCanvas } from '@/contexts/canvas'
import {
  ExcalidrawFreeDrawElement,
  ExcalidrawImageElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import { BinaryFiles } from '@excalidraw/excalidraw/types'
import { Loader2, Eraser } from 'lucide-react'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

type CanvasInpaintButtonProps = {
  selectedElements: OrderedExcalidrawElement[]
}

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
 * Returns a base64 data URL of a black image with white strokes where text should be removed.
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

  // Black background = keep pixels
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Scale factors from canvas coords to image pixel coords
  const scaleX = imageNaturalWidth / imageElement.width
  const scaleY = imageNaturalHeight / imageElement.height

  // White strokes = pixels to inpaint
  ctx.strokeStyle = '#ffffff'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const fd of freedrawElements) {
    if (!fd.points || fd.points.length === 0) continue

    // Stroke width: scale from canvas to image, with a minimum of 14px for large text coverage
    const baseWidth = fd.strokeWidth || 2
    const scaledWidth = baseWidth * Math.max(scaleX, scaleY) * 3
    ctx.lineWidth = Math.max(scaledWidth, 14)

    // Offset from image element position to freedraw element position
    const offsetX = fd.x - imageElement.x
    const offsetY = fd.y - imageElement.y

    ctx.beginPath()

    // Points are [x, y] tuples relative to freedraw element position
    const points = fd.points as readonly (readonly [number, number])[]
    const firstPoint = points[0]
    const startX = (offsetX + firstPoint[0]) * scaleX
    const startY = (offsetY + firstPoint[1]) * scaleY
    ctx.moveTo(startX, startY)

    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i]
      const x = (offsetX + px) * scaleX
      const y = (offsetY + py) * scaleY
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  return canvas.toDataURL('image/png')
}

const CanvasInpaintButton = ({ selectedElements }: CanvasInpaintButtonProps) => {
  const { t } = useTranslation()
  const { excalidrawAPI, canvasId } = useCanvas()
  const [loading, setLoading] = useState(false)

  const handleInpaint = async () => {
    if (!excalidrawAPI) return

    // Image and freedraw are both in selectedElements (user explicitly selected them)
    let imageElement = selectedElements.find(
      (el) => el.type === 'image'
    ) as ExcalidrawImageElement | undefined

    // Get freedraw from scene (handles index: null for newly created elements)
    const allElements = excalidrawAPI.getSceneElements()
    const selectedIds = excalidrawAPI.getAppState().selectedElementIds
    const freedrawElements = allElements.filter(
      (el) => el.type === 'freedraw' && selectedIds[el.id]
    ) as ExcalidrawFreeDrawElement[]

    // Fallback: try selectedElements if scene query returned nothing
    if (freedrawElements.length === 0) {
      const fromSelected = selectedElements.filter(
        (el) => el.type === 'freedraw'
      ) as ExcalidrawFreeDrawElement[]
      freedrawElements.push(...fromSelected)
    }

    if (!imageElement || !imageElement.fileId) {
      toast.error(t('canvas:popbar.inpaintNoImage'))
      return
    }
    if (freedrawElements.length === 0) {
      toast.error(t('canvas:popbar.inpaintNoMask'))
      return
    }

    setLoading(true)
    try {
      const files = excalidrawAPI.getFiles() as BinaryFiles
      const imageFile = files[imageElement.fileId]
      if (!imageFile?.dataURL) {
        toast.error(t('canvas:popbar.inpaintNoImageData'))
        return
      }

      // Load the original image to get its natural resolution
      const img = await loadImageFromDataUrl(imageFile.dataURL)
      const naturalW = img.naturalWidth
      const naturalH = img.naturalHeight

      // Generate the mask from freedraw strokes
      const maskBase64 = createMaskFromFreedraw(
        imageElement,
        freedrawElements,
        naturalW,
        naturalH
      )

      // Call the server inpainting API
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

      // Generate new file ID for the inpainted image
      const newFileId = 'im_inpaint_' + Date.now()

      // Add the inpainted image as a new file
      excalidrawAPI.addFiles([
        {
          id: newFileId,
          mimeType: 'image/png',
          dataURL: inpaintedB64,
          created: Date.now(),
        },
      ])

      // Get current elements and update the image element to use the new file
      const currentElements = excalidrawAPI.getSceneElements()
      const freedrawIds = new Set(freedrawElements.map((el) => el.id))

      const updatedElements = currentElements
        .filter((el) => !freedrawIds.has(el.id)) // Remove freedraw strokes
        .map((el) => {
          if (el.id === imageElement.id && el.type === 'image') {
            return {
              ...el,
              fileId: newFileId,
              width: naturalW,
              height: naturalH,
            }
          }
          return el
        })

      // Save current view position before updating scene
      const currentAppState = excalidrawAPI.getAppState()

      excalidrawAPI.updateScene({ elements: updatedElements })

      // Clear selection while preserving scroll/zoom
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
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleInpaint}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="size-3.5 mr-1 animate-spin" />
      ) : (
        <Eraser className="size-3.5 mr-1" />
      )}
      {t('canvas:popbar.inpaint')}
    </Button>
  )
}

export default memo(CanvasInpaintButton)
