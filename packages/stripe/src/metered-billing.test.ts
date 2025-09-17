import { betterAuth, type User } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthClient } from "better-auth/client";
import { setCookieToHeader } from "better-auth/cookies";
import { bearer } from "better-auth/plugins";
import Stripe from "stripe";
import { vi } from "vitest";
import { stripe } from ".";
import { stripeClient } from "./client";
import type { StripeOptions, Subscription } from "./types";
import { expect, describe, it, beforeEach } from "vitest";

describe("metered billing", async () => {
	const mockStripe = {
		prices: {
			list: vi.fn().mockResolvedValue({ data: [{ id: "price_lookup_123" }] }),
		},
		customers: {
			create: vi.fn().mockResolvedValue({ id: "cus_mock123" }),
		},
		checkout: {
			sessions: {
				create: vi.fn().mockResolvedValue({
					url: "https://checkout.stripe.com/mock",
					id: "",
				}),
			},
		},
		billingPortal: {
			sessions: {
				create: vi
					.fn()
					.mockResolvedValue({ url: "https://billing.stripe.com/mock" }),
			},
		},
		subscriptions: {
			retrieve: vi.fn(),
			list: vi.fn().mockResolvedValue({ data: [] }),
			update: vi.fn(),
		},
		webhooks: {
			constructEventAsync: vi.fn(),
		},
	};

	const _stripe = mockStripe as unknown as Stripe;
	const data = {
		user: [],
		session: [],
		verification: [],
		account: [],
		customer: [],
		subscription: [],
	};
	const memory = memoryAdapter(data);

	const stripeOptions = {
		stripeClient: _stripe,
		stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
		createCustomerOnSignUp: true,
		subscription: {
			enabled: true,
			plans: [
				{
					priceId: "price_metered_123",
					name: "metered-api",
					lookupKey: "metered_lookup_key",
					metered: true,
				},
				{
					priceId: "price_fixed_123",  
					name: "fixed-plan",
					lookupKey: "fixed_lookup_key",
					metered: false,
				},
			],
		},
	} satisfies StripeOptions;

	const auth = betterAuth({
		database: memory,
		baseURL: "http://localhost:3000",
		emailAndPassword: {
			enabled: true,
		},
		plugins: [stripe(stripeOptions)],
	});
	const ctx = await auth.$context;
	const authClient = createAuthClient({
		baseURL: "http://localhost:3000",
		plugins: [
			bearer(),
			stripeClient({
				subscription: true,
			}),
		],
		fetchOptions: {
			customFetchImpl: async (url, init) => {
				return auth.handler(new Request(url, init));
			},
		},
	});

	const testUser = {
		email: "test@email.com",
		password: "password",
		name: "Test User",
	};

	beforeEach(() => {
		data.user = [];
		data.session = [];
		data.verification = [];
		data.account = [];
		data.customer = [];
		data.subscription = [];

		vi.clearAllMocks();
	});

	it("should omit quantity field for metered billing plans", async () => {
		const userRes = await authClient.signUp.email(testUser, {
			throw: true,
		});

		const headers = new Headers();
		await authClient.signIn.email(testUser, {
			throw: true,
			onSuccess: setCookieToHeader(headers),
		});

		const res = await authClient.subscription.upgrade({
			plan: "metered-api",
			fetchOptions: {
				headers,
			},
		});

		expect(res.data?.url).toBeDefined();
		
		// Verify checkout session was created without quantity
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [
					expect.objectContaining({
						price: "price_metered_123",
						// quantity should not be present for metered plans
					}),
				],
			}),
			undefined,
		);

		// Ensure quantity is not in line items
		const checkoutCall = mockStripe.checkout.sessions.create.mock.calls[0][0];
		expect(checkoutCall.line_items[0]).not.toHaveProperty('quantity');
	});

	it("should include quantity field for non-metered plans", async () => {
		const userRes = await authClient.signUp.email({
			...testUser,
			email: "fixed@email.com",
		}, {
			throw: true,
		});

		const headers = new Headers();
		await authClient.signIn.email({
			...testUser,
			email: "fixed@email.com", 
		}, {
			throw: true,
			onSuccess: setCookieToHeader(headers),
		});

		const res = await authClient.subscription.upgrade({
			plan: "fixed-plan",
			seats: 3,
			fetchOptions: {
				headers,
			},
		});

		expect(res.data?.url).toBeDefined();
		
		// Verify checkout session was created with quantity
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [
					expect.objectContaining({
						price: "price_fixed_123",
						quantity: 3,
					}),
				],
			}),
			undefined,
		);
	});

	it("should not store seats in database for metered plans", async () => {
		const userRes = await authClient.signUp.email({
			...testUser,
			email: "metered-db@email.com",
		}, {
			throw: true,
		});

		const headers = new Headers();
		await authClient.signIn.email({
			...testUser,
			email: "metered-db@email.com",
		}, {
			throw: true,
			onSuccess: setCookieToHeader(headers),
		});

		await authClient.subscription.upgrade({
			plan: "metered-api",
			seats: 5, // This should be ignored for metered plans
			fetchOptions: {
				headers,
			},
		});

		const subscription = await ctx.adapter.findOne<Subscription>({
			model: "subscription",
			where: [
				{
					field: "referenceId",
					value: userRes.user.id,
				},
			],
		});

		expect(subscription).toMatchObject({
			id: expect.any(String),
			plan: "metered-api",
			referenceId: userRes.user.id,
			stripeCustomerId: expect.any(String),
			status: "incomplete",
		});

		// seats should not be set for metered plans
		expect(subscription?.seats).toBeUndefined();
	});

	it("should allow duplicate metered subscriptions regardless of seats parameter", async () => {
		const userRes = await authClient.signUp.email({
			...testUser,
			email: "duplicate-metered@email.com",
		}, {
			throw: true,
		});

		const headers = new Headers();
		await authClient.signIn.email({
			...testUser,
			email: "duplicate-metered@email.com",
		}, {
			throw: true,
			onSuccess: setCookieToHeader(headers),
		});

		// Create first metered subscription
		await authClient.subscription.upgrade({
			plan: "metered-api",
			seats: 1,
			fetchOptions: {
				headers,
			},
		});

		// Update to active status
		await ctx.adapter.update({
			model: "subscription",
			update: {
				status: "active",
			},
			where: [
				{
					field: "referenceId",
					value: userRes.user.id,
				},
			],
		});

		// Try to create another metered subscription - should not be blocked by seat check
		const upgradeRes = await authClient.subscription.upgrade({
			plan: "metered-api",
			seats: 5, // Different seat count should not matter for metered plans
			fetchOptions: {
				headers,
			},
		});

		// This should be allowed because we ignore seats comparison for metered plans
		expect(upgradeRes.data?.url).toBeDefined();
	});

	it("should handle webhook events for metered plans without storing seats", async () => {
		const { id: testReferenceId } = await ctx.adapter.create({
			model: "user",
			data: {
				email: "webhook-metered@email.com",
			},
		});
		const { id: testSubscriptionId } = await ctx.adapter.create({
			model: "subscription",
			data: {
				referenceId: testReferenceId,
				stripeCustomerId: "cus_mock123",
				status: "incomplete",
				plan: "metered-api",
			},
		});

		const mockCheckoutSessionEvent = {
			type: "checkout.session.completed",
			data: {
				object: {
					mode: "subscription",
					subscription: testSubscriptionId,
					metadata: {
						referenceId: testReferenceId,
						subscriptionId: testSubscriptionId,
					},
				},
			},
		};

		const mockSubscription = {
			id: testSubscriptionId,
			status: "active",
			items: {
				data: [
					{
						price: { id: "price_metered_123" },
						quantity: 1, // This quantity should be ignored
					},
				],
			},
			current_period_start: Math.floor(Date.now() / 1000),
			current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
		};

		const stripeForTest = {
			...stripeOptions.stripeClient,
			subscriptions: {
				...stripeOptions.stripeClient.subscriptions,
				retrieve: vi.fn().mockResolvedValue(mockSubscription),
			},
			webhooks: {
				constructEventAsync: vi
					.fn()
					.mockResolvedValue(mockCheckoutSessionEvent),
			},
		};

		const testOptions = {
			...stripeOptions,
			stripeClient: stripeForTest as unknown as Stripe,
			stripeWebhookSecret: "test_secret",
		};

		const testAuth = betterAuth({
			baseURL: "http://localhost:3000",
			database: memory,
			emailAndPassword: {
				enabled: true,
			},
			plugins: [stripe(testOptions)],
		});

		const testCtx = await testAuth.$context;

		const mockRequest = new Request(
			"http://localhost:3000/api/auth/stripe/webhook",
			{
				method: "POST",
				headers: {
					"stripe-signature": "test_signature",
				},
				body: JSON.stringify(mockCheckoutSessionEvent),
			},
		);

		const response = await testAuth.handler(mockRequest);
		expect(response.status).toBe(200);

		const updatedSubscription = await testCtx.adapter.findOne<Subscription>({
			model: "subscription",
			where: [
				{
					field: "id",
					value: testSubscriptionId,
				},
			],
		});

		expect(updatedSubscription).toMatchObject({
			id: testSubscriptionId,
			status: "active",
			periodStart: expect.any(Date),
			periodEnd: expect.any(Date),
			plan: "metered-api",
		});

		// seats should not be set for metered plans even from webhook
		expect(updatedSubscription?.seats).toBeUndefined();
	});
});