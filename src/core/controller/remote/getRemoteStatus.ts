import { EmptyRequest } from "@shared/proto/cline/common"
import { RemoteStatus } from "@shared/proto/cline/remote"
import { Controller } from ".."
import { WebRtcAdapter } from "../../remote/WebRtcAdapter"

/**
 * Returns the current remote bridge status.
 */
export async function getRemoteStatus(controller: Controller, _request: EmptyRequest): Promise<RemoteStatus> {
	const state = controller.stateManager
	const enabled = state.getGlobalSettingsKey("remoteBridgeEnabled") ?? false
	const instanceId = state.getGlobalSettingsKey("remoteBridgeInstanceId") ?? ""
	const signalingUrl = state.getGlobalSettingsKey("remoteBridgeSignalingUrl") ?? "https://signal.cline.bot"

	const adapter = WebRtcAdapter.getInstance()
	const peerConnected = adapter?.isPeerConnected() ?? false
	const connectedSinceTs = adapter?.getConnectedSinceTs() ?? 0

	return RemoteStatus.create({
		enabled,
		instanceId,
		peerConnected,
		connectedSinceTs: BigInt(connectedSinceTs),
		signalingUrl,
	})
}
