import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

/**
 * WebRtcAdapter manages the P2P WebRTC connection between cline-core and the mobile app.
 *
 * Phase 1 (implemented): Registers with the signaling server and polls for an offer.
 * Phase 2 (TODO): Full WebRTC P2P via node-datachannel once that package is available.
 *
 * To complete Phase 2:
 * 1. npm install node-datachannel
 * 2. Implement _handleOffer() with RTCPeerConnection logic
 */
export class WebRtcAdapter {
	private static instance: WebRtcAdapter | null = null

	private _isPeerConnected = false
	private _connectedSinceTs = 0
	private _instanceId: string
	private _signalingUrl: string
	private _sharedKey: string
	private _stopped = false
	private _pollTimer: NodeJS.Timeout | null = null

	private constructor(instanceId: string, signalingUrl: string, sharedKey: string) {
		this._instanceId = instanceId
		this._signalingUrl = signalingUrl
		this._sharedKey = sharedKey
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────────

	static async start(instanceId: string, signalingUrl: string, sharedKey: string): Promise<WebRtcAdapter> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.stop()
		}
		const adapter = new WebRtcAdapter(instanceId, signalingUrl, sharedKey)
		WebRtcAdapter.instance = adapter
		// Non-blocking — don't await so extension startup isn't delayed
		adapter._connect().catch((err) => Logger.error("[WebRtcAdapter] Connection error:", err))
		return adapter
	}

	static async stop(): Promise<void> {
		if (WebRtcAdapter.instance) {
			await WebRtcAdapter.instance._disconnect()
			WebRtcAdapter.instance = null
		}
	}

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

		// Step 1: Register with the signaling server
		try {
			const res = await fetch(`${this._signalingUrl}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instanceId: this._instanceId }),
			})
			if (!res.ok) {
				Logger.error(`[WebRtcAdapter] Registration failed: ${res.status}`)
				return
			}
			Logger.log("[WebRtcAdapter] Registered with signaling server — waiting for mobile peer")
		} catch (err) {
			Logger.error("[WebRtcAdapter] Failed to reach signaling server:", err)
			// Retry after 30s
			if (!this._stopped) {
				this._pollTimer = setTimeout(() => this._connect(), 30_000)
			}
			return
		}

		// Step 2: Poll for an SDP offer from the mobile app
		this._startPolling()
	}

	private _startPolling(): void {
		if (this._stopped) return

		const poll = async () => {
			if (this._stopped) return
			try {
				const res = await fetch(`${this._signalingUrl}/offer?instanceId=${encodeURIComponent(this._instanceId)}`)
				if (res.ok) {
					const data = (await res.json()) as { sdp?: string }
					if (data.sdp) {
						Logger.log("[WebRtcAdapter] Received SDP offer from mobile — WebRTC P2P not yet implemented")
						// TODO: Phase 2 — handle the offer with node-datachannel:
						// await this._handleOffer(data.sdp)
						// For now, just log that we received it
					}
				}
			} catch {
				// Signaling server unreachable — will retry
			}
			// Poll every 3 seconds
			if (!this._stopped && !this._isPeerConnected) {
				this._pollTimer = setTimeout(poll, 3_000)
			}
		}

		poll()
	}

	private async _disconnect(): Promise<void> {
		this._stopped = true
		if (this._pollTimer) {
			clearTimeout(this._pollTimer)
			this._pollTimer = null
		}
		this._isPeerConnected = false
		this._connectedSinceTs = 0
		Logger.log("[WebRtcAdapter] Stopped")
	}
}
