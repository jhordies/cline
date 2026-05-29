import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import "should"
import Anthropic from "@anthropic-ai/sdk"
import { anthropicModels } from "@shared/api"
import { ANTHROPIC_FAST_MODE_BETA, AnthropicHandler } from "../anthropic"

describe("AnthropicHandler", () => {
	afterEach(() => {
		sinon.restore()
	})

	const createAsyncIterable = (data: readonly unknown[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	describe("getModel", () => {
		it("should return the fast mode model when configured", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:fast",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-4-6:fast")
			result.info.should.deepEqual(anthropicModels["claude-opus-4-6:fast"])
		})

		it("should return the 1m fast mode model when configured", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:1m:fast",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-4-6:1m:fast")
			result.info.should.deepEqual(anthropicModels["claude-opus-4-6:1m:fast"])
		})
	})

	describe("ensureClient / baseURL normalization", () => {
		it("should strip trailing /v1 from anthropicBaseUrl", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				anthropicBaseUrl: "http://127.0.0.1:61823/v1",
			})
			const spy = sinon.spy(Anthropic.prototype, "constructor" as keyof Anthropic)
			// Access private client by casting
			const client = (handler as unknown as { ensureClient: () => Anthropic }).ensureClient()
			client.baseURL.should.equal("http://127.0.0.1:61823")
			spy.restore()
		})

		it("should strip trailing /v1/ (with trailing slash) from anthropicBaseUrl", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				anthropicBaseUrl: "http://127.0.0.1:61823/v1/",
			})
			const client = (handler as unknown as { ensureClient: () => Anthropic }).ensureClient()
			client.baseURL.should.equal("http://127.0.0.1:61823")
		})

		it("should leave a plain host:port baseUrl unchanged", () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				anthropicBaseUrl: "http://127.0.0.1:61823",
			})
			const client = (handler as unknown as { ensureClient: () => Anthropic }).ensureClient()
			client.baseURL.should.equal("http://127.0.0.1:61823")
		})

		it("should use the default Anthropic baseURL when no anthropicBaseUrl is set", () => {
			const handler = new AnthropicHandler({ apiKey: "test-api-key" })
			const client = (handler as unknown as { ensureClient: () => Anthropic }).ensureClient()
			// SDK default is https://api.anthropic.com
			client.baseURL.should.startWith("https://api.anthropic.com")
		})
	})

	describe("createMessage", () => {
		it("should route fast mode requests through the beta messages API", async () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:fast",
			})

			const standardCreate = sinon.stub().resolves(createAsyncIterable())
			const betaCreate = sinon.stub().callsFake(function (this: { _client?: object }, _params: unknown) {
				should.exist(this._client)
				return Promise.resolve(createAsyncIterable())
			})

			sinon.stub(handler as unknown as { ensureClient: () => unknown }, "ensureClient").returns({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: betaCreate,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			sinon.assert.notCalled(standardCreate)
			sinon.assert.calledOnce(betaCreate)
			sinon.assert.calledWithMatch(betaCreate, {
				model: "claude-opus-4-6",
				betas: [ANTHROPIC_FAST_MODE_BETA],
				speed: "fast",
				stream: true,
			})
		})

		it("should include the 1m beta when routing 1m fast mode requests through the beta messages API", async () => {
			const handler = new AnthropicHandler({
				apiKey: "test-api-key",
				apiModelId: "claude-opus-4-6:1m:fast",
			})

			const standardCreate = sinon.stub().resolves(createAsyncIterable())
			const betaCreate = sinon.stub().callsFake(function (this: { _client?: object }, _params: unknown) {
				should.exist(this._client)
				return Promise.resolve(createAsyncIterable())
			})

			sinon.stub(handler as unknown as { ensureClient: () => unknown }, "ensureClient").returns({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: betaCreate,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			sinon.assert.notCalled(standardCreate)
			sinon.assert.calledOnce(betaCreate)
			sinon.assert.calledWithMatch(betaCreate, {
				model: "claude-opus-4-6",
				betas: [ANTHROPIC_FAST_MODE_BETA, "context-1m-2025-08-07"],
				speed: "fast",
				stream: true,
			})
		})
	})
})
