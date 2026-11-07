import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Image,
  Play,
  File,
  Grid,
  List,
  RefreshCw,
  FileText,
  Music,
  Archive,
  Code,
  Eye,
  Star,
  Heart,
  MoreHorizontal,
  ExternalLink,
  X,
} from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  browseFolderApi,
  getFileServiceUrl,
  getFileThumbnailUrl,
  getFileInfoApi,
  openFolderInExplorer,
  getMyAssetsDirPath,
} from '@/api/settings'
import { readPNGMetadata } from '@/utils/pngMetadata'
import { useInViewOnce } from '@/hooks/use-in-view'
import FilePreviewModal from './FilePreviewModal'
import { Button } from '../ui/button'
import { eventBus } from '@/lib/event'
import { useTranslation } from 'react-i18next'

interface FileSystemItem {
  name: string
  path: string
  type: string
  size?: number
  mtime: number
  is_directory: boolean
  is_media: boolean
  has_thumbnail: boolean
}

interface BrowseResult {
  current_path: string
  parent_path: string | null
  items: FileSystemItem[]
}

interface FileDetails extends FileSystemItem {
  dimensions?: {
    width: number
    height: number
  }
  pngMetadata?: {
    success: boolean
    metadata: Record<string, any>
    has_metadata: boolean
    error?: string
  }
}

// 网格/列表首次渲染数量，滚动到底部再增量加载，避免一次挂载上千个 DOM 节点
const PAGE_SIZE = 120
// 左侧文件树每层首次渲染的节点数
const TREE_PAGE_SIZE = 60

const MODEL_KEYS = [
  'model',
  'Model',
  'checkpoint',
  'Checkpoint',
  'model_name',
  'Model Name',
  'sd_model_name',
  'Model used',
  'model_used',
]

const PARAM_KEYS = ['parameters', 'Parameters', 'params', 'generation_params']

// Intl 格式化器创建成本较高，模块级复用
const dateTimeFormatter = new Intl.DateTimeFormat()

function formatFileSize(bytes: number) {
  if (!bytes) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatDate(timestamp: number) {
  if (!timestamp) return ''
  return dateTimeFormatter.format(new Date(timestamp * 1000))
}

function getFileIcon(type: string, className: string = 'w-4 h-4') {
  switch (type) {
    case 'folder':
      return <Folder className={className} />
    case 'image':
      return <Image className={`${className} text-blue-500`} />
    case 'video':
      return <Play className={`${className} text-red-500`} />
    case 'audio':
      return <Music className={`${className} text-green-500`} />
    case 'document':
      return <FileText className={`${className} text-orange-500`} />
    case 'archive':
      return <Archive className={`${className} text-purple-500`} />
    case 'code':
      return <Code className={`${className} text-yellow-500`} />
    default:
      return <File className={className} />
  }
}

function mediaFromItems(items: FileSystemItem[]): FileSystemItem[] {
  return items
    .filter(
      (item) =>
        !item.is_directory && (item.type === 'image' || item.type === 'video')
    )
    .sort((a, b) => b.mtime - a.mtime)
}

function extractModelName(metadata: Record<string, unknown>): string | null {
  let extracted: unknown = null

  for (const key of MODEL_KEYS) {
    if (metadata[key]) {
      extracted = metadata[key]
      break
    }
  }

  // 如果没有找到标准的模型字段，尝试从参数字符串中推断
  if (!extracted) {
    for (const key of PARAM_KEYS) {
      const value = metadata[key]
      if (typeof value === 'string') {
        const match = value.match(/(?:model|Model):\s*([^,\n]+)/)
        if (match) {
          extracted = match[1].trim()
          break
        }
      }
    }
  }

  if (!extracted) return null

  let clean = String(extracted)
  if (clean.includes('/')) clean = clean.split('/').pop() || clean
  if (clean.includes('\\')) clean = clean.split('\\').pop() || clean
  clean = clean.replace(/\.(ckpt|safetensors|pt|pth)$/i, '')
  return clean || null
}

/**
 * 图片模型徽标：只有卡片进入视口后才读取 PNG metadata，
 * 避免打开目录时同时发起上百个文件读取请求。
 */
const ImageModelBadge = memo(function ImageModelBadge({
  filePath,
  fileName,
  variant = 'grid',
}: {
  filePath: string
  fileName: string
  variant?: 'grid' | 'list'
}) {
  const { ref, inView } = useInViewOnce<HTMLDivElement>()
  const [modelInfo, setModelInfo] = useState<string | null>(null)
  const isPng = fileName.toLowerCase().endsWith('.png')

  useEffect(() => {
    if (!inView || !isPng) return

    let cancelled = false
    readPNGMetadata(getFileServiceUrl(filePath)).then((result) => {
      if (cancelled) return
      if (result.success && result.has_metadata) {
        const modelName = extractModelName(result.metadata)
        if (modelName) setModelInfo(modelName)
      }
    })

    return () => {
      cancelled = true
    }
  }, [inView, isPng, filePath])

  if (!isPng) return null

  const position =
    variant === 'grid'
      ? 'absolute top-2 left-2 z-10'
      : 'absolute -top-1 -right-1 z-10'

  if (!modelInfo) {
    // 空占位也保留 1px 面积，保证 IntersectionObserver 能触发
    return <div ref={ref} className={`${position} w-px h-px`} />
  }

  return (
    <div
      ref={ref}
      className={`${position} ${
        variant === 'grid'
          ? 'bg-blue-600/90 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-full max-w-[calc(100%-1rem)] truncate shadow-lg'
          : 'bg-blue-600/90 backdrop-blur-sm text-white text-[10px] px-1.5 py-0.5 rounded-full max-w-16 truncate shadow-lg'
      }`}
    >
      <span title={modelInfo}>{modelInfo}</span>
    </div>
  )
})

interface MediaItemProps {
  file: FileSystemItem
  selected: boolean
  onOpen: (file: FileSystemItem) => void
  onPreview: (file: FileSystemItem) => void
  onAddToChat?: (file: FileSystemItem, event?: React.MouseEvent) => void
}

const MediaCard = memo(function MediaCard({
  file,
  selected,
  onOpen,
}: MediaItemProps) {
  const [failed, setFailed] = useState(false)
  const thumbnailUrl = useMemo(
    () => getFileThumbnailUrl(file.path, 400, file.mtime),
    [file.path, file.mtime]
  )


  return (
    <div
      className={`group relative bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden border cursor-pointer ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-200 dark:ring-blue-800'
          : 'border-gray-200 dark:border-gray-700'
      }`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(file)
      }}
    >
      <div className="aspect-square bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 flex items-center justify-center overflow-hidden relative">
        {file.type === 'image' && (
          <ImageModelBadge
            filePath={file.path}
            fileName={file.name}
            variant="grid"
          />
        )}

        {file.type === 'image' && !failed ? (
          <img
            src={thumbnailUrl}
            alt={file.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-gray-400">
            {getFileIcon(file.type, 'w-8 h-8')}
            <span className="text-xs mt-1">{file.type.toUpperCase()}</span>
          </div>
        )}
      </div>

      <div className="p-3">
        <div className="text-sm font-medium truncate" title={file.name}>
          {file.name}
        </div>
        <div className="flex justify-between items-center mt-2 text-xs text-gray-500">
          <span>{formatFileSize(file.size || 0)}</span>
          <span>{formatDate(file.mtime)}</span>
        </div>
      </div>
    </div>
  )
})

const MediaRow = memo(function MediaRow({
  file,
  selected,
  onOpen,
  onPreview,
  onAddToChat,
}: MediaItemProps) {
  const [failed, setFailed] = useState(false)
  const thumbnailUrl = useMemo(
    () => getFileThumbnailUrl(file.path, 128, file.mtime),
    [file.path, file.mtime]
  )
  return (
    <div
      className={`flex items-center gap-4 p-3 bg-white dark:bg-gray-800 rounded-lg border hover:shadow-md transition-shadow min-w-0 cursor-pointer ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-200 dark:ring-blue-800'
          : 'border-gray-200 dark:border-gray-700'
      }`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(file)
      }}
    >
      <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center overflow-hidden flex-shrink-0 relative">
        {file.type === 'image' && (
          <ImageModelBadge
            filePath={file.path}
            fileName={file.name}
            variant="list"
          />
        )}

        {file.type === 'image' && !failed ? (
          <img
            src={thumbnailUrl}
            alt={file.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="w-full h-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          getFileIcon(file.type)
        )}
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="font-medium truncate">{file.name}</div>
        <div className="text-sm text-gray-500 flex items-center gap-4 overflow-hidden">
          <span className="whitespace-nowrap">
            {formatFileSize(file.size || 0)}
          </span>
          <span className="whitespace-nowrap">{formatDate(file.mtime)}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onPreview(file)
          }}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="预览"
        >
          <Eye className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onAddToChat?.(file)
          }}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="添加到聊天"
        >
          <Heart className="w-4 h-4" />
        </button>
        <button className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
})

export default function MaterialManager() {
  const [currentPath, setCurrentPath] = useState<string>('')
  const [items, setItems] = useState<FileSystemItem[]>([])
  const [mediaFiles, setMediaFiles] = useState<FileSystemItem[]>([])
  const [selectedFolder, setSelectedFolder] = useState<FileSystemItem | null>(
    null
  )
  const [selectedFile, setSelectedFile] = useState<FileDetails | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [searchTerm, setSearchTerm] = useState('')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [folderContents, setFolderContents] = useState<
    Map<string, FileSystemItem[]>
  >(new Map())
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  // 每个目录已展开显示的条目数，key 为父目录路径
  const [treeLimits, setTreeLimits] = useState<Record<string, number>>({})
  const [previewModal, setPreviewModal] = useState<{
    isOpen: boolean
    filePath: string
    fileName: string
    fileType: string
  }>({
    isOpen: false,
    filePath: '',
    fileName: '',
    fileType: '',
  })

  const myAssetsPath = useRef<string>('')
  const folderContentsRef = useRef<Map<string, FileSystemItem[]>>(new Map())
  const selectedFolderRef = useRef<FileSystemItem | null>(null)
  const requestSeq = useRef(0)
  const initialized = useRef(false)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const { t } = useTranslation()

  const setFolderItems = useCallback(
    (path: string, children: FileSystemItem[]) => {
      folderContentsRef.current.set(path, children)
      setFolderContents(new Map(folderContentsRef.current))
    },
    []
  )

  // 载入树根目录（家目录）
  const loadRoot = useCallback(
    async (path: string = '') => {
      setTreeLoading(true)
      setError(null)

      try {
        const result: BrowseResult = await browseFolderApi(path)
        setCurrentPath(result.current_path)
        setItems(result.items)
        setFolderItems(result.current_path, result.items)
      } catch (err) {
        setError('Failed to load folder')
        console.error('Error loading folder:', err)
      } finally {
        setTreeLoading(false)
      }
    },
    [setFolderItems]
  )

  /**
   * 打开目录：只发一次目录列表请求。
   * 之前这里先请求 browse_filesystem 再请求 get_media_files，
   * 同一个目录被完整扫描两遍，大目录下会明显卡顿。
   */
  const openFolder = useCallback(
    async (
      folder: FileSystemItem,
      options?: { toggle?: boolean; refresh?: boolean }
    ) => {
      selectedFolderRef.current = folder
      setSelectedFolder(folder)
      setSelectedFile(null)
      setVisibleCount(PAGE_SIZE)

      if (options?.toggle) {
        setExpandedFolders((prev) => {
          const next = new Set(prev)
          if (next.has(folder.path)) next.delete(folder.path)
          else next.add(folder.path)
          return next
        })
      }

      const cached = options?.refresh
        ? undefined
        : folderContentsRef.current.get(folder.path)

      if (cached) {
        setMediaFiles(mediaFromItems(cached))
        setMediaLoading(false)
        return
      }

      const seq = ++requestSeq.current
      setMediaLoading(true)
      setMediaFiles([])

      try {
        const result: BrowseResult = await browseFolderApi(folder.path)
        if (seq !== requestSeq.current) return
        setFolderItems(result.current_path, result.items)
        setMediaFiles(mediaFromItems(result.items))
      } catch (err) {
        if (seq === requestSeq.current) {
          console.error('Failed to load media files:', err)
          setMediaFiles([])
        }
      } finally {
        if (seq === requestSeq.current) setMediaLoading(false)
      }
    },
    [setFolderItems]
  )

  const handleFolderClick = useCallback(
    (folder: FileSystemItem) => {
      if (!folder.is_directory) return
      void openFolder(folder, { toggle: true })
    },
    [openFolder]
  )

  const handleMyAssets = useCallback(async () => {
    try {
      if (!myAssetsPath.current) {
        const result = await getMyAssetsDirPath()
        if (!result.success) {
          console.error('Failed to get My Assets directory path:', result.error)
          return
        }
        myAssetsPath.current = result.path
      }

      await openFolder(
        {
          name: t('canvas:myAssets', 'My Assets'),
          path: myAssetsPath.current,
          type: 'folder',
          mtime: Date.now() / 1000,
          is_directory: true,
          is_media: false,
          has_thumbnail: false,
        },
        { refresh: true }
      )
    } catch (error) {
      console.error('Failed to load My Assets folder:', error)
    }
  }, [openFolder, t])

  const handleRefresh = useCallback(() => {
    const folder = selectedFolderRef.current
    if (folder?.is_directory) {
      void openFolder(folder, { refresh: true })
      return
    }
    void loadRoot(currentPath)
  }, [openFolder, loadRoot, currentPath])

  // 首次进入：并行加载树根目录与 My Assets
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void loadRoot('')
    void handleMyAssets()
  }, [loadRoot, handleMyAssets])

  const handlePreviewFile = useCallback((file: FileSystemItem) => {
    if (file.is_media) {
      setPreviewModal({
        isOpen: true,
        filePath: file.path,
        fileName: file.name,
        fileType: file.type,
      })
    }
  }, [])

  const closePreviewModal = useCallback(() => {
    setPreviewModal({
      isOpen: false,
      filePath: '',
      fileName: '',
      fileType: '',
    })
  }, [])

  const handleFileClick = useCallback(async (file: FileSystemItem) => {
    setSelectedFile({ ...file })

    if (file.type !== 'image') return

    // 宽高由后端读图片头（毫秒级），不用再把整张原图下载到浏览器解析
    try {
      const info = await getFileInfoApi(file.path)
      if (info?.dimensions) {
        setSelectedFile((prev) =>
          prev && prev.path === file.path
            ? { ...prev, dimensions: info.dimensions }
            : prev
        )
      }
    } catch (err) {
      console.error('Failed to get image info:', err)
    }

    if (!file.path.toLowerCase().endsWith('.png')) return

    try {
      const pngMetadata = await readPNGMetadata(getFileServiceUrl(file.path))
      setSelectedFile((prev) =>
        prev && prev.path === file.path ? { ...prev, pngMetadata } : prev
      )
    } catch (err) {
      console.error('Failed to get PNG metadata:', err)
    }
  }, [])

  const handleAddToChat = useCallback(
    (file: FileSystemItem, event?: React.MouseEvent) => {
      if (event) event.stopPropagation()
      eventBus.emit('Material::AddImagesToChat', [
        {
          filePath: file.path,
          fileName: file.name,
          fileType: file.type,
          width: undefined,
          height: undefined,
        },
      ])
    },
    []
  )

  const handleOpenInExplorer = useCallback(async () => {
    if (selectedFolder) {
      try {
        await openFolderInExplorer(selectedFolder.path)
      } catch (error) {
        console.error('Failed to open folder in explorer:', error)
      }
    }
  }, [selectedFolder])

  const filteredItems = useMemo(() => {
    const term = searchTerm.toLowerCase()
    if (!term) return items
    return items.filter((item) => item.name.toLowerCase().includes(term))
  }, [items, searchTerm])

  const filteredMediaFiles = useMemo(() => {
    const term = searchTerm.toLowerCase()
    if (!term) return mediaFiles
    return mediaFiles.filter((file) => file.name.toLowerCase().includes(term))
  }, [mediaFiles, searchTerm])

  const visibleMediaFiles = useMemo(
    () => filteredMediaFiles.slice(0, visibleCount),
    [filteredMediaFiles, visibleCount]
  )

  // 滚动到底部时增量渲染，避免一次性挂载上千张图片
  useEffect(() => {
    if (visibleCount >= filteredMediaFiles.length) return
    const target = loadMoreRef.current
    if (!target || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((prev) => prev + PAGE_SIZE)
        }
      },
      { rootMargin: '600px 0px' }
    )

    observer.observe(target)
    return () => observer.disconnect()
  }, [visibleCount, filteredMediaFiles.length])

  // 递归搜索所有文件夹内容
  const searchInFolderContents = useCallback(
    (contents: FileSystemItem[], term: string): FileSystemItem[] => {
      if (!term) return contents

      return contents.filter((item) => {
        if (item.name.toLowerCase().includes(term.toLowerCase())) return true

        // 如果是文件夹且已展开，搜索子内容
        if (item.is_directory && expandedFolders.has(item.path)) {
          const childItems = folderContents.get(item.path) || []
          return searchInFolderContents(childItems, term).length > 0
        }

        return false
      })
    },
    [expandedFolders, folderContents]
  )

  const getFilteredFolderContents = useCallback(
    (path: string): FileSystemItem[] => {
      const contents = folderContents.get(path) || []
      return searchTerm
        ? searchInFolderContents(contents, searchTerm)
        : contents
    },
    [folderContents, searchTerm, searchInFolderContents]
  )

  const renderFileTree = useCallback(
    (
      treeItems: FileSystemItem[],
      depth = 0,
      parentKey = 'root'
    ): ReactNode => {
      // 每层节点分批渲染：家目录里有几千个条目时，不必一次挂载
      const limit = treeLimits[parentKey] ?? TREE_PAGE_SIZE
      const shownItems =
        treeItems.length > limit ? treeItems.slice(0, limit) : treeItems
      const hiddenCount = treeItems.length - shownItems.length

      return (
        <>
          {shownItems.map((item) => {
            const isExpanded =
              item.is_directory && expandedFolders.has(item.path)
            // 只计算一次，避免同一节点重复过滤
            const childItems = isExpanded
              ? getFilteredFolderContents(item.path)
              : []

            return (
              <div key={item.path} className="select-none">
                <div
                  className={`flex items-center gap-2 px-3 py-1 rounded-lg cursor-pointer transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-800 ${
                    selectedFolder?.path === item.path && item.is_directory
                      ? 'bg-blue-50 dark:bg-blue-950 border-l-4 border-blue-500'
                      : item.is_media && !item.is_directory
                        ? 'hover:bg-green-50 dark:hover:bg-green-950'
                        : ''
                  }`}
                  style={{ paddingLeft: `${12 + depth * 16}px` }}
                  onClick={() =>
                    item.is_directory
                      ? handleFolderClick(item)
                      : handlePreviewFile(item)
                  }
                >
                  {item.is_directory && (
                    <button className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors">
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>
                  )}

                  {!item.is_directory && (
                    <div className="w-5 h-5 flex items-center justify-center">
                      <div className="w-3 h-3"></div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {item.is_directory ? (
                      isExpanded ? (
                        <FolderOpen className="w-4 h-4 text-blue-600 flex-shrink-0" />
                      ) : (
                        <Folder className="w-4 h-4 text-gray-600 flex-shrink-0" />
                      )
                    ) : (
                      getFileIcon(item.type)
                    )}
                    <span
                      className="text-sm font-medium truncate"
                      title={item.name}
                    >
                      {item.name}
                    </span>
                  </div>

                  {/* 文件大小显示 */}
                  {!item.is_directory && item.size && (
                    <span className="text-xs text-gray-400 ml-2">
                      {formatFileSize(item.size)}
                    </span>
                  )}
                </div>

                {/* 递归渲染子文件夹和文件 */}
                {isExpanded && childItems.length > 0 && (
                  <div className="ml-2">
                    {renderFileTree(childItems, depth + 1, item.path)}
                  </div>
                )}
              </div>
            )
          })}

          {hiddenCount > 0 && (
            <button
              onClick={() =>
                setTreeLimits((prev) => ({
                  ...prev,
                  [parentKey]:
                    (prev[parentKey] ?? TREE_PAGE_SIZE) + TREE_PAGE_SIZE,
                }))
              }
              className="w-full text-left text-xs text-blue-600 hover:underline py-1"
              style={{ paddingLeft: `${12 + depth * 16}px` }}
            >
              {`加载更多（剩余 ${hiddenCount}）`}
            </button>
          )}
        </>
      )
    },
    [
      selectedFolder,
      expandedFolders,
      handleFolderClick,
      handlePreviewFile,
      getFilteredFolderContents,
      treeLimits,
    ]
  )

  const renderMediaGrid = useCallback(
    () => (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {visibleMediaFiles.map((file) => (
          <MediaCard
            key={file.path}
            file={file}
            selected={selectedFile?.path === file.path}
            onOpen={handleFileClick}
            onPreview={handlePreviewFile}
          />
        ))}
      </div>
    ),
    [
      visibleMediaFiles,
      selectedFile?.path,
      handleFileClick,
      handlePreviewFile,
    ]
  )

  const renderMediaList = useCallback(
    () => (
      <div className="space-y-2 w-full overflow-hidden">
        {visibleMediaFiles.map((file) => (
          <MediaRow
            key={file.path}
            file={file}
            selected={selectedFile?.path === file.path}
            onOpen={handleFileClick}
            onPreview={handlePreviewFile}
            onAddToChat={handleAddToChat}
          />
        ))}
      </div>
    ),
    [
      visibleMediaFiles,
      selectedFile?.path,
      handleFileClick,
      handlePreviewFile,
      handleAddToChat,
    ]
  )

  const renderFileDetailsPanel = useCallback(() => {
    if (!selectedFile) return null

    return (
      <div className="absolute bottom-0 left-0 right-0 mt-6 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="absolute top-0 right-0 flex items-center justify-between mb-4">
          <button
            onClick={() => setSelectedFile(null)}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 文件预览：用 1024 缩略图代替原图，避免解码几十 MB 的大图 */}
          <div className="space-y-4">
            <div className="aspect-video bg-gray-100 dark:bg-gray-700 rounded-lg overflow-hidden flex items-center justify-center">
              {selectedFile.type === 'image' ? (
                <img
                  src={getFileThumbnailUrl(
                    selectedFile.path,
                    1024,
                    selectedFile.mtime
                  )}
                  alt={selectedFile.name}
                  decoding="async"
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-gray-400">
                  {getFileIcon(selectedFile.type, 'w-12 h-12')}
                  <span className="text-sm mt-2">
                    {selectedFile.type.toUpperCase()}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              {/* <Button
                onClick={(e) => handleAddToChat(selectedFile, e)}
                variant="default"
                size="sm"
                className="flex-1"
              >
                <MessageCirclePlus className="w-4 h-4 mr-2" />
                添加到聊天
              </Button> */}
            </div>
          </div>

          {/* 文件信息 */}
          <div className="space-y-4">
            <div>
              <h4 className="font-medium mb-2">
                {t('canvas:basicInfo', 'Basic info')}
              </h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">
                    {t('canvas:fileName', 'File name')}
                  </span>
                  <span className="font-medium break-all">
                    {selectedFile.name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">
                    {t('canvas:fileSize', 'File size')}
                  </span>
                  <span className="font-medium">
                    {formatFileSize(selectedFile.size || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-400">
                    {t('canvas:modifiedTime', 'Modified time')}
                  </span>
                  <span className="font-medium">
                    {formatDate(selectedFile.mtime)}
                  </span>
                </div>
                {selectedFile.dimensions && (
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">
                      {t('canvas:dimensions', 'Dimensions')}
                    </span>
                    <span className="font-medium">
                      {selectedFile.dimensions.width} ×{' '}
                      {selectedFile.dimensions.height}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h4 className="font-medium mb-2">
                {t('canvas:filePath', 'File path')}
              </h4>
              <div className="text-sm text-gray-600 dark:text-gray-400 break-all bg-gray-50 dark:bg-gray-700 p-2 rounded">
                {selectedFile.path}
              </div>
            </div>

            {/* PNG Metadata Section */}
            {selectedFile.pngMetadata &&
              selectedFile.pngMetadata.success &&
              selectedFile.pngMetadata.has_metadata && (
                <div>
                  <h4 className="font-medium mb-2">
                    {t('canvas:pngMetadata', 'PNG Metadata')}
                  </h4>
                  <div className="space-y-2 text-sm max-h-64 overflow-y-auto bg-gray-50 dark:bg-gray-700 p-3 rounded">
                    {Object.entries(selectedFile.pngMetadata.metadata)
                      .filter(
                        ([key]) => !['width', 'height', 'mode'].includes(key)
                      ) // 过滤掉基本信息
                      .map(([key, value]) => (
                        <div
                          key={key}
                          className="border-b border-gray-200 dark:border-gray-600 pb-2"
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="text-gray-600 dark:text-gray-400 font-medium min-w-0 flex-shrink-0">
                              {key}:
                            </span>
                            <div className="text-right min-w-0 flex-1">
                              {typeof value === 'object' ? (
                                <pre className="text-xs bg-white dark:bg-gray-800 p-2 rounded border overflow-x-auto">
                                  {JSON.stringify(value, null, 2)}
                                </pre>
                              ) : (
                                <span className="break-all">
                                  {String(value)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>
    )
  }, [selectedFile, t])

  return (
    <div className="flex h-full bg-gray-50 dark:bg-gray-900 w-full overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-80 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col flex-shrink-0">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          {/* My Assets Button */}
          <Button
            variant={
              selectedFolder?.path === myAssetsPath.current ? 'default' : 'ghost'
            }
            onClick={handleMyAssets}
            className="w-full justify-start text-left mb-3"
            style={{ padding: '4px', margin: '0px' }}
          >
            <Star className="w-4 h-4" />
            <span>{t('canvas:myAssets', 'My Assets')}</span>
          </Button>
          {/* Navigation */}
          <div className="flex items-center gap-2 mb-3 px-[4px]">
            <FolderOpen className="w-4 h-4" />
            <div className="flex-1 text-sm text-gray-600 dark:text-gray-400 truncate">
              {selectedFolder?.path || currentPath || '~'}
            </div>
            <button
              onClick={handleRefresh}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <RefreshCw
                className={`w-4 h-4 ${
                  treeLoading || mediaLoading ? 'animate-spin' : ''
                }`}
              />
            </button>
          </div>
        </div>

        {/* File Tree */}
        <div className="flex-1 overflow-y-auto p-2">
          {treeLoading && items.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          )}

          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900 border border-red-200 dark:border-red-800 rounded-lg">
              <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
            </div>
          )}

          {!error && (
            <div className="space-y-1">{renderFileTree(filteredItems)}</div>
          )}
        </div>
      </div>

      {/* Right Panel */}
      <div
        className="flex-1 flex flex-col min-w-0 overflow-hidden relative"
        onClick={() => setSelectedFile(null)}
      >
        {/* Header */}
        <div className="p-6 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
                  {selectedFolder
                    ? selectedFolder.name
                    : t('canvas:selectAFolder', 'Select a folder')}
                </h2>
                {selectedFolder && (
                  <button
                    onClick={handleOpenInExplorer}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    title={t(
                      'canvas:openInExplorer',
                      'Open in system file browser'
                    )}
                  >
                    <ExternalLink className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                  </button>
                )}
              </div>
              {selectedFolder && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {filteredMediaFiles.length}{' '}
                  {t('canvas:mediaFiles', 'media files')}
                  {mediaLoading && (
                    <span className="ml-2 inline-flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      {t('common:loading', 'Loading')}
                    </span>
                  )}
                </p>
              )}
            </div>

            {selectedFolder && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 rounded-lg transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-600'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  <Grid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 rounded-lg transition-colors ${
                    viewMode === 'list'
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-600'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  <List className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 w-full min-w-0">
          {selectedFolder ? (
            <div className="w-full overflow-hidden">
              {mediaLoading && mediaFiles.length === 0 ? (
                <div className="flex items-center justify-center h-64 text-gray-500">
                  <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : filteredMediaFiles.length > 0 ? (
                <div>
                  {viewMode === 'grid' ? renderMediaGrid() : renderMediaList()}

                  {visibleCount < filteredMediaFiles.length && (
                    <div
                      ref={loadMoreRef}
                      className="flex items-center justify-center py-6 text-gray-400"
                    >
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    </div>
                  )}

                  {/* File Details Panel */}
                  {renderFileDetailsPanel()}
                </div>
              ) : (
                <div className="flex items-center justify-center h-64 text-gray-500">
                  <div className="text-center">
                    <Image className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg font-medium">
                      {t('canvas:noMediaFiles', 'No media files')}
                    </p>
                    <p className="text-sm mt-2">
                      {t(
                        'canvas:noMediaFilesDescription',
                        'No images or videos in this folder'
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <Folder className="w-20 h-20 mx-auto mb-6 opacity-30" />
                <p className="text-xl font-medium">
                  {t('canvas:selectAFolder', 'Select a folder')}
                </p>
                <p className="text-sm mt-2">
                  {t(
                    'canvas:selectAFolderDescription',
                    'Select a folder to view its images and videos'
                  )}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* File Preview Modal */}
      <FilePreviewModal
        isOpen={previewModal.isOpen}
        onClose={closePreviewModal}
        filePath={previewModal.filePath}
        fileName={previewModal.fileName}
        fileType={previewModal.fileType}
      />
    </div>
  )
}
