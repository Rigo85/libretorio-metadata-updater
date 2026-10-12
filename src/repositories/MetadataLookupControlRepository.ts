import { PostgresAdapter } from "(src)/db/PostgresAdapter";

export class MetadataLookupControlRepository {
	private static instance: MetadataLookupControlRepository;

	public static getInstance(): MetadataLookupControlRepository {
		return MetadataLookupControlRepository.instance ??= new MetadataLookupControlRepository();
	}

	async ensureTable(): Promise<void> {
		await PostgresAdapter.getInstance().query(`
			CREATE TABLE IF NOT EXISTS metadata_lookup_control (
				id SERIAL PRIMARY KEY,
				archive_id INTEGER NOT NULL UNIQUE,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
				CONSTRAINT fk_metadata_archive FOREIGN KEY (archive_id)
					REFERENCES archive(id) ON DELETE CASCADE
			)
		`, []);
	}

	async incrementAttempts(archiveId: number, maxAttempts: number, sourceFingerprint?: string): Promise<number | undefined> {
		const rows = await PostgresAdapter.getInstance().query(`
			INSERT INTO metadata_lookup_control (archive_id, attempts, last_attempt_at)
			SELECT id, 1, NOW() FROM archive
			WHERE id = $1 AND "webDetails" IS NULL AND "customDetails" = false
			  AND ($3::text IS NULL OR md5(ROW(name,"coverId","localDetails")::text) = $3)
			ON CONFLICT (archive_id) DO UPDATE SET
				attempts = metadata_lookup_control.attempts + 1,
				last_attempt_at = NOW()
			WHERE metadata_lookup_control.attempts < $2
			RETURNING attempts
		`, [archiveId, maxAttempts, sourceFingerprint]);
		return rows[0]?.attempts;
	}
}
