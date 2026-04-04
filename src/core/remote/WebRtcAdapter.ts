import { Logger } from "@/shared/services/Logger"

/**
 * WebRtcAdapter manages the P2P WebRTC connection between cline-core and the mobile app.
 *
 * Architecture:
 * - Connects to a signaling server to exchange SDP offer/answer and ICE candidates
 * - Once P2P is established, creates a data channel that acts as a TCP-like stream
 * - The gRPC server receives connections through this data channel transparently
 *
 * The actual WebRTC implementation requires the `node-datachannel` package
 * (pure Node.js, no Electron dependency). This stub provides the interface
 * and lifecycle management; the full implementation wires up the RTCPeerConnection.
 *
 * To complete the implementation:
 * 1. `npm install node-datachannel` in the extension package
 * 2. Replace the stub methods below with real RTCPeerConnection logic
 * 3. Use SignalingClient to exchange SDP/ICE with the signaling server
 */
export class WebRtcAdapter {
	private static instance: WebRtcAdapter | null = null

	private _isPeerConnected = false
	private _connectedSinceTs = 0
	private _instanceId: string
	private _signalingUrl: string
	private _sharedKey: string
	private _stopped = false

	private constructor(instanceId: string, signalingUrl: string, sharedKey: string) {
		this._instanceId = instanceId
		this._signalingUrl = signalingUrl
		this._sharedKey = sharedKey
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	/**
	 * Start the WebRTC adapter. Registers with the signaling server and
	 * begins waiting for a mobile peer to connect.
	 */
	static async start(instanceId: string, signalingUrl: string, sharedKey: string): Promise<WebRtcAdapter> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.stop()
		}

		const adapter = new WebRtcAdapter(instanceId, signalingUrl, sharedKey)
		WebRtcAdapter.instance = adapter
		await adapter._connect()
		return adapter
	}

	/**
	 * Stop the adapter and close any active P2P connection.
	 */
	static async stop(): Promise<void> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.instance._disconnect()
			WebRtcAdapter.instance = null
		}
	}

	/**
	 * Get the current adapter instance, if any.
	 */
	static getInstance(): WebRtcAdapter | null {
		return WebRtcAdapter.instance
	}

	// ─── Status ───────────────────────────────────────────────────────────────

	isPeerConnected(): boolean {
		return this._isPeerConnected
	}

	getConnectedSinceTs(): number {
		return this._connectedSinceTs
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	private async _connect(): Promise<void> {
		Logger.log(`[WebRtcAdapter] Starting — instanceId=${this._instanceId} signalingUrl=${this._signalingUrl}`)

		// TODO: Full implementation steps:
		//
		// 1. POST to ${signalingUrl}/register with { instanceId, hmac }
		//    where hmac = HMAC-SHA256(instanceId, sharedKey)
		//
		// 2. Poll ${signalingUrl}/offer?instanceId=... until a mobile peer
		//    posts an SDP offer (or use WebSocket for push notification)
		//
		// 3. Create RTCPeerConnection (via node-datachannel):
		//    const pc = new RTCPeerConnection({ iceServers: [...] })
		//
		// 4. Set remote description from the offer, create answer, set local description
		//
		// 5. POST answer to ${signalingUrl}/answer
		//
		// 6. Exchange ICE candidates via ${signalingUrl}/ice
		//
		// 7. On pc.ondatachannel — wrap the RTCDataChannel as a Node.js Duplex stream
		//    and inject it into the ProtoBus gRPC server as a new connection:
		//    protobusServer.emit('connection', dataChannelStream)
		//
		// 8. Update _isPeerConnected = true, _connectedSinceTs = Date.now()
		//
		// 9. On channel close — set _isPeerConnected = false, restart polling loop

		Logger.log("[WebRtcAdapter] Stub: signaling registration not yet implemented")
	}

	private async _disconnect(): Promise<void> {
		this._stopped = true
		this._isPeerConnected = false
		this._connectedSinceTs = 0
		Logger.log("[WebRtcAdapter] Stopped")
	}
}
