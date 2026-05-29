import { StringArray } from "@shared/proto/cline/common"
import { AnthropicModelsRequest } from "@shared/proto/cline/models"
import axios from "axios"
import { getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Fetches available models from an Anthropic-compatible server's /v1/models endpoint.
 * Used when the user configures a custom anthropicBaseUrl (e.g. the local Amazon Q
 * Anthropic-compatible server on http://127.0.0.1:61823).
 *
 * @param _controller The controller instance (unused but required by the RPC convention)
 * @param request Request containing the base URL of the Anthropic-compatible server
 * @returns Array of model IDs reported by the server
 */
export async function refreshAnthropicModels(
	_controller: Controller,
	request: AnthropicModelsRequest,
): Promise<StringArray> {
	try {
		if (!request.baseUrl) {
			return StringArray.create({ values: [] })
		}

		if (!URL.canParse(request.baseUrl)) {
			return StringArray.create({ values: [] })
		}

		// Normalise: strip trailing /v1 so we always append /v1/models ourselves
		const base = request.baseUrl.replace(/\/v1\/?$/, "")

		const response = await axios.get(`${base}/v1/models`, {
			timeout: 10_000,
			...getAxiosSettings(),
		})

		// Anthropic format: { data: [{ id, type, display_name, ... }] }
		const models: string[] =
			response.data?.data?.map((m: { id: string }) => m.id).filter(Boolean) ?? []

		return StringArray.create({ values: [...new Set(models)] })
	} catch (error) {
		Logger.error("Error fetching Anthropic models:", error)
		return StringArray.create({ values: [] })
	}
}
