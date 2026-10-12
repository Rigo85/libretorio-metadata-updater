import RedisAdapter from "(src)/db/RedisAdapter";
import moment from "moment-timezone";
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
		// Preserve existing counter identities; shared prefixes conservatively share their budget.
		this.keys = keys.filter((key, index) => keys.findIndex(other => other.slice(0, 8) === key.slice(0, 8)) === index);
		if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1
			|| !Number.isSafeInteger(safetyBufferPerKey) || safetyBufferPerKey < 0 || safetyBufferPerKey >= dailyLimit) {
			throw new Error("Invalid Google daily limit or safety buffer");
		}
		this.dailyLimit = dailyLimit;
		this.safetyBufferPerKey = safetyBufferPerKey;
		logger.info({keyCount: keys.length, dailyLimit, safetyBufferPerKey}, "RequestTracker initialized");
	}

	async getRemainingForKey(key: string): Promise<number> {
		const used = await this.getUsedForKey(key);
		return Math.max(0, this.dailyLimit - used);
	}

	async consumeRequest(key: string): Promise<boolean> {
		if (!this.keys.includes(key)) throw new Error("Unknown Google API key");
		const client = this.requireClient();
		// Reservation precedes EVERY HTTP attempt, including retries. Existing counters are not reset.
		const now = moment.tz("America/Los_Angeles");
		const date = now.format("YYYY-MM-DD");
		const reserved = await client.eval(`
			local raw = redis.call('GET', KEYS[1])
			if raw and not string.match(raw, '^%d+$') then return redis.error_reply('Invalid usage counter') end
			local used = tonumber(raw or '0')
			if used >= tonumber(ARGV[1]) or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
			redis.call('INCR', KEYS[1])
			redis.call('EXPIRE', KEYS[1], ARGV[2])
			return 1
		`, {keys: [`${KEY_PREFIX}:${key.substring(0, 8)}:${date}`, `${COOLDOWN_PREFIX}:${key.substring(0, 8)}:${date}`],
			arguments: [String(this.dailyLimit - this.safetyBufferPerKey), String(this.secondsUntilPacificMidnight(now))]});
		return reserved === 1;
	}

	async markKeyExhausted(key: string, reason: string): Promise<void> {
		const client = this.requireClient();

		const redisKey = this.buildRedisKey(key);
		const ttl = this.secondsUntilPacificMidnight();
		await client.setEx(redisKey, ttl, String(this.dailyLimit));
		logger.warn({redisKey, reason, ttlSeconds: ttl}, "Google API key marked as exhausted for the day");
	}

	async registerRateLimitHit(key: string): Promise<number> {
		const client = this.requireClient();

		const rateLimitKey = this.buildRateLimitKey(key);
		const hits = await client.incr(rateLimitKey);
		if (hits === 1) {
			await client.expire(rateLimitKey, this.secondsUntilPacificMidnight());
		}

		const cooldownSeconds = Math.min(900, 30 * (2 ** Math.min(hits - 1, 4)));
		const cooldownKey = this.buildCooldownKey(key);
		await client.setEx(cooldownKey, cooldownSeconds, String(Date.now()));

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
			if (await this.getRemainingForKey(key) > this.safetyBufferPerKey && await this.getCooldownRemainingSeconds(key) === 0) {
				return key;
			}
		}
		return undefined;
	}

	async getWaitTimeUntilAvailableKeyMs(): Promise<number | undefined> {
		let minCooldownSeconds: number | undefined;

		for (const key of this.keys) {
			if (await this.getRemainingForKey(key) <= this.safetyBufferPerKey) {
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
		const client = this.requireClient();

		const redisKey = this.buildRedisKey(key);
		const val = await client.get(redisKey);
		if (val == undefined) return 0;
		if (!/^\d+$/.test(val) || !Number.isSafeInteger(Number(val))) throw new Error("Invalid Google usage counter");
		return Number(val);
	}

	private async getCooldownRemainingSeconds(key: string): Promise<number> {
		const client = this.requireClient();

		const cooldownKey = this.buildCooldownKey(key);
		const ttl = await client.ttl(cooldownKey);
		if (ttl === -1) throw new Error("Google cooldown has no expiry");
		return ttl >= 0 ? Math.max(1, ttl) : 0;
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

	private secondsUntilPacificMidnight(now = moment.tz("America/Los_Angeles")): number {
		return Math.max(1, Math.ceil(now.clone().add(1, "day").startOf("day").diff(now) / 1000));
	}

	private requireClient() {
		const client = RedisAdapter.getClient();
		if (!client?.isReady) throw new Error("Redis unavailable: Google requests are blocked");
		return client;
	}
}
