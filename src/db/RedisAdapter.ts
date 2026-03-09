import { createClient, RedisClientType } from "redis";
import { config } from "(src)/config/configuration";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("RedisAdapter");

class RedisAdapter {
	private static instance?: RedisAdapter = undefined;
	private client?: RedisClientType = undefined;
	private initPromise?: Promise<RedisClientType> = undefined;

	private constructor() {
	}

	public static getInstance(): RedisAdapter {
		if (!RedisAdapter.instance) {
			RedisAdapter.instance = new RedisAdapter();
		}
		return RedisAdapter.instance;
	}

	public initialize(): Promise<RedisClientType> {
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = new Promise<RedisClientType>((resolve, reject) => {
			try {
				this.client = createClient({
					url: config.production.db.redisUrl
				});

				this.client.on("error", (err: any) => {
					logger.error({err}, "Redis connection error");
				});

				this.client.on("connect", () => {
					logger.info("Redis connection established");
				});

				this.client.connect().then(() => {
					logger.info("Redis client connected successfully");
					resolve(this.client!);
				}).catch((err: any) => {
					logger.error({err}, "Error connecting to Redis");
					this.client = undefined;
					this.initPromise = undefined;
					reject(err);
				});
			} catch (err) {
				logger.error({err}, "Error creating Redis client");
				this.client = undefined;
				this.initPromise = undefined;
				reject(err);
			}
		});

		return this.initPromise;
	}

	public getClient(): RedisClientType | undefined {
		return this.client;
	}

	public async disconnect(): Promise<void> {
		if (this.client) {
			await this.client.quit();
			this.client = undefined;
			this.initPromise = undefined;
			logger.info("Redis connection closed");
		}
	}
}

export default RedisAdapter.getInstance();
