import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { PROVIDER_NAME_MAPPING } from '@/constants'
import { LLMConfig } from '@/types/types'
import { useTranslation } from 'react-i18next'
import AddModelsList from './AddModelsList'
import { Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { ToolInfo } from '@/api/model'
import { normalizeModelName } from '@/lib/utils'

type ModelConfigEntry = {
  type?: 'text' | 'image' | 'video'
  is_disabled?: boolean
}

type UiModelConfig = ModelConfigEntry & { display_name?: string }

interface CommonSettingProps {
  providerKey: string
  config: LLMConfig
  onConfigChange: (key: string, newConfig: LLMConfig) => void
  onDeleteProvider?: (providerKey: string) => void
  toolCatalog?: ToolInfo[]
}

export default function CommonSetting({
  providerKey,
  config,
  onConfigChange,
  onDeleteProvider,
  toolCatalog = [],
}: CommonSettingProps) {
  const { t } = useTranslation()

  // Only models that can actually show up in the home model selector are
  // listed here: text models plus media models backed by a generation tool.
  const { displayModels, hiddenModels, hiddenMediaCount } = useMemo(() => {
    const providerTools = toolCatalog.filter(
      (tool) => tool.provider === providerKey && tool.model
    )
    const toolByModel = new Map(
      providerTools.map((tool) => [
        normalizeModelName(tool.model as string),
        tool,
      ])
    )
    const configModels = config.models || {}

    const displayModels: Record<string, UiModelConfig> = {}
    const hiddenModels: Record<string, ModelConfigEntry> = {}

    Object.entries(configModels).forEach(([name, modelConfig]) => {
      const type = modelConfig.type || 'text'
      if (type === 'text') {
        displayModels[name] = {
          type: 'text',
          is_disabled: modelConfig.is_disabled ?? false,
        }
      }
    })

    // Media rows follow the tool catalog order so they match the home selector.
    providerTools.forEach((tool) => {
      if (!tool.model) return
      const normalizedModel = normalizeModelName(tool.model)
      const matchedEntry = Object.entries(configModels).find(
        ([name, modelConfig]) =>
          (modelConfig.type === 'image' || modelConfig.type === 'video') &&
          normalizeModelName(name) === normalizedModel
      )

      displayModels[tool.model] = {
        type: tool.type === 'video' ? 'video' : 'image',
        is_disabled: matchedEntry?.[1].is_disabled ?? false,
        display_name: tool.display_name || undefined,
      }
    })

    // Media models without a generation tool cannot appear on the home page.
    Object.entries(configModels).forEach(([name, modelConfig]) => {
      if (modelConfig.type !== 'image' && modelConfig.type !== 'video') return
      if (!toolByModel.has(normalizeModelName(name))) {
        hiddenModels[name] = modelConfig
      }
    })

    return {
      displayModels,
      hiddenModels,
      hiddenMediaCount: Object.keys(hiddenModels).length,
    }
  }, [config.models, providerKey, toolCatalog])

  // jaaz is official provider, so we don't need to show it here
  if (providerKey === 'jaaz') {
    return null
  }

  const provider = PROVIDER_NAME_MAPPING[providerKey] || {
    name:
      providerKey.charAt(0).toUpperCase() +
      providerKey.slice(1).replace(/_/g, ' '),
    // TODO: replace icon
    icon: 'https://openai.com/favicon.ico',
  }

  // Check if this is a custom provider (not in PROVIDER_NAME_MAPPING)
  const isCustomProvider = config.is_custom

  const handleChange = (field: keyof LLMConfig, value: string | number) => {
    onConfigChange(providerKey, {
      ...config,
      [field]: value,
    })
  }

  const handleModelsChange = (models: Record<string, ModelConfigEntry>) => {
    onConfigChange(providerKey, {
      ...config,
      // Keep media models without a generation tool so they are not dropped
      // from the saved configuration.
      models: { ...hiddenModels, ...models },
    })
  }

  const handleDelete = () => {
    if (onDeleteProvider && isCustomProvider) {
      onDeleteProvider(providerKey)
    }
  }

  const isImageProvider =
    providerKey === 'replicate' || providerKey === 'huggingface'
  const hasMaxTokens = !isImageProvider

  return (
    <div className="space-y-4">
      {/* Provider Header */}
      <div className="flex items-center gap-2">
        <img
          src={provider.icon}
          alt={provider.name}
          className="w-10 h-10 rounded-full"
        />
        <p className="font-bold text-2xl w-fit">{provider.name}</p>
        {isCustomProvider && <span>✨ Custom Provider</span>}
        {isImageProvider && <span>🎨 Image Generation</span>}

        {/* Delete Button - only for custom providers */}
        {isCustomProvider && onDeleteProvider && (
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDelete}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {t('settings:provider.delete')}
            </Button>
          </div>
        )}
      </div>

      {/* API URL Input */}
      <div className="space-y-2">
        <Label htmlFor={`${providerKey}-url`}>
          {t('settings:provider.apiUrl')}
        </Label>
        <Input
          id={`${providerKey}-url`}
          placeholder={t('settings:provider.apiUrlPlaceholder')}
          value={config.url ?? ''}
          onChange={(e) => handleChange('url', e.target.value)}
          className="w-full"
        />
        <p className="text-xs text-gray-500">
          {t('settings:provider.apiUrlDescription')}
        </p>
      </div>

      {/* API Key Input */}
      <div className="space-y-2">
        <Label htmlFor={`${providerKey}-apiKey`}>
          {t('settings:provider.apiKey')}
        </Label>
        <Input
          id={`${providerKey}-apiKey`}
          type="password"
          placeholder={t('settings:provider.apiKeyPlaceholder')}
          value={config.api_key ?? ''}
          onChange={(e) => handleChange('api_key', e.target.value)}
          className="w-full"
        />
        <p className="text-xs text-gray-500">
          {t('settings:provider.apiKeyDescription')}
        </p>
      </div>

      {/* Models Configuration - only for custom providers */}
      {providerKey !== 'ollama' && (
        <div className="space-y-2">
          {(config.api_key ?? '').trim() ? (
            <>
              <AddModelsList
                models={displayModels}
                onChange={handleModelsChange}
                label={t('settings:models.title')}
              />
              {hiddenMediaCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('settings:models.hiddenUnsupported', {
                    count: hiddenMediaCount,
                  })}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('settings:models.notConfigured')}
            </p>
          )}
        </div>
      )}

      {/* Max Tokens Input - only for text providers */}
      {hasMaxTokens && (
        <div className="space-y-2">
          <Label htmlFor={`${providerKey}-maxTokens`}>
            {t('settings:provider.maxTokens')}
          </Label>
          <Input
            id={`${providerKey}-maxTokens`}
            type="number"
            placeholder={t('settings:provider.maxTokensPlaceholder')}
            value={config.max_tokens ?? 8192}
            onChange={(e) =>
              handleChange('max_tokens', parseInt(e.target.value))
            }
            className="w-full"
          />
          <p className="text-xs text-gray-500">
            {t('settings:provider.maxTokensDescription')}
          </p>
        </div>
      )}
    </div>
  )
}
