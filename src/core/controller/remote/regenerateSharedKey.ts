import crypto from "crypto"
import { EmptyRequest } from "@shared/proto/cline/common"
import { PairingInfo } from "@shared/proto/cline/remote"
import { Controller } from ".."
import { WebRtcAdapter } from "../../remote/WebRtcAdapter"

/**
 * Regenerates the shared key, invalidating any existing mobile pairings.
 * If the bridge is enabled, restarts the adapter with the new key.
 */
export async function regenerateSharedKey(controller: Controller, _request: EmptyRequest): Promise<PairingInfo> {
	const state = controller.stateManager

	const newKey = crypto.randomBytes(32).toString("base64")
	await state.setSecret("remoteBridgeSharedKey", newKey)

	const instanceId = state.getGlobalSettingsKey("remoteBridgeInstanceId") ?? crypto.randomUUID()
	const signalingUrl = state.getGlobalSettingsKey("remoteBridgeSignalingUrl") ?? "https://signal.cline.bot"

	// Restart adapter with new key if currently enabled
	const enabled = state.getGlobalSettingsKey("remoteBridgeEnabled") ?? false
	if (enabled) {
		await WebRtcAdapter.stop()
		await WebRtcAdapter.start(instanceId, signalingUrl, newKey)
	}

	const qrPayload = JSON.stringify({
		v: 1,
		signalingUrl,
		instanceId,
		sharedKey: newKey,
	})

	return PairingInfo.create({
		instanceId,
		signalingUrl,
		sharedKey: newKey,
		qrPayload,
	})
}
