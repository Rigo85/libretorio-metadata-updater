import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("MetadataLookupControlRepository");

export class MetadataLookupControlRepository {
	private static instance: MetadataLookupControlRepository;

	private constructor() {
	}

	public static getInstance(): MetadataLookupControlRepository {
		if (!MetadataLookupControlRepository.instance) {
			MetadataLookupControlRepository.instance = new MetadataLookupControlRepository();
		}
		return MetadataLookupControlRepository.instance;
	}

	async ensureTable(): Promise<void> {
		const query = `
			CREATE TABLE IF NOT EXISTS metadata_lookup_control (
				id SERIAL PRIMARY KEY,
				archive_id INTEGER NOT NULL UNIQUE,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
				CONSTRAINT fk_metadata_archive
					FOREIGN KEY (archive_id)
					REFERENCES archive(id)
					ON DELETE CASCADE
			)
		`;
		await PostgresAdapter.getInstance().query(query, []);
		logger.info("metadata_lookup_control table ensured");
	}

	async getExhaustedArchiveIds(maxAttempts: number): Promise<number[]> {
		try {
			const query = `
				SELECT archive_id
				FROM metadata_lookup_control
				WHERE attempts >= $1
			`;
			const rows = await PostgresAdapter.getInstance().query(query, [maxAttempts]);
			// eslint-disable-next-line @typescript-eslint/naming-convention
			return (rows || []).map((r: {archive_id: number}) => r.archive_id);
		} catch (error) {
			logger.error({err: error}, "Error getting exhausted archive IDs");
			return [];
		}
	}

	async incrementAttempts(archiveId: number): Promise<void> {
		try {
			const query = `
				INSERT INTO metadata_lookup_control (archive_id, attempts, last_attempt_at)
				VALUES ($1, 1, NOW())
				ON CONFLICT (archive_id) DO UPDATE SET
					attempts = metadata_lookup_control.attempts + 1,
					last_attempt_at = NOW()
			`;
			await PostgresAdapter.getInstance().query(query, [archiveId]);
		} catch (error) {
			logger.error({archiveId, err: error}, "Error incrementing attempts");
		}
	}

	async getAttempts(archiveId: number): Promise<number> {
		try {
			const query = `
				SELECT attempts FROM metadata_lookup_control WHERE archive_id = $1
			`;
			const rows = await PostgresAdapter.getInstance().query(query, [archiveId]);
			return rows?.[0]?.attempts ?? 0;
		} catch (error) {
			logger.error({archiveId, err: error}, "Error getting attempts");
			return 0;
		}
	}
}
