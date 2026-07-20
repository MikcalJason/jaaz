import { useCanvas } from '@/contexts/canvas'
import { TCanvasAddImagesToChatEvent } from '@/lib/event'
import {
  ExcalidrawImageElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import { AnimatePresence } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import CanvasPopbarContainer from './CanvasPopbarContainer'

const CanvasPopbarWrapper = () => {
  const { excalidrawAPI } = useCanvas()

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [showAddToChat, setShowAddToChat] = useState(false)
  const [showMagicGenerate, setShowMagicGenerate] = useState(false)
  const [showInpaint, setShowInpaint] = useState(false)

  const selectedImagesRef = useRef<TCanvasAddImagesToChatEvent>([])
  const selectedElementsRef = useRef<OrderedExcalidrawElement[]>([])

  useEffect(() => {
    if (!excalidrawAPI) return

    const cleanup = excalidrawAPI.onChange((elements, appState, files) => {
      const selectedIds = appState.selectedElementIds

      if (Object.keys(selectedIds).length === 0) {
        setPos(null)
        setShowAddToChat(false)
        setShowMagicGenerate(false)
        setShowInpaint(false)
        return
      }

      const selectedImages = elements.filter(
        (element) => element.type === 'image' && selectedIds[element.id]
      ) as ExcalidrawImageElement[]

      const selectedFreedraw = elements.filter(
        (element) => element.type === 'freedraw' && selectedIds[element.id]
      )

      // Inpaint: requires user to explicitly select 1 image + at least 1 freedraw
      const showInpaintBtn = selectedImages.length === 1 && selectedFreedraw.length >= 1

      setShowInpaint(showInpaintBtn)

      const hasSelectedImages = selectedImages.length > 0
      setShowAddToChat(hasSelectedImages && !showInpaintBtn)

      const selectedCount = Object.keys(selectedIds).length
      setShowMagicGenerate(selectedCount >= 2 && !showInpaintBtn)

      if (!showInpaintBtn && !hasSelectedImages && selectedCount < 2) {
        setPos(null)
        return
      }

      // Populate refs
      selectedImagesRef.current = selectedImages
        .filter((image) => image.fileId)
        .map((image) => {
          const file = files[image.fileId!]
          const isBase64 = file.dataURL.startsWith('data:')
          const id = isBase64 ? file.id : file.dataURL.split('/').at(-1)!
          return {
            fileId: id,
            base64: isBase64 ? file.dataURL : undefined,
            width: image.width,
            height: image.height,
          }
        })

      selectedElementsRef.current = elements.filter(
        (element) => selectedIds[element.id] && element.index !== null
      ) as OrderedExcalidrawElement[]

      // Position: for inpaint, button follows the freedraw; otherwise below image
      const scrollX = appState.scrollX
      const scrollY = appState.scrollY
      const zoom = appState.zoom.value

      if (showInpaintBtn && selectedFreedraw.length > 0) {
        // Center above the first freedraw element
        const fd = selectedFreedraw[0]
        const offsetX = (scrollX + fd.x + fd.width / 2) * zoom
        const offsetY = (scrollY + fd.y) * zoom - 36
        setPos({ x: offsetX, y: offsetY })
      } else if (hasSelectedImages) {
        const targetImg = selectedImages[0]
        const centerX = targetImg.x + targetImg.width / 2
        const bottomY = targetImg.y + targetImg.height
        const offsetX = (scrollX + centerX) * zoom
        const offsetY = (scrollY + bottomY) * zoom
        setPos({ x: offsetX, y: offsetY })
      } else {
        const selElements = elements.filter((el) => selectedIds[el.id])
        const centerX =
          selElements.reduce((acc, el) => acc + el.x + (el.width || 0) / 2, 0) /
          selElements.length
        const bottomY = selElements.reduce(
          (acc, el) => Math.max(acc, el.y + (el.height || 0)),
          Number.NEGATIVE_INFINITY
        )
        const offsetX = (scrollX + centerX) * zoom
        const offsetY = (scrollY + bottomY) * zoom
        setPos({ x: offsetX, y: offsetY })
      }
    })

    return () => {
      if (typeof cleanup === 'function') cleanup()
    }
  }, [excalidrawAPI])

  return (
    <div className='absolute left-0 bottom-0 w-full h-full z-20 pointer-events-none'>
      <AnimatePresence>
        {pos && (showAddToChat || showMagicGenerate || showInpaint) && (
          <CanvasPopbarContainer
            pos={pos}
            selectedImages={selectedImagesRef.current}
            selectedElements={selectedElementsRef.current}
            showAddToChat={showAddToChat}
            showMagicGenerate={showMagicGenerate}
            showInpaint={showInpaint}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

export default CanvasPopbarWrapper
