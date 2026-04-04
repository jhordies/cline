import { StringRequest } from "@shared/proto/cline/common"
import { RemoteStatus } from "@shared/proto/cline/remote"
import { Controller } from ".."
import { WebRtcAdapter } from "../../remote/WebRtcAdapter"

/**
 * Updates the signaling server URL.
 * If the bridge is currently enabled, restarts the adapter with the new URL.
 */
export async function setSignalingUrl(controller: Controller, request: StringRequest): Promise<RemoteStatus> {
	const state = controller.stateManager
	const newUrl = request.value || "https://signal.cline.bot"

	await state.setGlobalState("remoteBridgeSignalingUrl", newUrl)

	const enabled = state.getGlobalSettingsKey("remoteBridgeEnabled") ?? false
	if (enabled) {
		const instanceId = state.getGlobalSettingsKey("remoteBridgeInstanceId") ?? ""
		const sharedKey = (await state.getSecretKey("remoteBridgeSharedKey")) ?? ""
		await WebRtcAdapter.stop()
		await WebRtcAdapter.start(instanceId, newUrl, sharedKey)
	}

	await controller.postStateToWebview()

	const adapter = WebRtcAdapter.getInstance()
	return RemoteStatus.create({
		enabled,
		instanceId: state.getGlobalSettingsKey("remoteBridgeInstanceId") ?? "",
		peerConnected: adapter?.isPeerConnected() ?? false,
		connectedSinceTs: adapter?.getConnectedSinceTs() ?? 0,
		signalingUrl: newUrl,
	})
}
