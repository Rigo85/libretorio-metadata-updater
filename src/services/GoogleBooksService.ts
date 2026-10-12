import axios from "axios";
import { GoogleBooksResponse, VolumeInfo } from "(src)/models/interfaces/GoogleBooks";
import { WebDetails } from "(src)/models/interfaces/OpenLibrary";
import { RequestTracker } from "(src)/services/RequestTracker";
import { createLogger } from "(src)/helpers/logger";
import { selectMetadataCandidate } from "(src)/helpers/metadataCandidate";
import { metadataHttpOptions, MetadataRequestGate, retryAfterMilliseconds } from "(src)/helpers/metadataHttp";
import { lookupWithFallback } from "(src)/helpers/metadataLookup";
import { config } from "(src)/config/configuration";

const logger = createLogger("GoogleBooksService");

export interface GoogleBooksResult {
	webDetails: WebDetails;
	coverUrl: string | undefined;
}

export class GoogleBooksService {
	private static instance: GoogleBooksService;

	private constructor() {
	}

	public static getInstance(): GoogleBooksService {
		if (!GoogleBooksService.instance) {
			GoogleBooksService.instance = new GoogleBooksService();
		}
		return GoogleBooksService.instance;
	}

	// Quota/storage failures must never be confused with a completed empty search.
	async searchByTitle(title: string, tracker: RequestTracker, author?: string, fallbackTitle?: string, gate?: MetadataRequestGate): Promise<GoogleBooksResult | undefined | "error" | "limited" | "rejected"> {
		return lookupWithFallback(title, fallbackTitle, async (query, general) => {
			if (general) await new Promise(resolve => setTimeout(resolve, config.production.metadata.requestDelayMs));
			return this.searchOnce(query, tracker, author, general, gate);
		});
	}

	private async searchOnce(title: string, tracker: RequestTracker, author: string | undefined, general: boolean, gate?: MetadataRequestGate): Promise<GoogleBooksResult | undefined | "error" | "limited" | "rejected"> {
		const trimmed = title.trim();
		if (!trimmed) {
			return undefined;
		}

		const url = "https://www.googleapis.com/books/v1/volumes";
		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (gate && !gate.available()) return "limited";
			const apiKey = await tracker.getAvailableKey();
			if (!apiKey || !await tracker.consumeRequest(apiKey)) return "limited";
			if (gate && !gate.record()) return "limited";
			const startedAt = Date.now();
			try {
				const response = await axios.get(url, {
					...metadataHttpOptions(),
					params: {
						q: general ? trimmed : `intitle:"${trimmed.replace(/["\\]/g, " ")}"${author ? ` inauthor:"${author.replace(/["\\]/g, " ")}"` : ""}`,
						key: apiKey,
						maxResults: 5
					}
				});

				const data = response.data as GoogleBooksResponse;
				if (!data || !Number.isFinite(data.totalItems) || data.totalItems < 0
					|| (data.totalItems > 0 && !Array.isArray(data.items))) throw new Error("Invalid Google Books response");

				if (data.totalItems > 0 && data.items?.length > 0) {
					const volumes = data.items.slice(0, 5).map(item => item.volumeInfo);
					const candidates = volumes.map(volume => this.mapToWebDetails(volume));
					const webDetails = selectMetadataCandidate(trimmed, author, candidates);
					if (!webDetails) {
						logger.info({searchTitle: trimmed}, "Google Books candidates rejected or ambiguous");
						return "rejected";
					}
					const volumeInfo = volumes[candidates.indexOf(webDetails)];
					const coverUrl = this.extractCoverUrl(volumeInfo);

					logger.info({title: webDetails.title, hasCover: !!coverUrl}, "Google Books match found");
					return {webDetails, coverUrl};
				}

				logger.info({searchTitle: trimmed}, "No Google Books results");
				return undefined;
			} catch (error: any) {
				const status = error?.response?.status;
				const message = error?.message || "Unknown error";
				const reasons = this.getErrorReasons(error);
				const retryAfterMs = retryAfterMilliseconds(error?.response?.headers?.["retry-after"]);
				logger.warn({status, reasons, retryAfterMs, attempt: attempt + 1,
					elapsedMs: Date.now() - startedAt}, "Google Books HTTP failure");

				if ([502, 503, 504].includes(status) && attempt < maxRetries) {
					if (gate && !gate.available()) return "limited";
					const waitMs = Math.max((attempt + 1) * 3000, config.production.metadata.requestDelayMs);
					logger.warn({searchTitle: trimmed, status, reasons, retryAfterMs, attempt: attempt + 1, waitMs}, "Google Books transient error - retrying");
					await new Promise(resolve => setTimeout(resolve, waitMs));
					continue;
				}

				if (this.isRateLimitError(error)) {
					const cooldownSeconds = await tracker.registerRateLimitHit(apiKey);
					logger.warn({
						searchTitle: trimmed,
						status,
						message,
						reasons,
						cooldownSeconds,
						apiKey: `${apiKey.substring(0, 8)}...`
					}, "Google Books rate limited — cooling down key");
					return "error";
				}

				if (this.isDailyQuotaExceededError(error)) {
					await tracker.markKeyExhausted(apiKey, `quota exceeded (${status ?? "unknown status"})`);
					logger.warn({
						searchTitle: trimmed,
						status,
						message,
						reasons,
						apiKey: `${apiKey.substring(0, 8)}...`
					}, "Google Books daily quota exhausted for key");
					return "error";
				}

				logger.error({searchTitle: trimmed, status, message, reasons}, "Google Books API error");
				return "error";
			}
		}

		return undefined;
	}

	private getErrorReasons(error: any): string[] {
		const errors = error?.response?.data?.error?.errors;
		return Array.isArray(errors) ? errors.slice(0, 10).map(item => item?.reason)
			.filter(reason => typeof reason === "string").map(reason => reason.slice(0, 100)) : [];
	}

	private isRateLimitError(error: any): boolean {
		const status = error?.response?.status;
		if (status === 429) {
			return true;
		}

		if (status !== 403) {
			return false;
		}

		const reasons = this.getErrorReasons(error);
		const message = String(error?.response?.data?.error?.message || "").toLowerCase();

		return reasons.some((reason: string) => /rate.?limit/i.test(reason))
			|| /too many requests|rate limit/.test(message);
	}

	private isDailyQuotaExceededError(error: any): boolean {
		if (error?.response?.status !== 403) {
			return false;
		}

		const reasons = this.getErrorReasons(error);
		const message = String(error?.response?.data?.error?.message || "").toLowerCase();

		return reasons.some((reason: string) => /daily.?limit|quota/i.test(reason))
			|| /daily limit|quota/.test(message);
	}

	mapToWebDetails(vi: VolumeInfo): WebDetails {
		let firstPublishYear: number | undefined;
		if (vi.publishedDate) {
			const parsed = parseInt(vi.publishedDate.substring(0, 4), 10);
			if (!isNaN(parsed)) {
				firstPublishYear = parsed;
			}
		}

		/* eslint-disable @typescript-eslint/naming-convention */
		return {
			title: vi.title,
			author_name: vi.authors,
			publisher: vi.publisher ? [vi.publisher] : undefined,
			subject: vi.categories,
			description: vi.description,
			language: vi.language ? [vi.language] : undefined,
			isbn: vi.industryIdentifiers?.filter(id => ["ISBN_10", "ISBN_13"].includes(id.type)).map(id => id.identifier),
			first_publish_year: firstPublishYear,
			_source: "google-books"
		};
		/* eslint-enable @typescript-eslint/naming-convention */
	}

	extractCoverUrl(vi: VolumeInfo): string | undefined {
		if (!vi.imageLinks) {
			return undefined;
		}
		// Prefer thumbnail, replace zoom to get a larger image
		const url = vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail;
		if (!url) {
			return undefined;
		}
		// Google Books thumbnails have &zoom=1 by default; zoom=0 gives a larger image
		return url.replace(/&zoom=\d/, "&zoom=0");
	}
}
