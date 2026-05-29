import { ANTHROPIC_FAST_MODE_SUFFIX, anthropicModels, CLAUDE_SONNET_1M_SUFFIX } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { ContextWindowSwitcher } from "../common/ContextWindowSwitcher"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import ThinkingBudgetSlider from "../ThinkingBudgetSlider"
import { normalizeApiConfiguration } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

// Anthropic models that support thinking/reasoning mode
export const SUPPORTED_ANTHROPIC_THINKING_MODELS = [
	"claude-opus-4-6",
	`claude-opus-4-6${ANTHROPIC_FAST_MODE_SUFFIX}`,
	`claude-opus-4-6${CLAUDE_SONNET_1M_SUFFIX}`,
	`claude-opus-4-6${CLAUDE_SONNET_1M_SUFFIX}${ANTHROPIC_FAST_MODE_SUFFIX}`,
	"claude-sonnet-4-6",
	`claude-sonnet-4-6${CLAUDE_SONNET_1M_SUFFIX}`,
	"claude-3-7-sonnet-20250219",
	"claude-sonnet-4-20250514",
	`claude-sonnet-4-20250514${CLAUDE_SONNET_1M_SUFFIX}`,
	"claude-opus-4-5-20251101",
	"claude-opus-4-20250514",
	"claude-opus-4-1-20250805",
	"claude-sonnet-4-5-20250929",
	`claude-sonnet-4-5-20250929${CLAUDE_SONNET_1M_SUFFIX}`,
	"claude-haiku-4-5-20251001",
]

/**
 * Props for the AnthropicProvider component
 */
interface AnthropicProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * The Anthropic provider configuration component.
 *
 * When a custom base URL is set (e.g. pointing at the local Amazon Q
 * Anthropic-compatible server on http://127.0.0.1:61823), the component
 * fetches the model list from that server's /v1/models endpoint and shows
 * a plain text input pre-populated with the first available model ID.
 * When no custom URL is set it falls back to the static anthropicModels list.
 */
export const AnthropicProvider = ({ showModelOptions, isPopup, currentMode }: AnthropicProviderProps) => {
	const { apiConfiguration, remoteConfigSettings } = useExtensionState()
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()

	// Models fetched from a custom Anthropic-compatible server
	const [remoteModelIds, setRemoteModelIds] = useState<string[]>([])

	// Get the normalized configuration
	const { selectedModelId, selectedModelInfo } = normalizeApiConfiguration(apiConfiguration, currentMode)

	// Helper function for model switching
	const handleModelChange = (modelId: string) => {
		handleModeFieldChange({ plan: "planModeApiModelId", act: "actModeApiModelId" }, modelId, currentMode)
	}

	// Debounce timer for model refresh
	const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

	useEffect(() => {
		return () => {
			if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
		}
	}, [])

	/**
	 * Fetch models from the custom Anthropic-compatible server.
	 * Debounced to avoid hammering the server while the user is typing.
	 */
	const debouncedRefreshAnthropicModels = useCallback((baseUrl?: string) => {
		if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

		if (!baseUrl) {
			setRemoteModelIds([])
			return
		}

		debounceTimerRef.current = setTimeout(async () => {
			try {
				// @ts-ignore — AnthropicModelsRequest is generated; ignore until proto is rebuilt
				const { AnthropicModelsRequest } = await import("@shared/proto/cline/models")
				const result = await ModelsServiceClient.refreshAnthropicModels(
					AnthropicModelsRequest.create({ baseUrl }),
				)
				setRemoteModelIds(result.values ?? [])
			} catch {
				// Server unreachable or proto not yet generated — silently ignore
				setRemoteModelIds([])
			}
		}, 500)
	}, [])

	// Fetch models on mount and whenever the base URL changes
	useEffect(() => {
		debouncedRefreshAnthropicModels(apiConfiguration?.anthropicBaseUrl)
	}, [apiConfiguration?.anthropicBaseUrl, debouncedRefreshAnthropicModels])

	// Whether we're pointing at a custom server with a known model list
	const hasRemoteModels = remoteModelIds.length > 0
	const usingCustomUrl = !!apiConfiguration?.anthropicBaseUrl

	return (
		<div>
			<ApiKeyField
				initialValue={apiConfiguration?.apiKey || ""}
				onChange={(value) => handleFieldChange("apiKey", value)}
				providerName="Anthropic"
				signupUrl="https://console.anthropic.com/settings/keys"
			/>

			<BaseUrlField
				disabled={!!remoteConfigSettings?.anthropicBaseUrl}
				initialValue={apiConfiguration?.anthropicBaseUrl}
				label="Use custom base URL"
				onChange={(value) => {
					handleFieldChange("anthropicBaseUrl", value)
					debouncedRefreshAnthropicModels(value)
				}}
				placeholder="Default: https://api.anthropic.com"
				showLockIcon={!!remoteConfigSettings?.anthropicBaseUrl}
			/>

			{showModelOptions && (
				<>
					{usingCustomUrl && hasRemoteModels ? (
						// Custom server: show a plain dropdown of the server's model IDs
						<div style={{ marginBottom: 10 }}>
							<label style={{ display: "block", fontWeight: 500, marginBottom: 4 }}>Model</label>
							<select
								value={selectedModelId}
								onChange={(e) =>
									handleModeFieldChange(
										{ plan: "planModeApiModelId", act: "actModeApiModelId" },
										e.target.value,
										currentMode,
									)
								}
								style={{ width: "100%", padding: "4px 6px" }}>
								{remoteModelIds.map((id) => (
									<option key={id} value={id}>
										{id}
									</option>
								))}
							</select>
						</div>
					) : (
						// Default Anthropic API: show the static model list
						<ModelSelector
							label="Model"
							models={anthropicModels}
							onChange={(e) =>
								handleModeFieldChange(
									{ plan: "planModeApiModelId", act: "actModeApiModelId" },
									e.target.value,
									currentMode,
								)
							}
							selectedModelId={selectedModelId}
						/>
					)}

					{/* Context window switchers — only relevant for the standard Anthropic API */}
					{!usingCustomUrl && (
						<>
							{/* Context window switcher for Claude Opus 4.6 */}
							<ContextWindowSwitcher
								base1mModelId={`claude-opus-4-6${CLAUDE_SONNET_1M_SUFFIX}`}
								base200kModelId="claude-opus-4-6"
								onModelChange={handleModelChange}
								selectedModelId={selectedModelId}
							/>

							<ContextWindowSwitcher
								base1mModelId={`claude-opus-4-6${CLAUDE_SONNET_1M_SUFFIX}${ANTHROPIC_FAST_MODE_SUFFIX}`}
								base200kModelId={`claude-opus-4-6${ANTHROPIC_FAST_MODE_SUFFIX}`}
								onModelChange={handleModelChange}
								selectedModelId={selectedModelId}
							/>

							{/* Context window switcher for Claude Sonnet 4.6 */}
							<ContextWindowSwitcher
								base1mModelId={`claude-sonnet-4-6${CLAUDE_SONNET_1M_SUFFIX}`}
								base200kModelId="claude-sonnet-4-6"
								onModelChange={handleModelChange}
								selectedModelId={selectedModelId}
							/>

							{/* Context window switcher for Claude Sonnet 4.5 */}
							<ContextWindowSwitcher
								base1mModelId={`claude-sonnet-4-5-20250929${CLAUDE_SONNET_1M_SUFFIX}`}
								base200kModelId="claude-sonnet-4-5-20250929"
								onModelChange={handleModelChange}
								selectedModelId={selectedModelId}
							/>

							{/* Context window switcher for Claude Sonnet 4 */}
							<ContextWindowSwitcher
								base1mModelId={`claude-sonnet-4-20250514${CLAUDE_SONNET_1M_SUFFIX}`}
								base200kModelId="claude-sonnet-4-20250514"
								onModelChange={handleModelChange}
								selectedModelId={selectedModelId}
							/>
						</>
					)}

					{SUPPORTED_ANTHROPIC_THINKING_MODELS.includes(selectedModelId) && (
						<ThinkingBudgetSlider currentMode={currentMode} maxBudget={selectedModelInfo.thinkingConfig?.maxBudget} />
					)}

					<ModelInfoView isPopup={isPopup} modelInfo={selectedModelInfo} selectedModelId={selectedModelId} />
				</>
			)}
		</div>
	)
}
