import { discoverRemoteConfigOrg } from "@core/storage/remote-config/fetch"
import * as remoteConfigUtils from "@core/storage/remote-config/utils"
import type { UserRemoteConfigDiscoveryResponse } from "@shared/ClineAccount"
import * as assert from "assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { AuthService } from "@/services/auth/AuthService"

describe("discoverRemoteConfigOrg", () => {
	let sandbox: sinon.SinonSandbox
	let accountService: ClineAccountService
	let fetchUserRemoteConfigStub: sinon.SinonStub
	let isRemoteConfigEnabledStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(AuthService, "getInstance").returns({} as AuthService)
		accountService = new ClineAccountService()
		sandbox.stub(ClineAccountService, "getInstance").returns(accountService)

		fetchUserRemoteConfigStub = sandbox.stub(accountService, "fetchUserRemoteConfig")
		isRemoteConfigEnabledStub = sandbox.stub(remoteConfigUtils, "isRemoteConfigEnabled")
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("returns undefined when discovery returns undefined (no auth)", async () => {
		fetchUserRemoteConfigStub.resolves(undefined)

		const result = await discoverRemoteConfigOrg()
		assert.strictEqual(result, undefined)
	})

	it("returns undefined when discovery returns disabled config", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-1",
			value: "{}",
			enabled: false,
			organizations: [],
		} satisfies UserRemoteConfigDiscoveryResponse)

		const result = await discoverRemoteConfigOrg()
		assert.strictEqual(result, undefined)
	})

	it("returns the backend-selected org when it is locally allowed", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-1",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [
				{ organizationId: "org-1", name: "Org 1" },
				{ organizationId: "org-2", name: "Org 2" },
			],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.withArgs("org-1").returns(true)

		const result = await discoverRemoteConfigOrg()
		assert.deepStrictEqual(result, { organizationId: "org-1" })
	})

	it("falls back to the next org when backend-selected org is locally opted-out", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-1",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [
				{ organizationId: "org-1", name: "Org 1" },
				{ organizationId: "org-2", name: "Org 2" },
				{ organizationId: "org-3", name: "Org 3" },
			],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.withArgs("org-1").returns(false) // opted-out
		isRemoteConfigEnabledStub.withArgs("org-2").returns(false) // opted-out
		isRemoteConfigEnabledStub.withArgs("org-3").returns(true)

		const result = await discoverRemoteConfigOrg()
		assert.deepStrictEqual(result, { organizationId: "org-3" })
	})

	it("returns undefined when all orgs are locally opted-out", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-1",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [
				{ organizationId: "org-1", name: "Org 1" },
				{ organizationId: "org-2", name: "Org 2" },
			],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.returns(false) // all opted-out

		const result = await discoverRemoteConfigOrg()
		assert.strictEqual(result, undefined)
	})

	it("handles fallback org selection and still respects local opt-out", async () => {
		// Backend selected org-2 as fallback (user's active org has no remote config)
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-2",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [
				{ organizationId: "org-2", name: "Enterprise Org" },
				{ organizationId: "org-3", name: "Another Org" },
			],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.withArgs("org-2").returns(false) // opted-out locally
		isRemoteConfigEnabledStub.withArgs("org-3").returns(true)

		const result = await discoverRemoteConfigOrg()
		assert.deepStrictEqual(result, { organizationId: "org-3" })
	})

	it("returns the backend-selected fallback org if locally allowed", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-2",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [{ organizationId: "org-2", name: "Enterprise Org" }],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.withArgs("org-2").returns(true)

		const result = await discoverRemoteConfigOrg()
		assert.deepStrictEqual(result, { organizationId: "org-2" })
	})

	it("handles empty organizations list gracefully", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-1",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.withArgs("org-1").returns(false)

		const result = await discoverRemoteConfigOrg()
		assert.strictEqual(result, undefined)
	})

	it("only checks isRemoteConfigEnabled for the backend-selected org first", async () => {
		fetchUserRemoteConfigStub.resolves({
			organizationId: "org-1",
			value: '{"version":"v1"}',
			enabled: true,
			organizations: [
				{ organizationId: "org-1", name: "Org 1" },
				{ organizationId: "org-2", name: "Org 2" },
			],
		} satisfies UserRemoteConfigDiscoveryResponse)
		isRemoteConfigEnabledStub.withArgs("org-1").returns(true)

		await discoverRemoteConfigOrg()

		// Should only check org-1 since it was allowed
		assert.strictEqual(isRemoteConfigEnabledStub.callCount, 1)
		assert.strictEqual(isRemoteConfigEnabledStub.firstCall.args[0], "org-1")
	})
})
