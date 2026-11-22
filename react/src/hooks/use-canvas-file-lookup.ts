import { useCanvas } from '@/contexts/canvas'
import { useCallback, useMemo } from 'react'

/**
 * Resolve a rendered media src back to its Excalidraw fileId.
 *
 * Building a Map once and doing an exact lookup avoids the previous
 * `files.find(file => src.includes(file.dataURL))` pattern, which scanned
 * every base64 data URL on every render of every chat image.
 */
export const useCanvasFileIdLookup = () => {
  const { excalidrawAPI } = useCanvas()
  const files = excalidrawAPI?.getFiles()

  const fileIdByDataUrl = useMemo(() => {
    const map = new Map<string, string>()
    if (files) {
      for (const key of Object.keys(files)) {
        const url = files[key]?.dataURL
        if (url) map.set(url, key)
      }
    }
    return map
  }, [files])

  return useCallback(
    (src?: string): string | undefined => {
      if (!src) return undefined

      const exact = fileIdByDataUrl.get(src)
      if (exact) return exact

      // Fallback for src that embeds a data URL (e.g. wrapped by renderers).
      // Plain short URLs take the cheap path and never scan the map.
      if (src.length > 256) {
        for (const [url, id] of fileIdByDataUrl) {
          if (src.includes(url)) return id
        }
      }
      return undefined
    },
    [fileIdByDataUrl]
  )
}
