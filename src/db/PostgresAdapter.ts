import { Pool } from "pg";
import { config } from "(src)/config/configuration";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("PostgresAdapter");

if (!config.production.db.databaseUrl) {
	throw new Error("The environment variable 'DATABASE_URL' is not defined.");
}

export class PostgresAdapter {
	private static instance: PostgresAdapter;
	private readonly _pool: Pool;

	private constructor() {
		this._pool = new Pool({
			connectionString: config.production.db.databaseUrl,
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
			const {rows} = await this._pool.query(query, values);
			return rows;
		} catch (error) {
			logger.error({query, values, err: error}, "Query failed");
			return undefined;
		}
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
