import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useCanvas } from '@/contexts/canvas'
import { cn } from '@/lib/utils'
import type { ExcalidrawImageElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { getImagesRecursiveApi } from '@/api/settings'
import { FolderOpen, Images, Loader2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

const GRID_COLS = 3
const GRID_GAP = 40
const MAX_DISPLAY_WIDTH = 400

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`))
    reader.readAsDataURL(file)
  })
}

function getImageDimensions(
  file: File
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(`Failed to load image: ${file.name}`))
    }
    img.src = objectUrl
  })
}

/**
 * Fetch an image file from the backend by its absolute path and wrap it in a
 * File object so it can be consumed by the existing import pipeline.
 */
async function pathToFile(filePath: string): Promise<File> {
  const response = await fetch(
    `/api/serve_file?file_path=${encodeURIComponent(filePath)}`
  )
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${filePath}`)
  }
  const blob = await response.blob()
  const name = filePath.split(/[\\/]/).pop() || 'image.png'
  return new File([blob], name, { type: blob.type || 'image/png' })
}

const CanvasBatchImageButton = () => {
  const { excalidrawAPI } = useCanvas()
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        toast.error(t('canvas:tool.batchImportNoImages'))
        return
      }
      if (!excalidrawAPI) return

      setLoading(true)

      try {
        const appState = excalidrawAPI.getAppState()
        const currentElements = [...excalidrawAPI.getSceneElements()]

        const zoom = appState.zoom.value
        const canvasWidth = window.innerWidth * 0.75
        const centerX = -appState.scrollX + canvasWidth / 2 / zoom
        const centerY = -appState.scrollY + window.innerHeight / 2 / zoom

        const filesToAdd: BinaryFileData[] = []
        const newElements: any[] = [...currentElements]
        let successCount = 0
        let failCount = 0

        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          try {
            const dataURL = await fileToBase64(file)
            const dims = await getImageDimensions(file)

            // Display size capping
            let displayW = dims.width
            let displayH = dims.height
            if (displayW > MAX_DISPLAY_WIDTH) {
              const scale = MAX_DISPLAY_WIDTH / displayW
              displayW = MAX_DISPLAY_WIDTH
              displayH = Math.round(dims.height * scale)
            }

            const col = i % GRID_COLS
            const row = Math.floor(i / GRID_COLS)
            const x = centerX + col * (MAX_DISPLAY_WIDTH + GRID_GAP)
            const y = centerY + row * (displayH + GRID_GAP)

            const elementId = nanoid()
            const fileId = nanoid()

            const fileData = {
              id: fileId,
              mimeType: file.type || 'image/png',
              dataURL,
              created: Date.now(),
            } as BinaryFileData

            const imageElement = {
              type: 'image' as const,
              id: elementId,
              x,
              y,
              width: displayW,
              height: displayH,
              angle: 0,
              fileId,
              strokeColor: '#000000',
              backgroundColor: 'transparent',
              fillStyle: 'solid' as const,
              strokeWidth: 1,
              strokeStyle: 'solid' as const,
              roundness: null,
              roughness: 0,
              opacity: 100,
              seed: Math.floor(Math.random() * 2 ** 31),
              version: 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              index: null,
              isDeleted: false,
              groupIds: [] as readonly string[],
              frameId: null,
              boundElements: null,
              updated: Date.now(),
              link: null,
              locked: false,
              status: 'saved' as const,
              scale: [1, 1] as [number, number],
              crop: null,
              customData: { fileName: file.name },
            } as unknown as ExcalidrawImageElement

            filesToAdd.push(fileData)
            newElements.push(imageElement)
            successCount++
          } catch (err) {
            console.error('Failed to process image:', file.name, err)
            failCount++
          }
        }

        if (filesToAdd.length > 0) {
          excalidrawAPI.addFiles(filesToAdd)
          excalidrawAPI.updateScene({ elements: newElements })
        }

        if (failCount === 0 && successCount > 0) {
          toast.success(
            t('canvas:tool.batchImportSuccess', { count: successCount })
          )
        } else if (successCount > 0 && failCount > 0) {
          toast.error(
            t('canvas:tool.batchImportPartial', {
              success: successCount,
              fail: failCount,
            })
          )
        } else if (successCount === 0) {
          toast.error(t('canvas:tool.batchImportFailed'))
        }
      } catch (error) {
        console.error('Batch import error:', error)
        toast.error(t('canvas:tool.batchImportFailed'))
      } finally {
        setLoading(false)
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [excalidrawAPI, t]
  )

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      await importFiles(Array.from(files))
    },
    [importFiles]
  )

  const handleImportDirectories = useCallback(async () => {
    try {
      const pickDirectories = window.electronAPI?.pickDirectories
      if (!pickDirectories) {
        toast.error(t('canvas:tool.batchImportUnsupported'))
        return
      }

      // Let the user select multiple folders in a single picker dialog
      const dirs = await pickDirectories()
      if (!dirs || dirs.length === 0) return

      setLoading(true)

      // Recursively collect image paths from every selected folder
      const pathLists = await Promise.all(
        dirs.map((dir) => getImagesRecursiveApi(dir))
      )
      const allPaths: string[] = pathLists.flat()

      if (allPaths.length === 0) {
        toast.error(t('canvas:tool.batchImportNoImages'))
        return
      }

      // Convert each path into a File object
      const files: File[] = []
      for (const filePath of allPaths) {
        try {
          files.push(await pathToFile(filePath))
        } catch (err) {
          console.error('Failed to fetch image from path:', filePath, err)
        }
      }

      await importFiles(files)
    } catch (err) {
      console.error('Failed to import directories:', err)
      toast.error(t('canvas:tool.batchImportFailed'))
    } finally {
      setLoading(false)
    }
  }, [importFiles, t])

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileChange}
        hidden
      />
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'p-2 rounded-md cursor-pointer hover:bg-primary/5'
                )}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Images className="size-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('canvas:tool.batchImport')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="center">
          <DropdownMenuItem onClick={handleImportDirectories}>
            <FolderOpen className="size-4" />
            {t('canvas:tool.batchImportFolders')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => inputRef.current?.click()}>
            <Images className="size-4" />
            {t('canvas:tool.batchImportFiles')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export default CanvasBatchImageButton
