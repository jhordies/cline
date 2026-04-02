export interface UserResponse {
	id: string
	email: string
	displayName: string
	photoUrl: string
	createdAt: string
	updatedAt: string
	organizations: [
		{
			active: boolean
			memberId: string
			name: string
			organizationId: string
			roles: ["admin" | "member" | "owner"]
		},
	]
}

export interface BalanceResponse {
	balance: number
	userId: string
}

export interface FeaturebaseTokenResponse {
	featurebaseJwt: string
}

export interface UsageTransaction {
	aiInferenceProviderName: string
	aiModelName: string
	aiModelTypeName: string
	completionTokens: number
	costUsd: number
	createdAt: string
	creditsUsed: number
	generationId: string
	id: string
	metadata: {
		additionalProp1: string
		additionalProp2: string
		additionalProp3: string
	}
	operation?: string
	organizationId: string
	promptTokens: number
	totalTokens: number
	userId: string
}

export interface PaymentTransaction {
	paidAt: string
	creatorId: string
	amountCents: number
	credits: number
}

export interface OrganizationBalanceResponse {
	balance: number
	organizationId: string
}

export interface OrganizationUsageTransaction {
	aiInferenceProviderName: string
	aiModelName: string
	aiModelTypeName: string
	completionTokens: number
	costUsd: number
	createdAt: string
	creditsUsed: number
	generationId: string
	id: string
	memberDisplayName: string
	memberEmail: string
	metadata: {
		additionalProp1: string
		additionalProp2: string
		additionalProp3: string
	}
	operation?: string
	organizationId: string
	promptTokens: number
	totalTokens: number
	userId: string
}

/**
 * An organization that has remote config enabled, returned by
 * GET /api/v1/users/me/remote-config.
 */
export interface UserRemoteConfigOrganization {
	organizationId: string
	name: string
}

/**
 * Response from GET /api/v1/users/me/remote-config.
 * The backend selects the user's active org if it has remote config enabled,
 * otherwise falls back to the first enabled org (enterprise orgs sorted first).
 */
export interface UserRemoteConfigDiscoveryResponse {
	/** Organization ID of the selected remote config */
	organizationId: string
	/** The remote configuration JSON value */
	value: string
	/** Whether remote config is enabled */
	enabled: boolean
	/** All organizations with remote config enabled */
	organizations: UserRemoteConfigOrganization[]
}

// Used in cline.ts provider and in webview-ui/src/components/chat/ChatRow.tsx to display the login button
export const CLINE_ACCOUNT_AUTH_ERROR_MESSAGE = "Unauthorized: Please sign in to Cline before trying again."
