import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTrigger } from '../ui/dialog'

export type ModelItem = {
  name: string
  type: 'text' | 'image' | 'video'
}

interface ModelsListProps {
  models: Record<string, { type?: 'text' | 'image' | 'video' }>
  onChange: (
    models: Record<string, { type?: 'text' | 'image' | 'video' }>
  ) => void
  label?: string
}

export default function AddModelsList({
  models,
  onChange,
  label = 'Models',
}: ModelsListProps) {
  const [modelItems, setModelItems] = useState<ModelItem[]>([])
  const [newModelName, setNewModelName] = useState('')
  const [newModelType, setNewModelType] = useState<ModelItem['type']>('text')
  const [openAddModelDialog, setOpenAddModelDialog] = useState(false)

  useEffect(() => {
    const modelItems = Object.entries(models).map(([name, config]) => ({
      name,
      type: (config.type || 'text') as 'text' | 'image' | 'video',
    }))
    setModelItems(modelItems.length > 0 ? modelItems : [])
  }, [models])

  const notifyChange = useCallback(
    (items: ModelItem[]) => {
      // Filter out empty model names and convert back to object format
      const validModels = items.filter((model) => model.name.trim())
      const modelsConfig: Record<
        string,
        { type?: 'text' | 'image' | 'video' }
      > = {}

      validModels.forEach((model) => {
        modelsConfig[model.name] = { type: model.type }
      })

      onChange(modelsConfig)
    },
    [onChange]
  )

  const handleAddModel = () => {
    if (newModelName) {
      const newItems = [
        ...modelItems,
        { name: newModelName, type: newModelType },
      ]
      setModelItems(newItems)
      notifyChange(newItems)
      setNewModelName('')
      setNewModelType('text')
      setOpenAddModelDialog(false)
    }
  }

  const handleTypeChange = (index: number, type: ModelItem['type']) => {
    const newItems = modelItems.map((model, i) =>
      i === index ? { ...model, type } : model
    )
    setModelItems(newItems)
    notifyChange(newItems)
  }

  const handleRemoveModel = (index: number) => {
    if (modelItems.length > 1) {
      const newItems = modelItems.filter((_, i) => i !== index)
      setModelItems(newItems)
      notifyChange(newItems)
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Dialog open={openAddModelDialog} onOpenChange={setOpenAddModelDialog}>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm">
              <Plus className="h-4 w-4 mr-1" />
              Add Model
            </Button>
          </DialogTrigger>
          <DialogContent>
            <div className="space-y-5">
              <Label>Model Name</Label>
              <Input
                type="text"
                placeholder="openai/gpt-4o"
                value={newModelName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddModel()
                  }
                }}
                onChange={(e) => setNewModelName(e.target.value)}
              />
              <Label>Model Type</Label>
              <Select
                value={newModelType}
                onValueChange={(value) =>
                  setNewModelType(value as ModelItem['type'])
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">text</SelectItem>
                  <SelectItem value="image">image</SelectItem>
                  <SelectItem value="video">video</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" onClick={handleAddModel} className="w-full">
                Add Model
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-2">
        {modelItems.map((model, index) => (
          <div key={index} className="flex items-center justify-between">
            <p className="w-[50%]">{model.name}</p>
            <div className="flex items-center gap-6">
              <Select
                value={model.type}
                onValueChange={(value) =>
                  handleTypeChange(index, value as ModelItem['type'])
                }
              >
                <SelectTrigger size="sm" className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">text</SelectItem>
                  <SelectItem value="image">image</SelectItem>
                  <SelectItem value="video">video</SelectItem>
                </SelectContent>
              </Select>
              {modelItems.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleRemoveModel(index)}
                  className="h-10 w-10 p-0"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
