import RedisAdapter from "(src)/db/RedisAdapter";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";

const cursorKey = "meta-updater:catalogue-cursor:v1";

// The cursor is traversal state, never an attempt count. Replaying after a crash is safe.
export class MetadataRunState {
	afterId = 0;
	private unlock?: () => Promise<void>;

	constructor(private persist: boolean) {}

	async open(): Promise<void> {
		this.unlock = await PostgresAdapter.getInstance().acquireMetadataLock();
		try {
			if (this.persist) {
				const value = await this.client().get(cursorKey);
				if (value != undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("Invalid metadata cursor");
				this.afterId = Number(value ?? 0);
			}
		} catch (error) {
			await this.close(); throw error;
		}
	}

	async advance(id: number): Promise<void> {
		if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid archive cursor");
		if (this.persist) await this.client().set(cursorKey, String(id));
		this.afterId = id;
	}

	async close(): Promise<void> {
		const unlock = this.unlock;
		this.unlock = undefined;
		if (unlock) await unlock();
	}

	private client() {
		const client = RedisAdapter.getClient();
		if (!client?.isReady) throw new Error("Redis unavailable: traversal checkpoint blocked");
		return client;
	}
}
