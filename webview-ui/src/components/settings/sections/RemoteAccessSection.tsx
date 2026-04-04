import { VSCodeButton, VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { BooleanRequest, EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { RemoteServiceClient } from "@/services/grpc-client"
import Section from "../Section"

interface RemoteAccessSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

export const RemoteAccessSection = ({ renderSectionHeader }: RemoteAccessSectionProps) => {
	const { remoteBridgeEnabled, remoteBridgeInstanceId, remoteBridgeSignalingUrl, remoteBridgePeerConnected } =
		useExtensionState()

	const [pairingInfo, setPairingInfo] = useState<{ qrPayload: string; sharedKey: string } | null>(null)
	const [showQr, setShowQr] = useState(false)
	const [signalingUrlInput, setSignalingUrlInput] = useState(remoteBridgeSignalingUrl ?? "https://signal.cline.bot")
	const [isLoading, setIsLoading] = useState(false)

	// Sync signalingUrl input when state changes
	useEffect(() => {
		if (remoteBridgeSignalingUrl) {
			setSignalingUrlInput(remoteBridgeSignalingUrl)
		}
	}, [remoteBridgeSignalingUrl])

	const handleToggleEnabled = async (enabled: boolean) => {
		if (!RemoteServiceClient) return
		setIsLoading(true)
		try {
			await RemoteServiceClient.setRemoteEnabled(BooleanRequest.create({ value: enabled }))
		} finally {
			setIsLoading(false)
		}
	}

	const handleShowQr = async () => {
		if (!RemoteServiceClient) return
		setIsLoading(true)
		try {
			const info = await RemoteServiceClient.getPairingInfo(EmptyRequest.create())
			setPairingInfo({ qrPayload: info.qrPayload, sharedKey: info.sharedKey })
			setShowQr(true)
		} finally {
			setIsLoading(false)
		}
	}

	const handleRegenerateKey = async () => {
		if (!RemoteServiceClient) return
		if (!confirm("This will invalidate all existing mobile pairings. Continue?")) return
		setIsLoading(true)
		try {
			const info = await RemoteServiceClient.regenerateSharedKey(EmptyRequest.create())
			setPairingInfo({ qrPayload: info.qrPayload, sharedKey: info.sharedKey })
			setShowQr(true)
		} finally {
			setIsLoading(false)
		}
	}

	const handleSignalingUrlSave = async () => {
		if (!RemoteServiceClient) return
		await RemoteServiceClient.setSignalingUrl(StringRequest.create({ value: signalingUrlInput }))
	}

	const clientAvailable = !!RemoteServiceClient

	return (
		<div>
			{renderSectionHeader("remote-access")}
			<Section>
				{!clientAvailable && (
					<p className="text-sm text-description mb-4">
						Remote access requires running <code>npm run protos</code> to generate the gRPC client.
					</p>
				)}

				{/* Enable toggle */}
				<div className="flex items-center gap-2 mb-4">
					<VSCodeCheckbox
						checked={remoteBridgeEnabled ?? false}
						disabled={!clientAvailable || isLoading}
						onChange={(e: any) => handleToggleEnabled(e.target.checked)}>
						Enable remote mobile access
					</VSCodeCheckbox>
				</div>

				<p className="text-sm text-description mb-4">
					Allow a mobile app to connect to and control Cline remotely via a P2P WebRTC connection. Your tasks and
					messages are never routed through any server.
				</p>

				{remoteBridgeEnabled && (
					<>
						{/* Connection status */}
						<div className="flex items-center gap-2 mb-4">
							<span
								className={`inline-block w-2 h-2 rounded-full ${remoteBridgePeerConnected ? "bg-green-500" : "bg-gray-400"}`}
							/>
							<span className="text-sm">
								{remoteBridgePeerConnected ? "Mobile connected" : "No mobile connected"}
							</span>
						</div>

						{/* Instance ID */}
						{remoteBridgeInstanceId && (
							<div className="mb-4">
								<p className="text-xs text-description mb-1">Instance ID</p>
								<code className="text-xs bg-vscode-input-background px-2 py-1 rounded select-all">
									{remoteBridgeInstanceId}
								</code>
							</div>
						)}

						{/* Signaling URL */}
						<div className="mb-4">
							<p className="text-xs text-description mb-1">Signaling server URL</p>
							<div className="flex gap-2">
								<VSCodeTextField
									value={signalingUrlInput}
									onInput={(e: any) => setSignalingUrlInput(e.target.value)}
									style={{ flexGrow: 1 }}
								/>
								<VSCodeButton onClick={handleSignalingUrlSave} disabled={!clientAvailable}>
									Save
								</VSCodeButton>
							</div>
						</div>

						{/* QR Code */}
						<div className="mb-4 flex gap-2">
							<VSCodeButton onClick={handleShowQr} disabled={!clientAvailable || isLoading}>
								{showQr ? "Refresh QR code" : "Show pairing QR code"}
							</VSCodeButton>
							<VSCodeButton appearance="secondary" onClick={handleRegenerateKey} disabled={!clientAvailable || isLoading}>
								Regenerate key
							</VSCodeButton>
						</div>

						{showQr && pairingInfo && (
							<div className="mb-4">
								<p className="text-xs text-description mb-1">Pairing string (scan with mobile app or copy):</p>
								<textarea
									readOnly
									className="text-xs w-full h-20 bg-vscode-input-background p-2 rounded select-all font-mono"
									value={pairingInfo.qrPayload}
								/>
							</div>
						)}
					</>
				)}
			</Section>
		</div>
	)
}

export default RemoteAccessSection
