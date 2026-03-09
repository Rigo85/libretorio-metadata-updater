import { config } from "(src)/config/configuration";
import { ArchiveRepository } from "(src)/repositories/ArchiveRepository";
import { MetadataLookupControlRepository } from "(src)/repositories/MetadataLookupControlRepository";
import { OpenLibraryService } from "(src)/services/OpenLibraryService";
import { GoogleBooksService } from "(src)/services/GoogleBooksService";
import { CoverService } from "(src)/services/CoverService";
import { RequestTracker } from "(src)/services/RequestTracker";
import { ArchiveRecord } from "(src)/models/interfaces/Archive";
import { cleanFilename, cleanTitle } from "(src)/helpers/fileUtils";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("MetadataUpdaterService");

export class MetadataUpdaterService {
	private static instance: MetadataUpdaterService;
	private running = false;

	private constructor() {
	}

	public static getInstance(): MetadataUpdaterService {
		if (!MetadataUpdaterService.instance) {
			MetadataUpdaterService.instance = new MetadataUpdaterService();
		}
		return MetadataUpdaterService.instance;
	}

	async runUpdate(): Promise<void> {
		if (this.running) {
			logger.warn("Metadata update already running, skipping");
			return;
		}

		this.running = true;
		const startTime = Date.now();
		logger.info("=== Metadata update started ===");

		try {
			const {maxAttempts, googleApiKeys, dailyRequestLimit, requestDelayMs, canUseOpenLibrary} = config.production.metadata;

			// Ensure control table exists
			await MetadataLookupControlRepository.getInstance().ensureTable();

			// Build request tracker for Google Books keys
			const tracker = new RequestTracker(googleApiKeys, dailyRequestLimit);

			// Get archive IDs that have exhausted their retry attempts
			const exhaustedIds = await MetadataLookupControlRepository.getInstance()
				.getExhaustedArchiveIds(maxAttempts);
			logger.info({exhaustedCount: exhaustedIds.length, maxAttempts}, "Exhausted archives filtered");

			// Calculate how many archives to fetch.
			// OL requests don't count toward Google's limit, but we use the Google limit
			// as our batch ceiling since some archives will fall through to Google.
			const effectiveLimit = tracker.hasKeys()
				? await tracker.getEffectiveLimit()
				: 500; // If no Google keys, still process up to 500 via OL only
			logger.info({effectiveLimit, hasGoogleKeys: tracker.hasKeys()}, "Effective limit calculated");

			// Fetch archives needing metadata
			const archives = await ArchiveRepository.getInstance()
				.getArchivesNeedingMetadata(exhaustedIds, effectiveLimit);
			logger.info({count: archives.length}, "Archives to process");

			if (archives.length === 0) {
				logger.info("No archives need metadata — done");
				return;
			}

			let olMatches = 0;
			let googleMatches = 0;
			let notFound = 0;
			let coverDownloads = 0;

			for (let i = 0; i < archives.length; i++) {
				const archive = archives[i];
				const progress = `${i + 1}/${archives.length}`;
				const searchTitle = this.getSearchTitle(archive);

				logger.info({progress, archiveId: archive.id, searchTitle, name: archive.name}, "Processing archive");

				// Phase 1: Try OpenLibrary
				let olHadError = false;
				if (canUseOpenLibrary) {
					const olResult = await OpenLibraryService.getInstance().searchByTitle(searchTitle);

					if (olResult === "error") {
						olHadError = true;
					} else if (olResult) {
						const webDetailsJson = JSON.stringify(olResult.webDetails);
						const updated = await ArchiveRepository.getInstance()
							.updateWebDetails(archive.id, webDetailsJson);

						if (updated) {
							olMatches++;
							logger.info({archiveId: archive.id, title: olResult.webDetails.title}, "OL metadata saved");

							if (olResult.coverUrl) {
								const success = await CoverService.getInstance()
									.downloadAndConvertCover(olResult.coverUrl, archive.coverId);
								if (success) coverDownloads++;
							}

							await this.delay(requestDelayMs);
							continue;
						}
					}

					await this.delay(requestDelayMs);
				}

				// Phase 2: Try Google Books (if OL returned nothing or disabled)
				let googleHadError = false;
				if (tracker.hasKeys() && await tracker.getAvailableKey()) {
					const googleResult = await GoogleBooksService.getInstance()
						.searchByTitle(searchTitle, tracker);

					if (googleResult === "error") {
						googleHadError = true;
					} else if (googleResult) {
						const webDetailsJson = JSON.stringify(googleResult.webDetails);
						const updated = await ArchiveRepository.getInstance()
							.updateWebDetails(archive.id, webDetailsJson);

						if (updated) {
							googleMatches++;
							logger.info({archiveId: archive.id, title: googleResult.webDetails.title}, "Google Books metadata saved");

							if (googleResult.coverUrl) {
								const success = await CoverService.getInstance()
									.downloadAndConvertCover(googleResult.coverUrl, archive.coverId);
								if (success) coverDownloads++;
							}

							await this.delay(requestDelayMs);
							continue;
						}
					}

					await this.delay(requestDelayMs);
				} else if (tracker.hasKeys()) {
					logger.warn("All Google API keys exhausted — skipping remaining Google lookups");
				}

				// Only increment attempts when both APIs responded successfully but found nothing.
				// API errors (429, 503, network failures) should NOT count against the archive.
				if (olHadError || googleHadError) {
					logger.info({archiveId: archive.id, searchTitle, olHadError, googleHadError}, "Skipping attempt increment — API error occurred");
				} else {
					notFound++;
					await MetadataLookupControlRepository.getInstance().incrementAttempts(archive.id);
					const attempts = await MetadataLookupControlRepository.getInstance().getAttempts(archive.id);
					logger.info({archiveId: archive.id, attempts, maxAttempts, searchTitle}, "No metadata found — attempt recorded");
				}
			}

			// Summary
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			logger.info({
				processed: archives.length,
				olMatches,
				googleMatches,
				notFound,
				coverDownloads,
				elapsedSeconds: elapsed,
				googleUsage: tracker.hasKeys() ? await tracker.getUsageSummary() : "no keys"
			}, "=== Metadata update completed ===");
		} catch (error) {
			logger.error({err: error}, "Metadata update failed");
		} finally {
			this.running = false;
		}
	}

	private getSearchTitle(archive: ArchiveRecord): string {
		// Try calibre title from localDetails first
		if (archive.localDetails) {
			try {
				const local = JSON.parse(archive.localDetails);
				if (local.title && local.title.trim()) {
					return cleanTitle(local.title);
				}
			} catch {
				// localDetails is not valid JSON — fall through to filename
			}
		}

		// Fallback to cleaned filename
		return cleanFilename(archive.name);
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
