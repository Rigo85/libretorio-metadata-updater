import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { ArchiveRecord } from "(src)/models/interfaces/Archive";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("ArchiveRepository");

export class ArchiveRepository {
	private static instance: ArchiveRepository;

	private constructor() {
	}

	public static getInstance(): ArchiveRepository {
		if (!ArchiveRepository.instance) {
			ArchiveRepository.instance = new ArchiveRepository();
		}
		return ArchiveRepository.instance;
	}

	async getArchivesNeedingMetadata(excludeIds: number[], limit: number): Promise<ArchiveRecord[]> {
		logger.info({excludeCount: excludeIds.length, limit}, "Querying archives needing metadata");

		try {
			let query: string;
			let values: any[];

			if (excludeIds.length > 0) {
				query = `
					SELECT id, name, "coverId", "localDetails", "webDetails", "customDetails"
					FROM archive
					WHERE "webDetails" IS NULL
					  AND "customDetails" = false
					  AND id NOT IN (${excludeIds.map((_, i) => `$${i + 1}`).join(", ")})
					ORDER BY id ASC
					LIMIT $${excludeIds.length + 1}
				`;
				values = [...excludeIds, limit];
			} else {
				query = `
					SELECT id, name, "coverId", "localDetails", "webDetails", "customDetails"
					FROM archive
					WHERE "webDetails" IS NULL
					  AND "customDetails" = false
					ORDER BY id ASC
					LIMIT $1
				`;
				values = [limit];
			}

			const rows = await PostgresAdapter.getInstance().query(query, values);
			return rows || [];
		} catch (error) {
			logger.error({err: error}, "Error querying archives needing metadata");
			return [];
		}
	}

	async updateWebDetails(archiveId: number, webDetails: string): Promise<boolean> {
		logger.info({archiveId}, "Updating webDetails");

		try {
			const query = `
				UPDATE archive
				SET "webDetails" = $1
				WHERE id = $2
				  AND "customDetails" = false
				RETURNING id
			`;
			const values = [webDetails, archiveId];
			const rows = await PostgresAdapter.getInstance().query(query, values);

			if (!rows?.length) {
				logger.warn({archiveId}, "Update returned no rows — archive may have customDetails=true");
				return false;
			}

			return true;
		} catch (error) {
			logger.error({archiveId, err: error}, "Error updating webDetails");
			return false;
		}
	}
}
