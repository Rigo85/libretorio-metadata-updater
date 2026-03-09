import RedisAdapter from "(src)/db/RedisAdapter";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("RequestTracker");

const KEY_PREFIX = "meta-updater:usage";

export class RequestTracker {
	private readonly dailyLimit: number;
	private readonly keys: string[];

	constructor(keys: string[], dailyLimit: number) {
		this.keys = keys;
		this.dailyLimit = dailyLimit;
		logger.info({keyCount: keys.length, dailyLimit}, "RequestTracker initialized");
	}

	async getRemainingForKey(key: string): Promise<number> {
		const used = await this.getUsedForKey(key);
		return this.dailyLimit - used;
	}

	async consumeRequest(key: string): Promise<void> {
		const client = RedisAdapter.getClient();
		if (!client) {
			logger.error("Redis client not available — cannot track request");
			return;
		}

		const redisKey = this.buildRedisKey(key);
		const newCount = await client.incr(redisKey);

		// Set TTL only on first increment (when key was just created)
		if (newCount === 1) {
			const ttl = this.secondsUntilPacificMidnight();
			await client.expire(redisKey, ttl);
			logger.info({redisKey, ttlSeconds: ttl}, "Redis key created with TTL until Pacific midnight");
		}
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
			if (await this.getRemainingForKey(key) > 0) {
				return key;
			}
		}
		return undefined;
	}

	async getEffectiveLimit(): Promise<number> {
		let total = 0;
		for (const key of this.keys) {
			const remaining = await this.getRemainingForKey(key);
			total += Math.max(0, remaining - 10);
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
				remaining: this.dailyLimit - used
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

	private buildRedisKey(apiKey: string): string {
		// Use first 8 chars of the API key as identifier + Pacific date
		const dateStr = this.getPacificDateString();
		return `${KEY_PREFIX}:${apiKey.substring(0, 8)}:${dateStr}`;
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
