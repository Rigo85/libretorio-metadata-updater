import { Pool, PoolClient } from "pg";
import { config } from "(src)/config/configuration";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("PostgresAdapter");

if (!config.production.db.databaseUrl) {
	throw new Error("The environment variable 'DATABASE_URL' is not defined.");
}

export class PostgresAdapter {
	private static instance: PostgresAdapter;
	private readonly _pool: Pool;
	private metadataClient?: PoolClient;

	private constructor() {
		this._pool = new Pool({
			connectionString: config.production.db.databaseUrl,
			connectionTimeoutMillis: 10000,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			statement_timeout: 30000,
			ssl: false
		});
	}

	public static getInstance(): PostgresAdapter {
		if (!PostgresAdapter.instance) {
			PostgresAdapter.instance = new PostgresAdapter();
		}
		return PostgresAdapter.instance;
	}

	public async query(query: string, values: any[]): Promise<any> {
		try {
			const {rows} = await (this.metadataClient ?? this._pool).query(query, values);
			return rows;
		} catch (error) {
			logger.error({err: error}, "Query failed");
			throw error;
		}
	}

	async acquireMetadataLock(): Promise<() => Promise<void>> {
		const client = await this._pool.connect();
		client.on("error", () => logger.error("Metadata lock connection lost; pending SQL will fail closed"));
		try {
			const result = await client.query("SELECT pg_try_advisory_lock(1279873620, 1296389185) AS locked");
			if (!result.rows[0].locked) throw new Error("Another metadata run holds the lock");
		} catch (error) {
			client.release(); throw error;
		}
		this.metadataClient = client;
		return async () => {
			try {
				await client.query("SELECT pg_advisory_unlock(1279873620, 1296389185)");
			} finally {
				this.metadataClient = undefined; client.release(true);
			}
		};
	}

	public async disconnect(): Promise<void> {
		logger.info("Disconnecting from database...");
		try {
			await this._pool.end();
			logger.info("Database connections closed successfully");
		} catch (error) {
			logger.error({err: error}, "Error closing database connections");
		}
	}
}
