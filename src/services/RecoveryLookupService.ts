import axios from "axios";
import * as titles from "(src)/helpers/metadataTitle";
import * as candidates from "(src)/helpers/metadataCandidate";
import { buildPlan, damagedMetadataTextFields, evaluate, localIdentityCorrection, LocalIdentityCorrection, metadataForStorage, metadataIdentity, needsLocalIdentityVerification, RecoveryTask } from "(src)/helpers/metadataRecovery";
import { metadataHttpOptions, MetadataRequestGate, retryAfterMilliseconds } from "(src)/helpers/metadataHttp";
import { RequestTracker } from "(src)/services/RequestTracker";
import { GoogleBooksService, GoogleBooksResult } from "(src)/services/GoogleBooksService";
import { WebDetails } from "(src)/models/interfaces/OpenLibrary";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("RecoveryLookupService");
type TaskState = RecoveryTask & {attempts: number; nextAt: number; done: boolean; terminal: boolean};
export interface RecoveryResult {
	status: "match" | "none" | "rejected" | "insufficient" | "deferred";
	minimal?: boolean;
	match?: GoogleBooksResult;
	provider?: "google" | "ol";
	rejected: boolean;
	errors: number;
	limited: boolean;
	evidence?: string;
	localCorrection?: LocalIdentityCorrection;
	identityUnverified?: boolean;
}

// One retry owner. Legacy providers are used only for mapping, never nested HTTP retries.
export class RecoveryLookupService {
	private lastRequest = 0;
	private notBefore = {google: 0, openlibrary: 0};

	constructor(private tracker: RequestTracker, private gate: MetadataRequestGate,
		private options: {requestDelayMs: number; canUseOpenLibrary: boolean; diagnostics?: boolean}) {}

	async search(archive: {id: number; name: string; localDetails: unknown; customDetails?: boolean}): Promise<RecoveryResult> {
		const plan = buildPlan(archive, titles, candidates);
		let localCorrection: LocalIdentityCorrection | undefined;
		const tasks: TaskState[] = plan.tasks.filter(task => task.provider === "google" ? this.tracker.hasKeys() : this.options.canUseOpenLibrary)
			.map(task => ({...task, attempts: 0, nextAt: 0, done: false, terminal: false}));
		let rejected = false, errors = 0, limited = false;
		let retained: RecoveryResult | undefined, enrichmentRequests = 0;
		let pendingUseful: RecoveryResult | undefined, verificationRequests = 0;
		const finish = (reason: string): RecoveryResult => {
			if (pendingUseful) {
				const googleTasks = tasks.filter(task => task.provider === "google");
				const incomplete = limited || !googleTasks.length || googleTasks.some(task => !task.done && (task.attempts > 0 || task.terminal));
				const status = incomplete ? "deferred" : "insufficient";
				logger.info({archiveId: archive.id, reason, status, verificationRequests, errors}, "Useful metadata withheld: local inversion unverified by Google");
				return {status, identityUnverified: true, provider: pendingUseful.provider, evidence: pendingUseful.evidence,
					rejected, errors, limited};
			}
			if (!retained) return {status: "deferred", rejected, errors, limited, localCorrection};
			// Untried alternatives beyond the enrichment cap are deliberate, not failed requests.
			// A successful retry clears its task; the historical error count must not defer it again.
			const incomplete = limited || tasks.some(task => !task.done && (task.attempts > 0 || task.terminal));
			const status = incomplete ? "deferred" : "insufficient";
			logger.info({archiveId: archive.id, reason, status, enrichmentRequests, errors}, "Minimal metadata not publishable");
			return {status, minimal: true, provider: retained.provider, evidence: retained.evidence, rejected, errors, limited, localCorrection};
		};
		for (let round = 1; round <= 4; round++) {
			for (const task of tasks) {
				if (task.done || task.terminal || task.attempts >= 4) continue;
				if (pendingUseful && task.provider !== "google") continue;
				if (pendingUseful && verificationRequests >= 2) return finish("identity-verification-budget");
				if (!pendingUseful && retained && enrichmentRequests >= 2) return finish("enrichment-budget");
				if (!this.gate.available()) {
					limited = true; return finish("run-budget");
				}
				const cooldown = task.provider === "google" ? await this.tracker.getWaitTimeUntilAvailableKeyMs() ?? 0 : 0;
				const wait = Math.max(0, task.nextAt - Date.now(), this.notBefore[task.provider] - Date.now(),
					this.options.requestDelayMs - (Date.now() - this.lastRequest), cooldown);
				if (wait > 900000) {
					task.terminal = true; limited = true; continue;
				}
				if (wait) await this.delay(wait);
				let key: string | undefined;
				if (task.provider === "google") {
					key = await this.tracker.getAvailableKey();
					if (!key || !await this.tracker.consumeRequest(key)) {
						task.terminal = true; limited = true; continue;
					}
				}
				if (!this.gate.record()) {
					limited = true; return finish("run-budget");
				}
				if (pendingUseful) verificationRequests++;
				else if (retained) enrichmentRequests++;
				task.attempts++;
				this.lastRequest = Date.now();
				try {
					const google = task.provider === "google";
					const response = await axios.get(google ? "https://www.googleapis.com/books/v1/volumes" : "https://openlibrary.org/search.json", {
						...metadataHttpOptions(), params: google ? {q: task.query, key, maxResults: 5} : {
							...(task.general ? {q: task.text} : {title: task.text, author: task.author}), limit: 5,
							fields: "key,title,author_name,cover_i,publisher,subject,language,isbn,first_publish_year,edition_count"
						}
					});
					const details: WebDetails[] = [], covers: (string | undefined)[] = [], candidateKeys: unknown[] = [];
					let entries: any[];
					if (google) {
						if (!Number.isSafeInteger(response.data?.totalItems) || response.data.totalItems < 0 ||
							((response.data.totalItems > 0 || response.data.items !== undefined) && !Array.isArray(response.data.items))) throw new Error("Invalid Google response");
						entries = (response.data.items ?? []).slice(0, 5);
					} else {
						if (!Array.isArray(response.data?.docs)) throw new Error("Invalid OpenLibrary response");
						entries = response.data.docs.slice(0, 5);
					}
					let invalidCandidates = 0;
					for (const entry of entries) {
						try {
							const mapper = google ? GoogleBooksService.getInstance() : undefined;
							const book = google ? mapper.mapToWebDetails(entry?.volumeInfo) : entry;
							if (!this.validCandidate(book)) throw new Error("Invalid candidate");
							const cover = google ? this.allowedCover(mapper.extractCoverUrl(entry.volumeInfo)) :
								Number.isSafeInteger(book.cover_i) && book.cover_i > 0 ? `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg` : undefined;
							details.push(book); covers.push(cover); candidateKeys.push(google ? entry.id : book.key);
						} catch {
							invalidCandidates++;
						}
					}
					if (invalidCandidates) {
						errors++;
						logger.warn({archiveId: archive.id, provider: task.provider, invalidCandidates, candidateCount: entries.length}, "Metadata response contains invalid candidates");
					}
					const project = (book: WebDetails): GoogleBooksResult => {
						const index = details.indexOf(book), id = candidateKeys[index];
						const webDetails = metadataForStorage(plan, book, google ? "google" : "ol", archive.localDetails);
						const pattern = google ? /^[A-Za-z0-9_-]+$/ : /^\/(?:works|books)\/OL\d+[WM]$/;
						if (typeof id === "string" && id.length <= 120 && id.trim() === id && pattern.test(id)) webDetails._providerId = id;
						return {webDetails, coverUrl: covers[index]};
					};
					const decision = evaluate(plan, details, candidates.selectMetadataCandidate, candidates.metadataCandidateRejection,
						book => this.useful(project(book)));
					// Keep partial invalid searches incomplete, unless a valid independent record matches.
					task.done = invalidCandidates === 0;
					task.terminal = invalidCandidates > 0;
					rejected ||= details.length > 0 && !decision.match;
					logger.info({archiveId: archive.id, provider: task.provider, query: task.query, strategy: task.strategy,
						author: task.author, general: task.general, round, attempt: task.attempts,
						status: response.status, candidateCount: details.length, matched: !!decision.match,
						reviewReasons: [...new Set(decision.review.map(row => row.reason))],
						...(this.options.diagnostics ? {candidates: details.map((book, index) => ({
							index, key: typeof candidateKeys[index] === "string" ? (candidateKeys[index] as string).slice(0, 120) : undefined,
							title: typeof book.title === "string" ? book.title.slice(0, 200) : undefined,
							authors: Array.isArray(book.author_name) ? book.author_name.filter(name => typeof name === "string").slice(0, 5).map(name => name.slice(0, 100)) : [],
							truncated: book.title?.length > 200 || book.author_name?.length > 5 ||
								(Array.isArray(book.author_name) && book.author_name.some(name => typeof name === "string" && name.length > 100)),
							accepted: decision.match === book,
							reasons: decision.review.filter(row => row.candidate === book).map(row => row.reason).slice(0, 8)
						}))} : {}), elapsedMs: Date.now() - this.lastRequest}, "Metadata HTTP result");
					if (decision.match) {
						const discardedTextFields = damagedMetadataTextFields(decision.match);
						if (discardedTextFields.length) {
							const candidateKey = candidateKeys[details.indexOf(decision.match)];
							logger.warn({archiveId: archive.id, provider: task.provider, discardedTextFields,
								candidateKey: typeof candidateKey === "string" ? candidateKey.slice(0, 120) : undefined}, "Damaged metadata text omitted");
						}
						const result: RecoveryResult = {status: "match", rejected, errors, limited, evidence: decision.evidence,
							provider: google ? "google" : "ol", match: project(decision.match)};
						const previous = pendingUseful ?? retained;
						if (previous && metadataIdentity(previous.match.webDetails) !== metadataIdentity(result.match.webDetails)) {
							logger.info({archiveId: archive.id, provider: task.provider}, "Enrichment rejected: different retained identity");
							continue;
						}
						localCorrection ??= localIdentityCorrection(plan, archive, candidates, decision.match,
							{provider: result.provider, providerId: result.match.webDetails._providerId});
						// A minimal Google entry may confirm the same identity as a richer entry
						// in this response; keep enrichment and correction provenance separate.
						if (!localCorrection && google) {
							for (const book of details) {
								if (metadataIdentity(book) !== metadataIdentity(decision.match)) continue;
								localCorrection = localIdentityCorrection(plan, archive, candidates, book,
									{provider: "google", providerId: project(book).webDetails._providerId});
								if (localCorrection) break;
							}
						}
						if (pendingUseful && localCorrection) return {...pendingUseful, rejected, errors, limited, localCorrection};
						result.localCorrection = localCorrection;
						if (this.useful(result.match)) {
							if (localCorrection || !needsLocalIdentityVerification(plan, archive, candidates, decision.match)) return result;
							if (!pendingUseful) {
								pendingUseful = result;
								logger.info({archiveId: archive.id}, "Useful metadata pending Google identity verification; at most two remaining-plan requests");
							}
							continue;
						}
						if (!retained) {
							retained = result;
							logger.info({archiveId: archive.id, provider: task.provider}, "Minimal metadata retained; at most two enrichment requests");
						}
					}
				} catch (error: any) {
					errors++;
					const status = error?.response?.status, code = error?.code;
					const reasons: string[] = Array.isArray(error?.response?.data?.error?.errors) ? error.response.data.error.errors
						.slice(0, 10).map((row: any) => row?.reason).filter((value: unknown) => typeof value === "string") : [];
					const retryAfter = retryAfterMilliseconds(error?.response?.headers?.["retry-after"]) ?? 0;
					const rate = status === 429 || (status === 403 && reasons.some(reason => /rate.?limit/i.test(reason)));
					const quota = status === 403 && !rate && reasons.some(reason => /quota|daily.?limit/i.test(reason));
					const retryable = rate || [408, 500, 502, 503, 504].includes(status) ||
						["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ERR_NETWORK", "ERR_CANCELED"].includes(code);
					if (key && rate) await this.tracker.registerRateLimitHit(key);
					if (key && quota) await this.tracker.markKeyExhausted(key, "Provider daily quota");
					task.nextAt = Date.now() + Math.max([10000, 30000, 90000][Math.min(task.attempts - 1, 2)], retryAfter);
					this.notBefore[task.provider] = Math.max(this.notBefore[task.provider], Date.now() + retryAfter);
					task.terminal = !retryable;
					logger.warn({archiveId: archive.id, provider: task.provider, query: task.query, strategy: task.strategy,
						author: task.author, general: task.general, status, code, reasons, retryAfter,
						attempt: task.attempts, retryable, elapsedMs: Date.now() - this.lastRequest}, "Metadata HTTP failure");
				}
			}
			if (!tasks.some(task => !task.done && !task.terminal && task.attempts < 4)) break;
		}
		return retained || pendingUseful ? finish("remaining-plan-ended") :
			{status: !tasks.length || tasks.some(task => !task.done) ? "deferred" : rejected ? "rejected" : "none", rejected, errors, limited, localCorrection};
	}

	private useful(result: GoogleBooksResult): boolean {
		const book = result.webDetails;
		return !!(result.coverUrl || book.description?.trim() || book.subject?.some(value => value.trim()) ||
			book.first_sentence?.some(value => value.trim()) || (book._metadataScope === "edition" && book.publisher?.some(value => value.trim())));
	}

	private validCandidate(value: unknown): value is WebDetails {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const book = value as Record<string, unknown>;
		if (typeof book.title !== "string" || !book.title.trim()) return false;
		for (const field of ["author_name", "isbn", "subject", "publisher", "language", "first_sentence"]) {
			const values = book[field];
			if (values !== undefined && (!Array.isArray(values) || values.some(item => typeof item !== "string"))) return false;
		}
		return (book.description === undefined || typeof book.description === "string") &&
			(book.first_publish_year === undefined || Number.isSafeInteger(book.first_publish_year));
	}

	private allowedCover(value?: string): string | undefined {
		if (!value) return undefined;
		try {
			const url = new URL(value);
			if (!["http:", "https:"].includes(url.protocol) || !["books.google.com", "books.googleusercontent.com"].includes(url.hostname)) return undefined;
			url.protocol = "https:";
			return url.toString();
		} catch {
			return undefined;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
