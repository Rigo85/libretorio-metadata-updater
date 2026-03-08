import axios from "axios";
import { GoogleBooksResponse, VolumeInfo } from "(src)/models/interfaces/GoogleBooks";
import { WebDetails } from "(src)/models/interfaces/OpenLibrary";
import { RequestTracker } from "(src)/services/RequestTracker";
import { createLogger } from "(src)/helpers/logger";

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

	async searchByTitle(title: string, tracker: RequestTracker): Promise<GoogleBooksResult | undefined> {
		const apiKey = tracker.getAvailableKey();
		if (!apiKey) {
			logger.warn("No available Google API key — all exhausted for today");
			return undefined;
		}

		const trimmed = title.trim();
		if (!trimmed) {
			return undefined;
		}

		const url = "https://www.googleapis.com/books/v1/volumes";
		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt === 0) {
					tracker.consumeRequest(apiKey);
				}

				const response = await axios.get(url, {
					params: {
						q: `intitle:${trimmed}`,
						key: apiKey
					}
				});

				const data = response.data as GoogleBooksResponse;

				if (data.totalItems > 0 && data.items?.length > 0) {
					const volumeInfo = data.items[0].volumeInfo;
					const webDetails = this.mapToWebDetails(volumeInfo);
					const coverUrl = this.extractCoverUrl(volumeInfo);

					logger.info({title: webDetails.title, hasCover: !!coverUrl}, "Google Books match found");
					return {webDetails, coverUrl};
				}

				logger.info({searchTitle: trimmed}, "No Google Books results");
				return undefined;
			} catch (error: any) {
				const status = error?.response?.status;
				const message = error?.message || "Unknown error";

				if (status === 503 && attempt < maxRetries) {
					const waitMs = (attempt + 1) * 3000;
					logger.warn({searchTitle: trimmed, status, attempt: attempt + 1, waitMs}, "Google Books 503 — retrying");
					await new Promise(resolve => setTimeout(resolve, waitMs));
					continue;
				}

				logger.error({searchTitle: trimmed, status, message}, "Google Books API error");
				return undefined;
			}
		}

		return undefined;
	}

	private mapToWebDetails(vi: VolumeInfo): WebDetails {
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
			isbn: vi.industryIdentifiers?.map(id => id.identifier),
			first_publish_year: firstPublishYear,
			_source: "google-books"
		};
		/* eslint-enable @typescript-eslint/naming-convention */
	}

	private extractCoverUrl(vi: VolumeInfo): string | undefined {
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
