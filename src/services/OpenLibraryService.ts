import axios, { AxiosResponse } from "axios";
import { WebDetails } from "(src)/models/interfaces/OpenLibrary";
import { createLogger } from "(src)/helpers/logger";

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

	// Returns OpenLibraryResult on match, undefined on no results, "error" on API failure.
	async searchByTitle(title: string): Promise<OpenLibraryResult | undefined | "error"> {
		const trimmed = title.trim();
		if (!trimmed) {
			return undefined;
		}

		const url = "https://openlibrary.org/search.json";

		try {
			const response = await axios.get(url, {
				params: {title: trimmed}
			}) as AxiosResponse;

			if (response.data.docs?.length > 0) {
				const bookInfo = response.data.docs[0] as WebDetails;
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
