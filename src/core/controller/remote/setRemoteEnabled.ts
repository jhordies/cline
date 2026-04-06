import { BooleanRequest } from "@shared/proto/cline/common"
import { RemoteStatus } from "@shared/proto/cline/remote"
import crypto from "crypto"
import { WebRtcAdapter } from "../../remote/WebRtcAdapter"
import { Controller } from ".."

/**
 * Enables or disables the remote mobile bridge.
 * On first enable, generates a UUID instanceId and a random shared key.
 */
export async function setRemoteEnabled(controller: Controller, request: BooleanRequest): Promise<RemoteStatus> {
	const enabled = request.value
	const state = controller.stateManager

	if (enabled) {
		// Generate instanceId if not already set
		let instanceId = state.getGlobalSettingsKey("remoteBridgeInstanceId")
		if (!instanceId) {
			instanceId = crypto.randomUUID()
			await state.setGlobalState("remoteBridgeInstanceId", instanceId)
		}

		// Generate shared key if not already set
		const existingKey = await state.getSecretKey("remoteBridgeSharedKey")
		if (!existingKey) {
			const sharedKey = crypto.randomBytes(32).toString("base64")
			await state.setSecret("remoteBridgeSharedKey", sharedKey)
		}

		// Start the WebRTC adapter
		const signalingUrl = state.getGlobalSettingsKey("remoteBridgeSignalingUrl") ?? "https://signal.cline.bot"
		const sharedKey = (await state.getSecretKey("remoteBridgeSharedKey"))!
		await WebRtcAdapter.start(instanceId, signalingUrl, sharedKey, controller)
	} else {
		// Stop the adapter
		await WebRtcAdapter.stop()
	}

	await state.setGlobalState("remoteBridgeEnabled", enabled)
	await controller.postStateToWebview()

	const instanceId = state.getGlobalSettingsKey("remoteBridgeInstanceId") ?? ""
	const signalingUrl = state.getGlobalSettingsKey("remoteBridgeSignalingUrl") ?? "https://signal.cline.bot"
	const adapter = WebRtcAdapter.getInstance()

	return RemoteStatus.create({
		enabled,
		instanceId,
		peerConnected: adapter?.isPeerConnected() ?? false,
		connectedSinceTs: adapter?.getConnectedSinceTs() ?? 0,
		signalingUrl,
	})
}
