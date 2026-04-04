import RedisAdapter from "(src)/db/RedisAdapter";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("RequestTracker");

const KEY_PREFIX = "meta-updater:usage";
const COOLDOWN_PREFIX = "meta-updater:cooldown";
const RATE_LIMIT_PREFIX = "meta-updater:rate-limit";

export class RequestTracker {
	private readonly dailyLimit: number;
	private readonly keys: string[];
	private readonly safetyBufferPerKey: number;

	constructor(keys: string[], dailyLimit: number, safetyBufferPerKey: number) {
		this.keys = keys;
		this.dailyLimit = dailyLimit;
		this.safetyBufferPerKey = safetyBufferPerKey;
		logger.info({keyCount: keys.length, dailyLimit, safetyBufferPerKey}, "RequestTracker initialized");
	}

	async getRemainingForKey(key: string): Promise<number> {
		const used = await this.getUsedForKey(key);
		return Math.max(0, this.dailyLimit - used);
	}

	async consumeRequest(key: string): Promise<number> {
		const client = RedisAdapter.getClient();
		if (!client) {
			logger.error("Redis client not available — cannot track request");
			return 0;
		}

		const redisKey = this.buildRedisKey(key);
		const newCount = await client.incr(redisKey);

		// Set TTL only on first increment (when key was just created)
		if (newCount === 1) {
			const ttl = this.secondsUntilPacificMidnight();
			await client.expire(redisKey, ttl);
			logger.info({redisKey, ttlSeconds: ttl}, "Redis key created with TTL until Pacific midnight");
		}

		return newCount;
	}

	async markKeyExhausted(key: string, reason: string): Promise<void> {
		const client = RedisAdapter.getClient();
		if (!client) {
			logger.error({reason}, "Redis client not available — cannot mark key as exhausted");
			return;
		}

		const redisKey = this.buildRedisKey(key);
		const ttl = this.secondsUntilPacificMidnight();
		await client.set(redisKey, String(this.dailyLimit));
		await client.expire(redisKey, ttl);
		logger.warn({redisKey, reason, ttlSeconds: ttl}, "Google API key marked as exhausted for the day");
	}

	async registerRateLimitHit(key: string): Promise<number> {
		const client = RedisAdapter.getClient();
		if (!client) {
			logger.error("Redis client not available — cannot register rate-limit hit");
			return 30;
		}

		const rateLimitKey = this.buildRateLimitKey(key);
		const hits = await client.incr(rateLimitKey);
		if (hits === 1) {
			await client.expire(rateLimitKey, this.secondsUntilPacificMidnight());
		}

		const cooldownSeconds = Math.min(900, 30 * (2 ** Math.min(hits - 1, 4)));
		const cooldownKey = this.buildCooldownKey(key);
		await client.set(cooldownKey, String(Date.now()));
		await client.expire(cooldownKey, cooldownSeconds);

		logger.warn({
			apiKey: `${key.substring(0, 8)}...`,
			hits,
			cooldownSeconds
		}, "Google API key entered cooldown after rate limit");

		return cooldownSeconds;
	}

	async getTotalRemaining(): Promise<number> {
		let total = 0;
		for (const key of this.keys) {
			total += await this.getRemainingForKey(key);
		}
		return total;
	}

	async getAvailableKey(): Promise<string | undefined> {
		for (const key of this.keys) {
			if (await this.getRemainingForKey(key) > 0 && await this.getCooldownRemainingSeconds(key) === 0) {
				return key;
			}
		}
		return undefined;
	}

	async getWaitTimeUntilAvailableKeyMs(): Promise<number | undefined> {
		let minCooldownSeconds: number | undefined;

		for (const key of this.keys) {
			if (await this.getRemainingForKey(key) <= 0) {
				continue;
			}

			const cooldownSeconds = await this.getCooldownRemainingSeconds(key);
			if (cooldownSeconds === 0) {
				return 0;
			}

			if (minCooldownSeconds === undefined || cooldownSeconds < minCooldownSeconds) {
				minCooldownSeconds = cooldownSeconds;
			}
		}

		if (minCooldownSeconds === undefined) {
			return undefined;
		}

		return minCooldownSeconds * 1000;
	}

	async getEffectiveLimit(): Promise<number> {
		let total = 0;
		for (const key of this.keys) {
			const remaining = await this.getRemainingForKey(key);
			total += Math.max(0, remaining - this.safetyBufferPerKey);
		}
		return total;
	}

	hasKeys(): boolean {
		return this.keys.length > 0;
	}

	async getUsageSummary(): Promise<{key: string; used: number; remaining: number}[]> {
		const summary = [];
		for (const key of this.keys) {
			const used = await this.getUsedForKey(key);
			summary.push({
				key: `${key.substring(0, 8)}...`,
				used,
				remaining: Math.max(0, this.dailyLimit - used)
			});
		}
		return summary;
	}

	private async getUsedForKey(key: string): Promise<number> {
		const client = RedisAdapter.getClient();
		if (!client) {
			return 0;
		}

		const redisKey = this.buildRedisKey(key);
		const val = await client.get(redisKey);
		return val ? parseInt(val, 10) : 0;
	}

	private async getCooldownRemainingSeconds(key: string): Promise<number> {
		const client = RedisAdapter.getClient();
		if (!client) {
			return 0;
		}

		const cooldownKey = this.buildCooldownKey(key);
		const ttl = await client.ttl(cooldownKey);
		return ttl > 0 ? ttl : 0;
	}

	private buildRedisKey(apiKey: string): string {
		// Use first 8 chars of the API key as identifier + Pacific date
		const dateStr = this.getPacificDateString();
		return `${KEY_PREFIX}:${apiKey.substring(0, 8)}:${dateStr}`;
	}

	private buildCooldownKey(apiKey: string): string {
		const dateStr = this.getPacificDateString();
		return `${COOLDOWN_PREFIX}:${apiKey.substring(0, 8)}:${dateStr}`;
	}

	private buildRateLimitKey(apiKey: string): string {
		const dateStr = this.getPacificDateString();
		return `${RATE_LIMIT_PREFIX}:${apiKey.substring(0, 8)}:${dateStr}`;
	}

	private getPacificDateString(): string {
		return new Date().toLocaleDateString("en-CA", {timeZone: "America/Los_Angeles"});
	}

	private secondsUntilPacificMidnight(): number {
		const nowStr = new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"});
		const nowPacific = new Date(nowStr);
		const midnightPacific = new Date(nowStr);
		midnightPacific.setHours(24, 0, 0, 0);
		const seconds = Math.floor((midnightPacific.getTime() - nowPacific.getTime()) / 1000);
		// Minimum 60 seconds to avoid edge cases right at midnight
		return Math.max(60, seconds);
	}
}
