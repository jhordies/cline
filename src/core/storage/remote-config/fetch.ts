import axios, { AxiosRequestConfig, AxiosResponse } from "axios"
import { Controller } from "@/core/controller"
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { buildBasicClineHeaders } from "@/services/EnvUtils"
import { getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { ConfiguredAPIKeys } from "@/shared/storage/state-keys"
import { ClineEnv } from "../../../config"
import { AuthService } from "../../../services/auth/AuthService"
import { CLINE_API_ENDPOINT } from "../../../shared/cline/api"
import { APIKeySchema, type APIKeySettings, RemoteConfig, RemoteConfigSchema } from "../../../shared/remote-config/schema"
import { deleteRemoteConfigFromCache, readRemoteConfigFromCache, writeRemoteConfigToCache } from "../disk"
import { applyRemoteConfig, clearRemoteConfig, isRemoteConfigEnabled } from "./utils"

/**
 * Parses API keys from a JSON string response
 * @param value The JSON string containing API keys
 * @returns Parsed API key settings object
 */
function parseApiKeys(value: string): APIKeySettings {
	try {
		if (!value) {
			return {}
		}
		return APIKeySchema.parse(JSON.parse(value))
	} catch (err) {
		Logger.error(`Failed to parse providers api keys`, err)
		return {}
	}
}

/**
 * Helper function to make authenticated requests to the Cline API
 * @param endpoint The API endpoint path (with {id} placeholder if needed)
 * @param organizationId The organization ID to replace in the endpoint
 * @returns The response data on success
 * @throws Error if the request fails or returns an error
 */
async function makeAuthenticatedRequest<T>(endpoint: string, organizationId: string): Promise<T> {
	const authService = AuthService.getInstance()

	// Get authentication token
	const authToken = await authService.getAuthToken()
	if (!authToken) {
		throw new Error("No Cline account auth token found")
	}

	// Construct URL by replacing {id} placeholder with organizationId
	const apiEndpoint = endpoint.replace("{id}", organizationId)
	const url = new URL(apiEndpoint, ClineEnv.config().apiBaseUrl).toString()

	// Make authenticated request
	const requestConfig: AxiosRequestConfig = {
		headers: {
			Authorization: `Bearer ${authToken}`,
			"Content-Type": "application/json",
			...(await buildBasicClineHeaders()),
		},
		...getAxiosSettings(),
	}

	const response: AxiosResponse<{
		data?: T
		error: string
		success: boolean
	}> = await axios.request({
		url,
		method: "GET",
		...requestConfig,
	})

	// Validate response status
	const status = response.status
	if (status < 200 || status >= 300) {
		throw new Error(`Request to ${apiEndpoint} failed with status ${status}`)
	}

	// Validate response structure
	if (!response.data || !response.data.success) {
		throw new Error(`API error: ${response.data?.error || "Unknown error"}`)
	}

	// Extract and return data
	const data = response.data.data
	if (!data) {
		throw new Error(`No data returned from ${apiEndpoint}`)
	}

	return data
}

/**
 * Fetches remote configuration for a specific organization from the API.
 * Falls back to cached config if the request fails.
 *
 * @param organizationId The organization ID to fetch config for
 * @returns RemoteConfig if enabled, undefined if disabled or not found
 */
async function fetchRemoteConfigForOrganization(organizationId: string): Promise<RemoteConfig | undefined> {
	try {
		// Fetch config data using helper
		const configData = await makeAuthenticatedRequest<{ value: string; enabled: boolean }>(
			CLINE_API_ENDPOINT.REMOTE_CONFIG,
			organizationId,
		)

		// Check if config is enabled
		if (!configData.enabled) {
			// Clear the remote config from the on-disk cache if it exists
			await deleteRemoteConfigFromCache(organizationId)
			return undefined
		}

		// Parse the JSON-encoded Value field
		const parsedConfig = JSON.parse(configData.value)

		// Validate against schema
		const validatedConfig = RemoteConfigSchema.parse(parsedConfig)

		return validatedConfig
	} catch (error) {
		Logger.error(`Failed to fetch remote config for organization ${organizationId}:`, error)

		// Try to fall back to cached config
		const cachedConfig = await readRemoteConfigFromCache(organizationId)
		if (cachedConfig) {
			try {
				// Validate cached config against schema
				const validatedCachedConfig = RemoteConfigSchema.parse(cachedConfig)
				return validatedCachedConfig
			} catch (validationError) {
				// Cache validation failed - log and continue
				Logger.error(`Cached config validation failed for organization ${organizationId}:`, validationError)
			}
		}

		return undefined
	}
}

/**
 * Fetches API keys for a specific organization from the API.
 *
 * @param organizationId The organization ID to fetch API keys for
 * @returns Record of API keys (e.g., { litellm: "key" }) or undefined if fetch fails
 */
async function fetchApiKeysForOrganization(organizationId: string): Promise<APIKeySettings> {
	try {
		// Fetch API keys string using helper
		const response = await makeAuthenticatedRequest<{ providerApiKeys: string }>(CLINE_API_ENDPOINT.API_KEYS, organizationId)

		// Parse and return API keys
		return parseApiKeys(response?.providerApiKeys)
	} catch (error) {
		Logger.error(`Failed to fetch API keys for organization ${organizationId}:`, error)
		return {}
	}
}

/**
 * Uses the user-level remote-config discovery endpoint to find the best organization
 * with remote config enabled, respecting local admin/owner opt-out.
 *
 * Algorithm:
 * 1. Call GET /api/v1/users/me/remote-config for discovery.
 * 2. If backend returns no config (null data), no org has remote config → return undefined.
 * 3. Use the backend-selected org if it is locally allowed (not opted-out by admin/owner).
 * 4. If the selected org is locally opted-out, iterate the returned organizations list
 *    and pick the first one that is locally allowed.
 * 5. If no org is locally allowed, return undefined.
 *
 * @returns Object containing the chosen organizationId, or undefined if none qualify.
 */
export async function discoverRemoteConfigOrg(): Promise<{ organizationId: string } | undefined> {
	const accountService = ClineAccountService.getInstance()

	const discovery = await accountService.fetchUserRemoteConfig()
	if (!discovery || !discovery.enabled) {
		return undefined
	}

	// Check the backend-selected org first
	if (isRemoteConfigEnabled(discovery.organizationId)) {
		return { organizationId: discovery.organizationId }
	}

	// Backend-selected org is locally opted-out; scan the organizations list
	if (discovery.organizations) {
		for (const org of discovery.organizations) {
			if (isRemoteConfigEnabled(org.organizationId)) {
				return { organizationId: org.organizationId }
			}
		}
	}

	// No org is locally allowed
	return undefined
}

/**
 * Ensures the user is in the correct organization with remote configuration enabled.
 * Uses the user-level discovery endpoint instead of sequential per-org probing.
 *
 * @param controller The controller instance
 * @returns RemoteConfig if found and applied, undefined otherwise
 */
async function ensureUserInOrgWithRemoteConfig(controller: Controller): Promise<RemoteConfig | undefined> {
	const authService = AuthService.getInstance()

	try {
		// Step 1: Discover which org to use via user-level endpoint
		const discovered = await discoverRemoteConfigOrg()

		if (!discovered) {
			clearRemoteConfig()
			controller.postStateToWebview()
			return undefined
		}

		const { organizationId } = discovered

		// Step 2: Fetch the full org-level remote config for the chosen org
		const remoteConfig = await fetchRemoteConfigForOrganization(organizationId)

		if (!remoteConfig) {
			clearRemoteConfig()
			controller.postStateToWebview()
			return undefined
		}

		// Step 3: Switch accounts only if the chosen org differs from the current active org.
		// Churn prevention: short-circuit when the active org already equals the chosen org,
		// avoiding "fetch → switch → fetch again" infinite loops.
		const currentActiveOrgId = authService.getActiveOrganizationId()
		const currentActiveOrgId = authService.getActiveOrganizationId()
		if (currentActiveOrgId !== organizationId) {
			await controller.accountService.switchAccount(organizationId)
		}

		// Step 4: Fetch and store API keys for configured providers
		const configuredApiKeys: ConfiguredAPIKeys = {}
		const hasConfiguredProviders = remoteConfig.providerSettings && Object.keys(remoteConfig.providerSettings).length > 0
		if (hasConfiguredProviders) {
			const apiKeys = await fetchApiKeysForOrganization(organizationId)
			if (remoteConfig.providerSettings?.LiteLLM) {
				if (apiKeys.litellm) {
					configuredApiKeys["litellm"] = true
					controller.stateManager.setSecret("remoteLiteLlmApiKey", apiKeys.litellm)
				} else {
					controller.stateManager.setSecret("remoteLiteLlmApiKey", undefined)
				}
			} else {
				controller.stateManager.setSecret("remoteLiteLlmApiKey", undefined)
			}
		} else {
			controller.stateManager.setSecret("remoteLiteLlmApiKey", undefined)
		}

		// Step 5: Cache and apply the remote config
		await writeRemoteConfigToCache(organizationId, remoteConfig)
		if (isRemoteConfigEnabled(organizationId)) {
			await applyRemoteConfig(remoteConfig, configuredApiKeys, controller.mcpHub)
		} else {
			clearRemoteConfig()
		}
		controller.postStateToWebview()

		return remoteConfig
	} catch (error) {
		Logger.error("Failed to ensure user in organization with remote config:", error)
		return undefined
	}
}

/**
 * Main entry point for fetching remote configuration.
 * Uses the user-level discovery endpoint (GET /api/v1/users/me/remote-config)
 * to find the right org in a single call, then fetches the full config and API keys
 * only for the chosen org.
 *
 * It catches any exceptions, logs them and does not propagate them to the caller.
 *
 * This function is called periodically to ensure users stay in
 * organizations with remote configuration enabled.
 *
 * @param controller The controller instance
 */
export async function fetchRemoteConfig(controller: Controller) {
	try {
		await ensureUserInOrgWithRemoteConfig(controller)
	} catch (error) {
		Logger.error("Failed to fetch remote config", error)
	}
}
