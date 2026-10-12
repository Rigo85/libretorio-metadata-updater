import { WebDetails } from "(src)/models/interfaces/OpenLibrary";

export interface RecoveryHypothesis {title: string; author?: string; evidence: string; queryOnly?: true; validationOnly?: true}
export interface RecoveryTask {provider: "google" | "openlibrary"; text: string; author?: string; general: boolean; strategy: string; query: string}
export interface RecoveryReview {candidate: WebDetails; reason: string}
export interface RecoveryDecision {match?: WebDetails; evidence?: string; review: RecoveryReview[]}
const words = (text: unknown): string[] => String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const signature = (text: unknown) => words(text).join(" ");
const bag = (text: unknown) => words(text).sort().join(" ");
const quote = (text: string) => '"' + text.replace(/["\\]/g, " ") + '"';
export function isbn13(value: unknown): string | undefined {
	const text = String(value).replace(/[\s-]/g, "").toUpperCase();
	if (/^\d{9}[\dX]$/.test(text)) {
		if ([...text].reduce((sum, n, i) => sum + (n === "X" ? 10 : Number(n)) * (10 - i), 0) % 11) return undefined;
		const body = "978" + text.slice(0, 9);
		return body + ((10 - [...body].reduce((sum, n, i) => sum + Number(n) * (i % 2 ? 3 : 1), 0) % 10) % 10);
	}
	if (!/^97[89]\d{10}$/.test(text)) return undefined;
	return [...text].reduce((sum, n, i) => sum + Number(n) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? text : undefined;
}
export function identifiers(details: Record<string, unknown>): string[] {
	const found: string[] = [];
	const isbnLabel = /^isbn(?:[-_ ]?(?:10|13))?$/i;
	let visited = 0;
	const visit = (value: unknown, depth = 0): void => {
		if (found.length >= 2 || depth > 4 || ++visited > 64) return;
		if (Array.isArray(value)) {
			for (const item of value.slice(0, 64)) visit(item, depth + 1);
		} else if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (typeof record.type === "string") {
				if (isbnLabel.test(record.type)) visit(record.identifier, depth + 1);
			} else for (const key of Object.keys(record).slice(0, 64)) {
				if (isbnLabel.test(key)) visit(record[key], depth + 1);
			}
		} else if (typeof value === "number" && Number.isSafeInteger(value)) {
			visit(String(value), depth + 1);
		} else if (typeof value === "string" && value.length <= 8192) {
			for (const entry of value.split(/[,;\n]/)) {
				const labelled = entry.trim().match(/^([^:]+):\s*(.*)$/);
				if (labelled && !isbnLabel.test(labelled[1].trim())) continue;
				// Validate the complete digit run; do not salvage a checksum-valid substring.
				const text = (labelled ? labelled[2] : entry).replace(/^\s*ISBN(?:[-_ ]?(?:10|13))?\s+/i, "");
				for (const match of text.matchAll(/(?<![\p{L}\p{N}])\d(?:[\dXx -]*[\dXx])?(?![\p{L}\p{N}])/gu)) {
					const valid = isbn13(match[0]);
					if (valid && !found.includes(valid)) found.push(valid);
					if (found.length >= 2) return;
				}
			}
		}
	};
	for (const value of [details.isbn, details.ISBN, details.identifiers]) visit(value);
	return found;
}
export function buildPlan(row: {name: string; localDetails: unknown}, titleHelper: typeof import("./metadataTitle"), candidateHelper: typeof import("./metadataCandidate")) {
	let details: any = row.localDetails;
	if (typeof details === "string") {
		try {
			details = JSON.parse(details);
		} catch {
			details = {};
		}
	}
	if (!details || typeof details !== "object" || Array.isArray(details)) details = {};
	const base = titleHelper.resolveMetadataSearch(row.name, details, candidateHelper.resolveMetadataAuthor(details));
	const rawAuthor = candidateHelper.resolveMetadataAuthor(details);
	const stem = titleHelper.cleanSearchSource(row.name.replace(/\.(?:pdf|epub|docx?|odt|rtf|txt|mobi|azw3?|fb2)$/i, ""));
	const hypotheses: RecoveryHypothesis[] = [], notes: string[] = [];
	const add = (title: string, author: string | undefined, evidence: string, queryOnly?: true) => {
		title = title?.trim(); author = author?.trim();
		if (!title || title.length > 500 || hypotheses.some(h => signature(h.title) === signature(title) && bag(h.author) === bag(author))) return;
		if (hypotheses.length >= 6) return;
		hypotheses.push({title, author, evidence, ...(queryOnly ? {queryOnly} : {})});
	};
	const suspect = rawAuthor && base.title.reason !== "confirmed-field-swap" && (bag(rawAuthor) === bag(base.title.title) ||
    /^(camscanner|adobe acrobat|nitro pro(?: \d+)?)$/.test(signature(rawAuthor)) ||
    /^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}$/.test(signature(rawAuthor)));
	if (suspect) notes.push("non-author-local-field");
	add(base.title.title, suspect ? undefined : base.author, base.title.reason);
	const explicit = stem.match(/^(.+?)\s+-\s+(.+)$/u);
	let filenameAuthor;
	if (explicit) {
		const names = explicit[1].split(/\s+(?:&|y|and)\s+/i);
		const parsed = names.map(name => name.match(/^([\p{L} .'-]+),\s*([\p{L} .'-]+)$/u));
		if (parsed.every(Boolean)) filenameAuthor = parsed.map(m => `${m[2].trim()} ${m[1].trim()}`).join(" & ");
		// A complete split of the filename across local fields corroborates a parsing defect.
		const splitFields = bag(`${details.title ?? ""} ${rawAuthor ?? ""}`) === bag(stem);
		const localMain = typeof details.title === "string" ? details.title.replace(/\s*\([^()]+\)\s*$/, "").trim() : "";
		const series = explicit[2].match(/^(.+?)\s+(\d+)\s+-\s+(.+)$/u);
		const tail = series ? series[3] : explicit[2];
		const corroboratedTitle = bag(localMain) === bag(tail);
		const localPair = !!rawAuthor && bag(details.title) === bag(explicit[1]) && bag(rawAuthor) === bag(explicit[2]);
		if (filenameAuthor && (splitFields || corroboratedTitle || !rawAuthor)) {
			if ((splitFields && !localPair) || (corroboratedTitle && names.length > 1)) {
				hypotheses.length = 0;
				notes.push("replaced-inconsistent-local-interpretation");
			}
			add(explicit[2], filenameAuthor, localPair ? "possible-filename-field-swap" : "explicit-filename");
			if (series) {
				// Search may omit the series position, but never replace the volume-specific title.
				if (!corroboratedTitle) add(`${series[1]} ${series[3]}`, filenameAuthor, "named-volume-without-series-position");
				if (corroboratedTitle) add(localMain, filenameAuthor, "local-title-and-filename-coauthors");
			}
			if (corroboratedTitle) add(localMain, filenameAuthor, "local-main-title-and-filename-author");
		}
		if (!filenameAuthor && rawAuthor && localPair) {
			// This filename layout suggests a swap, but is not independent identity evidence.
			const author = explicit[1].replace(/^[\p{L} ]{1,60}\s+\d+\s+(?=(?:\p{Lu}\.\s*){1,3}\p{Lu})/u, "");
			if (/^[\p{L} .'-]+$/u.test(author) && words(author).length >= 2) add(explicit[2], author, "possible-filename-field-swap", true);
		}
		const partial = typeof details.title === "string" ? details.title.match(/^([\p{L} .'-]+)\s+-\s+(.+)$/u) : undefined;
		if (filenameAuthor && rawAuthor && partial && bag(rawAuthor) === bag(explicit[2]) && bag(partial[2]) === bag(explicit[2])) {
			const shortName = words(filenameAuthor), fullName = words(partial[1]);
			if (shortName.length >= 2 && fullName.length === shortName.length + 1 && shortName.every((word, i) => word === fullName[i]))
				add(partial[2], partial[1], "possible-partial-field-swap", true);
		}
	}
	for (const h of [...hypotheses]) {
		if (!h.author) continue;
		const repaired = h.author.replace(/\b([A-Z])I(?=i[a-z]{2})/g, "$1l");
		if (repaired !== h.author) add(h.title, repaired, "possible-author-confusable", true);
	}
	const isbns = identifiers(details), tasks: RecoveryTask[] = [];
	if (/^(?:untitled|sin titulo)(?: \d{1,2})?$/.test(signature(details.title)) && isbns.length && hypotheses.length < 6) {
		const filename = titleHelper.resolveFilenameSearch(row.name);
		if (filename.title && signature(filename.title) !== signature(base.title.title) && filename.title.length <= 500 &&
			!hypotheses.some(h => signature(h.title) === signature(filename.title) && bag(h.author) === bag(rawAuthor ?? filename.author)))
			hypotheses.push({title:filename.title, author:rawAuthor ?? filename.author,
				evidence:"placeholder-filename-isbn-only", queryOnly:true, validationOnly:true});
	}
	const series = typeof details.series === "string" ? details.series.match(/^(.+?)\s+#(\d+(?:[.,]\d+)?)$/) : undefined;
	const numberedTitle = typeof details.title === "string" ? details.title.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s+(.+)$/) : undefined;
	if (isbns.length && rawAuthor && !suspect && series && numberedTitle &&
		signature(series[1]) === signature(numberedTitle[1]) &&
		Number(series[2].replace(",", ".")) === Number(numberedTitle[2].replace(",", ".")) && hypotheses.length < 6) {
		const title = titleHelper.cleanSearchSource(numberedTitle[3]);
		// Local series structure explains the prefix; matching ISBN is still required for admission.
		if (title.length >= 3 && title.length <= 500 && !hypotheses.some(h => signature(h.title) === signature(title)))
			hypotheses.push({title, author:rawAuthor, evidence:"local-series-isbn-only", queryOnly:true, validationOnly:true});
	}
	const push = (provider: RecoveryTask["provider"], text: string, author: string | undefined, general: boolean, strategy: string, query?: string) => {
		if (!text || text.length > 600) return;
		query ??= provider === "google" ? general ? text : `intitle:${quote(text)}${author ? ` inauthor:${quote(author)}` : ""}` : text;
		if (tasks.some(t => t.provider === provider && t.query === query && t.author === author && (provider === "google" || t.general === general))) return;
		tasks.push({provider, text, author, general, strategy, query});
	};
	for (const isbn of isbns) push("google", isbn, undefined, true, "isbn", `isbn:${isbn}`);
	for (const h of hypotheses) {
		if (h.validationOnly) continue;
		push("google", h.title, h.author, false, h.evidence);
		push("google", h.title, undefined, true, "title-only");
		if (h.author) push("google", `${quote(h.title)} ${h.author}`, undefined, true, "free-title-author");
	}
	// The filename is retrieval evidence, not permission to accept the first hit.
	if (signature(stem) !== signature(base.title.title)) push("google", stem, undefined, true, "filename-free");
	for (const h of hypotheses) {
		if (h.validationOnly) continue;
		push("openlibrary", h.title, h.author, false, h.evidence);
		push("openlibrary", h.title, undefined, true, "title-only");
	}
	// Preserve provider coverage before optional variants; never silently truncate a fallback provider.
	const priority = tasks.filter(task => task.strategy === "isbn" || !task.general);
	const selected = [...priority, ...tasks.filter(task => !priority.includes(task))].slice(0, 14);
	// Supplemental retrieval never displaces the existing plan or weakens ISBN admission.
	for (const h of hypotheses.filter(h => h.evidence === "local-series-isbn-only")) {
		for (const provider of ["google", "openlibrary"] as const) {
			if (selected.length >= 14) break;
			const before = tasks.length;
			push(provider, h.title, h.author, false, "series-short-title");
			if (tasks.length > before) selected.push(tasks[tasks.length - 1]);
		}
	}
	const volumeTitle = candidateHelper.terminalVolumeVariant(base.title.title);
	if (volumeTitle) {
		for (const general of [false, true]) {
			if (selected.length >= 14) break;
			const before = tasks.length;
			push("google", volumeTitle, general ? undefined : hypotheses[0]?.author, general,
				"terminal-volume-label", general ? quote(volumeTitle) : undefined);
			if (tasks.length > before) selected.push(tasks[tasks.length - 1]);
		}
	}
	// Optional variants never displace existing tasks. Both require an independent local ISBN.
	const supplemental: RecoveryHypothesis[] = [];
	if (isbns.length && rawAuthor && !suspect && base.title.source === "localDetails") {
		const title = titleHelper.awardTitleVariant(base.title.title);
		if (title) supplemental.push({title, author:rawAuthor, evidence:"award-suffix-isbn-only", queryOnly:true, validationOnly:true});
		const credits = base.title.title.split(/\s+(?:y|and|&)\s+/i);
		if (credits.length >= 2 && credits.length <= 3 && rawAuthor.length <= 300 && stem.length <= 600) {
			const fileWords = words(stem), titleWords = words(rawAuthor);
			const positions = fileWords.flatMap((_, i) => titleWords.length >= 2 &&
				titleWords.every((word, j) => word === fileWords[i + j]) ? [i] : []);
			if (positions.length === 1 && positions[0] > 0) {
				const prefix = fileWords.slice(0, positions[0]).join(" ");
				const suffix = fileWords.slice(positions[0] + titleWords.length).join(" ");
				const names = prefix.split(/\s+(?:y|and)\s+/);
				const nameLike = (name: string) => /^[\p{L} ]+$/u.test(name) && words(name).length >= 2 && words(name).length <= 5;
				if (names.length === credits.length && names.every(nameLike) && credits.every(credit => nameLike(signature(credit))) &&
					(!suffix || /^premio(?: [\p{L}]+){1,5} (?:19|20)\d{2}$/u.test(suffix)) &&
					// eslint-disable-next-line @typescript-eslint/naming-convention -- Existing provider identity contract.
					!candidateHelper.metadataCandidateRejection(rawAuthor, base.title.title, {title:rawAuthor, author_name:names})) {
					supplemental.push({title:rawAuthor, author:names.join(" & "), evidence:"coauthor-swap-isbn-only", queryOnly:true, validationOnly:true});
				}
			}
		}
	}
	for (const h of supplemental) {
		if (selected.length >= 14 || hypotheses.length >= 6 || hypotheses.some(existing =>
			signature(existing.title) === signature(h.title) && bag(existing.author) === bag(h.author))) continue;
		hypotheses.push(h);
		for (const provider of ["google", "openlibrary"] as const) {
			if (selected.length >= 14) break;
			const before = tasks.length;
			const swapped = h.evidence === "coauthor-swap-isbn-only";
			push(provider, h.title, swapped ? undefined : h.author, swapped && provider === "google", h.evidence,
				swapped && provider === "google" ? quote(h.title) : undefined);
			if (tasks.length > before) selected.push(tasks[tasks.length - 1]);
		}
	}
	const copyTitle = titleHelper.fileCopyTitleVariant(base.title.source === "localDetails" ? details.title : row.name);
	if (copyTitle && selected.length < 14 && hypotheses.length < 6 && !hypotheses.some(h => signature(h.title) === signature(copyTitle))) {
		// Removing a copy label helps retrieval, but cannot itself prove identity.
		hypotheses.push({title:copyTitle, author:hypotheses[0]?.author, evidence:"file-copy-marker-isbn-only", queryOnly:true, validationOnly:true});
		for (const provider of ["google", "openlibrary"] as const) {
			if (selected.length >= 14) break;
			const before = tasks.length;
			push(provider, copyTitle, hypotheses[0]?.author, false, "file-copy-marker");
			if (tasks.length > before) selected.push(tasks[tasks.length - 1]);
		}
	}
	// Keep the existing request order when the complete plan fits in the budget.
	return {base, hypotheses, isbns, notes, tasks:tasks.filter(task => selected.includes(task))};
}
export function evaluate(plan: ReturnType<typeof buildPlan>, candidates: WebDetails[], select: typeof import("./metadataCandidate").selectMetadataCandidate,
	inspect?: typeof import("./metadataCandidate").metadataCandidateRejection, useful?: (candidate: WebDetails) => boolean): RecoveryDecision {
	const accepted: {candidate: WebDetails; evidence: string}[] = [], review: RecoveryReview[] = [];
	for (const candidate of candidates) {
		const candidateIsbns = (candidate.isbn ?? []).map(isbn13).filter(Boolean);
		const exactIsbn = plan.isbns.some(value => candidateIsbns.includes(value));
		const conflictingIsbn = plan.isbns.length > 0 && candidateIsbns.length > 0 && !exactIsbn;
		let match: {candidate: WebDetails; evidence: string} | undefined;
		const reasons = new Set<string>();
		for (const h of plan.hypotheses) {
			if (!select(h.title, h.author, [candidate])) {
				reasons.add(inspect?.(h.title, h.author, candidate) ?? "identity-mismatch");
				continue;
			}
			if (h.queryOnly && !exactIsbn) {
				reasons.add("exploratory-hypothesis-needs-evidence"); continue;
			}
			if (h.author || exactIsbn) {
				match = {candidate, evidence:exactIsbn ? "isbn-and-identity" : conflictingIsbn ? "different-edition-work-identity" : h.evidence}; break;
			}
			reasons.add("title-only-no-author-evidence");
		}
		if (match) accepted.push(match);
		else if (exactIsbn) {
			const titleCompatible = plan.hypotheses.some(h=>select(h.title, undefined, [candidate]));
			const missingAuthor = !candidate.author_name?.length;
			reasons.add(titleCompatible && missingAuthor ? "isbn-and-title-missing-authors" : "isbn-match-but-title-or-author-conflict");
		}
		if (!match) for (const reason of reasons) review.push({candidate, reason});
	}
	const signatures = new Set(accepted.map(x => metadataIdentity(x.candidate)));
	if (signatures.size > 1) return {review:[...review, ...accepted.map(x => ({candidate:x.candidate, reason:"multiple-compatible-identities"}))]};
	const richer = useful ? accepted.filter(row => useful(row.candidate)) : [];
	const pool = richer.length ? richer : accepted;
	const preferred = pool.find(row => row.evidence === "isbn-and-identity") ?? pool[0];
	return {match:preferred?.candidate, evidence:preferred?.evidence, review};
}

export function metadataIdentity(candidate: WebDetails): string {
	return bag(candidate.title) + "|" + (candidate.author_name ?? []).map(bag).sort().join("|");
}

export interface LocalIdentityCorrection {
	title: string;
	author: string;
	before: {title: string; author: string};
	sourceName: string;
	evidence: "google-isbn-confirmed-field-swap";
	provider: "google";
	providerId: string;
	isbn: string;
}

export function needsLocalIdentityVerification(plan: ReturnType<typeof buildPlan>, row: {localDetails: unknown; customDetails?: boolean},
	helper: typeof import("./metadataCandidate"), candidate: WebDetails): boolean {
	let local: any = row.localDetails;
	if (typeof local === "string") {
		try {
			local = JSON.parse(local);
		} catch {
			return false;
		}
	}
	if (row.customDetails || !local || typeof local !== "object" || Array.isArray(local) ||
		Object.hasOwn(local, "_identityCorrection")) return false;
	const author = helper.resolveMetadataAuthor(local);
	return !!author && signature(candidate.title) === signature(author) && plan.hypotheses.some(h =>
		["confirmed-field-swap", "possible-filename-field-swap", "coauthor-swap-isbn-only"].includes(h.evidence) &&
		h.author && signature(h.title) === signature(author) && !helper.metadataCandidateRejection(h.title, h.author, candidate));
}

// Repair only a demonstrated inversion, not every disagreement with a provider.
export function localIdentityCorrection(plan: ReturnType<typeof buildPlan>, row: {name: string; localDetails: unknown; customDetails?: boolean},
	helper: typeof import("./metadataCandidate"), candidate?: WebDetails,
	provenance?: {provider: "google" | "ol"; providerId?: string}): LocalIdentityCorrection | undefined {
	if (!candidate || provenance?.provider !== "google" || !provenance.providerId ||
		!/^[A-Za-z0-9_-]{1,120}$/.test(provenance.providerId)) return undefined;
	let local: any = row.localDetails;
	if (row.customDetails) return undefined;
	if (typeof local === "string") {
		try {
			local = JSON.parse(local);
		} catch {
			return undefined;
		}
	}
	if (!local || typeof local !== "object" || Array.isArray(local) || Object.hasOwn(local, "_identityCorrection") ||
		typeof local.title !== "string" || typeof local["author(s)"] !== "string" ||
		local.title.length > 500 || local["author(s)"].length > 300 || row.name.length > 600 ||
		[local.title, local["author(s)"], row.name].some(value => value.includes("\uFFFD"))) return undefined;
	const author = helper.resolveMetadataAuthor(local);
	if (!author) return undefined;
	const before = {title: local.title, author: local["author(s)"]};
	const base = {before, sourceName: row.name};
	if (!candidate.title || candidate.title.length > 500 || candidate.title.includes("\uFFFD") ||
		!candidate.author_name?.length || candidate.author_name.length > 3 ||
		candidate.author_name.some(name => !name.trim() || name.length > 100 || name.includes("\uFFFD"))) return undefined;
	const isbn = plan.isbns.find(value => candidate.isbn?.some(remote => isbn13(remote) === value));
	if (!isbn) return undefined;
	const matches = plan.hypotheses.filter(h => ["confirmed-field-swap", "possible-filename-field-swap", "coauthor-swap-isbn-only"].includes(h.evidence) &&
		h.author && signature(h.title) === signature(author) && signature(candidate.title) === signature(author) &&
		!helper.metadataCandidateRejection(h.title, h.author, candidate));
	if (matches.length !== 1) return undefined;
	const h = matches[0];
	const credits = h.author.split(/\s+(?:y|and|&)\s+|\s*;\s*/i);
	// Search accepts compatible credits; a persistent repair also rejects extra/missing people.
	if (credits.length !== candidate.author_name.length || candidate.author_name.some(name =>
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Existing provider contract.
		helper.metadataCandidateRejection(h.title, name, {title: h.title, author_name: credits}))) return undefined;
	return {...base, title: candidate.title.trim(), author: candidate.author_name.map(name => name.trim()).join(" & "),
		evidence: "google-isbn-confirmed-field-swap", isbn, provider: "google", providerId: provenance.providerId};
}

function languageCodes(value: unknown): string[] {
	const aliases: Record<string, string> = {spa:"es", eng:"en", por:"pt", fra:"fr", fre:"fr", deu:"de", ger:"de", ita:"it", cat:"ca"};
	const values = Array.isArray(value) ? value.slice(0, 16) : [value];
	return values.flatMap(item => typeof item === "string" && item.length <= 128 ? item.toLowerCase().split(/[,;/]/).map(code => {
		const primary = code.trim().replace(/_/g, "-").split("-")[0];
		return /^[a-z]{2,3}$/.test(primary) && !["und", "mul", "zxx"].includes(primary) ? aliases[primary] ?? primary : "";
	}).filter(Boolean) : []);
}

export function damagedMetadataTextFields(candidate: WebDetails): ("description" | "first_sentence")[] {
	const fields: ("description" | "first_sentence")[] = [];
	if (candidate.description?.includes("\uFFFD")) fields.push("description");
	if (candidate.first_sentence?.some(value => value.includes("\uFFFD"))) fields.push("first_sentence");
	return fields;
}

export function metadataForStorage(plan: ReturnType<typeof buildPlan>, candidate: WebDetails, provider: "google" | "ol", sourceDetails: unknown): WebDetails {
	const matchingIsbns = (candidate.isbn ?? []).filter(value => plan.isbns.includes(isbn13(value) ?? ""));
	let local: any = sourceDetails;
	if (typeof local === "string") {
		try {
			local = JSON.parse(local);
		} catch {
			local = undefined;
		}
	}
	const localLanguages = local && typeof local === "object" && !Array.isArray(local) ?
		[...languageCodes(local.languages), ...languageCodes(local.language)] : [];
	const remoteLanguages = languageCodes(candidate.language);
	const languageConflict = localLanguages.length > 0 && remoteLanguages.length > 0 && !localLanguages.some(code => remoteLanguages.includes(code));
	// OpenLibrary search aggregates editions; an ISBN in that list cannot certify its other fields.
	const edition = provider === "google" && matchingIsbns.length > 0 && !languageConflict;
	/* eslint-disable @typescript-eslint/naming-convention -- Preserve the external webDetails contract. */
	const metadata: WebDetails = {
		title: candidate.title,
		key: candidate.key,
		author_name: candidate.author_name?.slice(),
		subject: candidate.subject?.slice(),
		description: candidate.description,
		first_sentence: candidate.first_sentence?.slice(),
		cover_i: candidate.cover_i,
		_source: provider === "google" ? "google-books" : "openlibrary",
		_metadataScope: edition ? "edition" : "work"
	};
	/* eslint-enable @typescript-eslint/naming-convention */
	if (edition) {
		metadata.isbn = matchingIsbns;
		metadata.publisher = candidate.publisher?.slice();
		metadata.language = candidate.language?.slice();
		metadata.first_publish_year = candidate.first_publish_year;
	}
	for (const field of damagedMetadataTextFields(candidate)) delete metadata[field];
	return metadata;
}
