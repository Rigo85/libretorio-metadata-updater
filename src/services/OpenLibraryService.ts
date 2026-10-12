import axios, { AxiosResponse } from "axios";
import { WebDetails } from "(src)/models/interfaces/OpenLibrary";
import { createLogger } from "(src)/helpers/logger";
import { selectMetadataCandidate } from "(src)/helpers/metadataCandidate";
import { metadataHttpOptions, MetadataRequestGate } from "(src)/helpers/metadataHttp";
import { lookupWithFallback } from "(src)/helpers/metadataLookup";
import { config } from "(src)/config/configuration";

const logger = createLogger("OpenLibraryService");

export interface OpenLibraryResult {
	webDetails: WebDetails;
	coverUrl: string | undefined;
}

export class OpenLibraryService {
	private static instance: OpenLibraryService;

	private constructor() {
	}

	public static getInstance(): OpenLibraryService {
		if (!OpenLibraryService.instance) {
			OpenLibraryService.instance = new OpenLibraryService();
		}
		return OpenLibraryService.instance;
	}

	// Rejected candidates differ from provider failures for logging and attempt accounting.
	async searchByTitle(title: string, author?: string, fallbackTitle?: string, gate?: MetadataRequestGate): Promise<OpenLibraryResult | undefined | "error" | "limited" | "rejected"> {
		return lookupWithFallback(title, fallbackTitle, async (query, general) => {
			if (general) await new Promise(resolve => setTimeout(resolve, config.production.metadata.requestDelayMs));
			return this.searchOnce(query, author, general, gate);
		});
	}

	private async searchOnce(title: string, author: string | undefined, general: boolean, gate?: MetadataRequestGate): Promise<OpenLibraryResult | undefined | "error" | "limited" | "rejected"> {
		const trimmed = title.trim();
		if (!trimmed) {
			return undefined;
		}

		const url = "https://openlibrary.org/search.json";
		if (gate && !gate.record()) return "limited";

		try {
			const response = await axios.get(url, {
				...metadataHttpOptions(),
				params: {...(general ? {q: trimmed} : {title: trimmed, author}), limit: 5,
					fields: "key,title,author_name,cover_i,publisher,subject,language,isbn,first_publish_year,edition_count"}
			}) as AxiosResponse;
			if (!Array.isArray(response.data?.docs)) throw new Error("Invalid OpenLibrary response");

			if (response.data.docs?.length > 0) {
				const bookInfo = selectMetadataCandidate(trimmed, author, response.data.docs.slice(0, 5));
				if (!bookInfo) {
					logger.info({searchTitle: trimmed}, "OL candidates rejected or ambiguous");
					return "rejected";
				}
				const coverId = bookInfo.cover_i;
				const coverUrl = coverId
					? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`
					: undefined;

				// eslint-disable-next-line @typescript-eslint/naming-convention
				logger.info({title: bookInfo.title, cover_i: coverId}, "OL match found");
				return {webDetails: bookInfo, coverUrl};
			}

			logger.info({searchTitle: trimmed}, "No OL results");
			return undefined;
		} catch (error: any) {
			const status = error?.response?.status;
			const message = error?.message || "Unknown error";
			logger.error({searchTitle: trimmed, status, message}, "OL API error");
			return "error";
		}
	}
}
