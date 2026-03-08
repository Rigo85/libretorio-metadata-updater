import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("RequestTracker");

export class RequestTracker {
	private usage: Map<string, number> = new Map();
	private readonly dailyLimit: number;
	private readonly keys: string[];

	constructor(keys: string[], dailyLimit: number) {
		this.keys = keys;
		this.dailyLimit = dailyLimit;
		for (const key of keys) {
			this.usage.set(key, 0);
		}
		logger.info({keyCount: keys.length, dailyLimit}, "RequestTracker initialized");
	}

	getRemainingForKey(key: string): number {
		return this.dailyLimit - (this.usage.get(key) || 0);
	}

	consumeRequest(key: string): void {
		const current = this.usage.get(key) || 0;
		this.usage.set(key, current + 1);
	}

	getTotalRemaining(): number {
		let total = 0;
		for (const key of this.keys) {
			total += this.getRemainingForKey(key);
		}
		return total;
	}

	getAvailableKey(): string | undefined {
		for (const key of this.keys) {
			if (this.getRemainingForKey(key) > 0) {
				return key;
			}
		}
		return undefined;
	}

	// Effective limit for the run: (dailyLimit - 10) per key, floored at 0.
	getEffectiveLimit(): number {
		const perKey = Math.max(0, this.dailyLimit - 10);
		return perKey * this.keys.length;
	}

	hasKeys(): boolean {
		return this.keys.length > 0;
	}

	getUsageSummary(): {key: string; used: number; remaining: number}[] {
		return this.keys.map(key => ({
			key: `${key.substring(0, 8)}...`,
			used: this.usage.get(key) || 0,
			remaining: this.getRemainingForKey(key)
		}));
	}
}
