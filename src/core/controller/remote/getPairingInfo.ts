import crypto from "crypto"
import { EmptyRequest } from "@shared/proto/cline/common"
import { PairingInfo } from "@shared/proto/cline/remote"
import { Controller } from ".."

/**
 * Returns pairing info for QR code display.
 * Generates instanceId and shared key if they don't exist yet.
 */
export async function getPairingInfo(controller: Controller, _request: EmptyRequest): Promise<PairingInfo> {
	const state = controller.stateManager

	// Ensure instanceId exists
	let instanceId = state.getGlobalSettingsKey("remoteBridgeInstanceId")
	if (!instanceId) {
		instanceId = crypto.randomUUID()
		await state.setGlobalState("remoteBridgeInstanceId", instanceId)
	}

	// Ensure shared key exists
	let sharedKey = await state.getSecretKey("remoteBridgeSharedKey")
	if (!sharedKey) {
		sharedKey = crypto.randomBytes(32).toString("base64")
		await state.setSecret("remoteBridgeSharedKey", sharedKey)
	}

	const signalingUrl = state.getGlobalSettingsKey("remoteBridgeSignalingUrl") ?? "https://signal.cline.bot"

	const qrPayload = JSON.stringify({
		v: 1,
		signalingUrl,
		instanceId,
		sharedKey,
	})

	return PairingInfo.create({
		instanceId,
		signalingUrl,
		sharedKey,
		qrPayload,
	})
}
