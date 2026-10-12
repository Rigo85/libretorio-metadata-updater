import { config } from "(src)/config/configuration";
import { ArchiveRepository } from "(src)/repositories/ArchiveRepository";
import { MetadataLookupControlRepository } from "(src)/repositories/MetadataLookupControlRepository";
import { RecoveryLookupService } from "(src)/services/RecoveryLookupService";
import { MetadataRunState } from "(src)/services/MetadataRunState";
import { CoverService } from "(src)/services/CoverService";
import { RequestTracker } from "(src)/services/RequestTracker";
import { resolveMetadataSearch } from "(src)/helpers/metadataTitle";
import { resolveMetadataAuthor } from "(src)/helpers/metadataCandidate";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("MetadataUpdaterService");

export class MetadataUpdaterService {
	private static instance: MetadataUpdaterService;
	private running = false;

	public static getInstance(): MetadataUpdaterService {
		return MetadataUpdaterService.instance ??= new MetadataUpdaterService();
	}

	async runUpdate(): Promise<void> {
		const settings = config.production.metadata;
		if (settings.mode !== "preview" && settings.mode !== "write") {
			logger.info("Metadata updater paused; no queries or writes");
			return;
		}
		if (this.running) {
			logger.warn("Metadata update already running, skipping");
			return;
		}
		this.running = true;
		const startTime = Date.now();
		const preview = settings.mode === "preview";
		const summary = {processed: 0, olMatches: 0, googleMatches: 0, notFound: 0,
			rejected: 0, deferred: 0, insufficient: 0, insufficientAttempts: 0, invalidTitle: 0, changedMeanwhile: 0, coverDownloads: 0,
			coverFailedOrExisting: 0, httpFailures: 0, limitedLookups: 0, identityUnverified: 0,
			previewMatches: 0, previewNotFound: 0, localCorrections: 0, previewLocalCorrections: 0, requests: 0};
		const gate = {
			available: () => summary.requests < settings.maxRequestsPerRun,
			record: () => {
				if (summary.requests >= settings.maxRequestsPerRun) return false;
				summary.requests++;
				return true;
			}
		};
		let completed = false;
		let runState: MetadataRunState | undefined;
		logger.info({mode: settings.mode, archiveIds: settings.archiveIds,
			maxArchives: settings.maxArchivesPerRun, maxRequests: settings.maxRequestsPerRun}, "=== Metadata update started ===");
		try {
			const {maxAttempts, googleApiKeys, dailyRequestLimit, requestSafetyBufferPerKey,
				requestDelayMs, canUseOpenLibrary, batchSize} = config.production.metadata;
			if (!canUseOpenLibrary && googleApiKeys.length === 0) {
				logger.warn("No metadata providers enabled; attempts are unchanged");
				completed = true;
				return;
			}
			const control = MetadataLookupControlRepository.getInstance();
			const repository = ArchiveRepository.getInstance();
			if (!preview) {
				runState = new MetadataRunState(!settings.archiveIds.length);
				await runState.open();
				await control.ensureTable();
			}
			const tracker = new RequestTracker(googleApiKeys, dailyRequestLimit, requestSafetyBufferPerKey);
			// Google quota must not prevent enabled OpenLibrary from serving the same run.
			const effectiveLimit = settings.maxArchivesPerRun;
			const lookupService = new RecoveryLookupService(tracker, gate, {requestDelayMs, canUseOpenLibrary,
				diagnostics: settings.archiveIds.length > 0});
			let afterId = runState?.afterId ?? 0;
			let wrapped = false;
			while (summary.processed < effectiveLimit && gate.available()) {
				const archives = await repository.getArchivesNeedingMetadata(maxAttempts,
					Math.min(batchSize, effectiveLimit - summary.processed), afterId,
					{ids: settings.archiveIds, includeExhausted: preview || settings.retryExhausted});
				if (!archives.length) {
					if (runState) await runState.advance(0);
					if (!wrapped && afterId > 0 && summary.processed === 0) {
						afterId = 0; wrapped = true; continue;
					}
					break;
				}
				for (const archive of archives) {
					if (!gate.available()) break;
					afterId = archive.id;
					summary.processed++;
					let failed = false;
					try {
						const {title: resolvedTitle} = resolveMetadataSearch(archive.name,
							archive.localDetails, resolveMetadataAuthor(archive.localDetails));
						const searchTitle = resolvedTitle.title;
						logger.info({archiveId: archive.id, searchTitle, name: archive.name,
							searchTitleSource: resolvedTitle.source, searchTitleReason: resolvedTitle.reason}, "Processing archive");
						if (!searchTitle || searchTitle.length > 500) {
							summary.invalidTitle++;
							continue;
						}
						const lookup = await lookupService.search(archive);
						summary.httpFailures += lookup.errors;
						if (lookup.limited) summary.limitedLookups++;
						if (lookup.minimal) summary.insufficient++;
						if (lookup.identityUnverified) summary.identityUnverified++;
						const result = lookup.match, provider = lookup.provider;
						const hadError = lookup.status === "deferred", hadRejected = lookup.rejected;
						if (hadRejected) summary.rejected++;
						const correction = lookup.localCorrection;
						let fingerprint = archive.sourceFingerprint;
						if (correction) {
							if (preview) {
								summary.previewLocalCorrections++;
								logger.info({archiveId: archive.id, correction}, "Preview local identity correction; no data saved");
							} else if (lookup.status !== "match" || !result) {
								fingerprint = await repository.updateLocalIdentity(archive.id, correction, fingerprint);
								if (!fingerprint) {
									summary.changedMeanwhile++; continue;
								}
								summary.localCorrections++;
								logger.info({archiveId: archive.id, evidence: correction.evidence}, "Local identity corrected; enrichment remains pending");
							}
						}
						if (lookup.status === "match" && result) {
							if (preview) {
								summary.previewMatches++;
								logger.info({archiveId: archive.id, provider, providerId: result.webDetails._providerId,
									evidence: lookup.evidence, title: result.webDetails.title, metadataScope: result.webDetails._metadataScope}, "Preview candidate; no metadata or cover saved");
								continue;
							}
							const updated = await repository.updateWebDetails(archive.id, JSON.stringify(result.webDetails), fingerprint, correction);
							if (!updated) {
								summary.changedMeanwhile++; continue;
							}
							if (provider === "ol") summary.olMatches++;
							else summary.googleMatches++;
							if (correction) summary.localCorrections++;
							logger.info({archiveId: archive.id, provider, providerId: result.webDetails._providerId,
								evidence: lookup.evidence, title: result.webDetails.title, metadataScope: result.webDetails._metadataScope,
								localCorrection: correction?.evidence}, "Metadata saved");
							if (result.coverUrl) {
								const success = await CoverService.getInstance().downloadAndConvertCover(result.coverUrl, archive.coverId);
								if (success) summary.coverDownloads++;
								else summary.coverFailedOrExisting++;
							}
						} else if (hadError) {
							summary.deferred++;
							logger.info({archiveId: archive.id, minimal: !!lookup.minimal, identityUnverified: !!lookup.identityUnverified}, "Search incomplete; attempts unchanged");
						} else if (preview) {
							if (!lookup.minimal && !lookup.identityUnverified) summary.previewNotFound++;
							else logger.info({archiveId: archive.id, identityUnverified: !!lookup.identityUnverified}, "Preview insufficient metadata; no metadata, cover or attempt saved");
						} else {
							const attempts = await control.incrementAttempts(archive.id, maxAttempts, fingerprint);
							if (attempts === undefined) summary.changedMeanwhile++;
							else if (lookup.minimal || lookup.identityUnverified) summary.insufficientAttempts++;
							else summary.notFound++;
							logger.info({archiveId: archive.id, attempts, hadRejected, minimal: !!lookup.minimal,
								identityUnverified: !!lookup.identityUnverified}, "No publishable metadata");
						}
					} catch (error) {
						failed = true; throw error;
					} finally {
						if (runState && !failed) await runState.advance(afterId);
					}
				}
			}
			logger.info({googleUsage: tracker.hasKeys() ? await tracker.getUsageSummary() : "no keys"}, "Google usage");
			completed = true;
		} catch (error) {
			logger.error({err: error}, "Metadata update failed; remaining archives untouched");
		} finally {
			try {
				await runState?.close();
			} catch (error) {
				completed = false; logger.error({err: error}, "Could not release metadata lock");
			}
			logger.info({...summary, mode: settings.mode, completed, requestLimitReached: !gate.available(),
				elapsedSeconds: (Date.now() - startTime) / 1000}, "=== Metadata update summary ===");
			this.running = false;
		}
	}

}
