import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTrigger } from '../ui/dialog'
import { useTranslation } from 'react-i18next'

export type ModelType = 'text' | 'image' | 'video'

export type ModelItem = {
  name: string
  display_name?: string
  type: ModelType
  is_disabled?: boolean
}

interface ModelsListProps {
  models: Record<
    string,
    { type?: ModelType; is_disabled?: boolean; display_name?: string }
  >
  onChange: (
    models: Record<string, { type?: ModelType; is_disabled?: boolean }>
  ) => void
  label?: string
}

export default function AddModelsList({
  models,
  onChange,
  label = 'Models',
}: ModelsListProps) {
  const { t } = useTranslation()
  const [modelItems, setModelItems] = useState<ModelItem[]>([])
  const [newModelName, setNewModelName] = useState('')
  const [openAddModelDialog, setOpenAddModelDialog] = useState(false)

  useEffect(() => {
    const modelItems = Object.entries(models).map(([name, config]) => ({
      name,
      display_name: config.display_name,
      type: (config.type || 'text') as ModelType,
      is_disabled: config.is_disabled ?? false,
    }))
    setModelItems(modelItems.length > 0 ? modelItems : [])
  }, [models])

  const notifyChange = useCallback(
    (items: ModelItem[]) => {
      // Filter out empty model names and convert back to object format
      const validModels = items.filter((model) => model.name.trim())
      const modelsConfig: Record<
        string,
        { type?: ModelType; is_disabled?: boolean }
      > = {}

      validModels.forEach((model) => {
        modelsConfig[model.name] = {
          type: model.type,
          is_disabled: model.is_disabled,
        }
      })

      onChange(modelsConfig)
    },
    [onChange]
  )

  const handleAddModel = () => {
    if (newModelName) {
      const newItems = [
        ...modelItems,
        { name: newModelName, type: 'text' as ModelType, is_disabled: false },
      ]
      setModelItems(newItems)
      notifyChange(newItems)
      setNewModelName('')
      setOpenAddModelDialog(false)
    }
  }

  const handleToggleModel = (index: number, enabled: boolean) => {
    const newItems = modelItems.map((model, i) =>
      i === index ? { ...model, is_disabled: !enabled } : model
    )
    setModelItems(newItems)
    notifyChange(newItems)
  }

  const handleRemoveModel = (index: number) => {
    const newItems = modelItems.filter((_, i) => i !== index)
    setModelItems(newItems)
    notifyChange(newItems)
  }

  const textModelCount = modelItems.filter(
    (model) => model.type === 'text'
  ).length

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Dialog open={openAddModelDialog} onOpenChange={setOpenAddModelDialog}>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm">
              <Plus className="h-4 w-4 mr-1" />
              {t('settings:models.addModel')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground">
                {t('settings:models.addTextModelHint')}
              </p>
              <Label>{t('settings:models.modelName')}</Label>
              <Input
                type="text"
                placeholder={t('settings:models.placeholder')}
                value={newModelName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddModel()
                  }
                }}
                onChange={(e) => setNewModelName(e.target.value)}
              />
              <Button type="button" onClick={handleAddModel} className="w-full">
                {t('settings:models.addModel')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-2">
        {modelItems.map((model, index) => (
          <div
            key={model.name}
            className="flex items-center justify-between gap-3"
          >
            <div
              className={`flex-1 min-w-0 ${
                model.is_disabled ? 'text-gray-400 line-through' : ''
              }`}
            >
              <p className="truncate">{model.display_name || model.name}</p>
              {model.display_name && (
                <p className="text-xs text-muted-foreground truncate">
                  {model.name}
                </p>
              )}
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="text-xs text-muted-foreground w-10 text-right">
                {model.type}
              </span>
              <Switch
                checked={!model.is_disabled}
                onCheckedChange={(checked) => handleToggleModel(index, checked)}
              />
              {model.type === 'text' && textModelCount > 1 && (
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
