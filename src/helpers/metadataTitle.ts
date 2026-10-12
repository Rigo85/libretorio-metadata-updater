import { cleanFilename, cleanTitle } from "./fileUtils";

export function cleanSearchSource(value: string): string {
	// Strip only recognizable trailing file/source markers, before punctuation is lost.
	return value.replace(/\s*\((?:z-lib\.org|z-library\.org)\)\s*$/i, "")
		.replace(/\.(?:indd|docx?|pptx?|xlsx?|pdf|epub|odt|rtf|txt)\s*$/i, "").trim();
}

export function fileCopyTitleVariant(value: string): string | undefined {
	if (value.length > 600) return undefined;
	const match = value.match(/^(.+\S)\.(?:pdf|epub|docx?|odt|rtf|txt)\s+\u00b7\s+(?:versi[o\u00f3]n|copy|copia)\s+\d{1,4}(?:\.(?:pdf|epub|docx?|odt|rtf|txt))?\s*$/iu);
	const title = match && cleanTitle(match[1]);
	return title && title.length <= 500 ? title : undefined;
}

// Retrieval hypothesis only; a promotional-looking suffix is not proof of identity.
export function awardTitleVariant(value: string): string | undefined {
	if (value.length > 500) return undefined;
	const match = value.match(/^(.{6,}?)\s+(?:nominad[oa]\s+al|ganador(?:a)?\s+del)\s+premio\s+[\p{L}][\p{L} .'-]{1,60}(?:\s+(?:19|20)\d{2})?$/iu);
	const title = match?.[1].trim();
	return title && (title.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) >= 2 ? title : undefined;
}

export interface MetadataTitle {
	title: string;
	source: "localDetails" | "filename";
	reason: "local-title" | "missing-details" | "invalid-json" | "not-object" | "missing-title" | "invalid-title" | "empty-title" | "empty-cleaned-title" | "technical-title" | "confirmed-field-swap";
}

export function resolveFilenameSearch(name: string): {title: string; author?: string} {
	// Only the explicit "Surname, Name - Title" convention; do not guess names in arbitrary prose.
	const match = name.match(/^([\p{L} .'-]+),\s*([\p{L} .'-]+?)\s+-\s+(.+)$/u);
	if (!match) return {title: cleanFilename(cleanSearchSource(cleanFilenameExtension(name)))};
	return {title: cleanFilename(cleanSearchSource(cleanFilenameExtension(match[3]))), author: `${match[2].trim()} ${match[1].trim()}`};
}

function cleanFilenameExtension(name: string): string {
	return name.replace(/\.(?:epub|pdf|mobi|azw3?|fb2|docx?|odt|rtf|txt|md)$/i, "");
}

export function resolveMetadataSearch(name: string, localDetails: unknown, localAuthor?: string): {
	title: MetadataTitle; author?: string; fallbackTitle: string;
} {
	const title = resolveMetadataTitle(name, localDetails);
	const filename = resolveFilenameSearch(name);
	const author = localAuthor ?? filename.author;
	// A filename can encode either Title - Author or Surname, Name - Title.
	// Keep local fields primary; buildPlan explores the alternate interpretation.
	return {title, author, fallbackTitle: title.source === "localDetails" ? title.title : filename.title};
}

export function resolveMetadataTitle(name: string, localDetails: unknown): MetadataTitle {
	const fallback = (reason: MetadataTitle["reason"]): MetadataTitle => ({
		title: resolveFilenameSearch(name).title, source: "filename", reason
	});

	if (localDetails == undefined) return fallback("missing-details");
	let details = localDetails;
	if (typeof details === "string") {
		try {
			details = JSON.parse(details);
		} catch {
			return fallback("invalid-json");
		}
	}
	if (!details || typeof details !== "object" || Array.isArray(details)) return fallback("not-object");
	const title = (details as Record<string, unknown>).title;
	if (title == undefined) return fallback("missing-title");
	if (typeof title !== "string") return fallback("invalid-title");
	if (!title.trim()) return fallback("empty-title");
	if (/^\s*(?:Microsoft (?:Word|PowerPoint|Excel)\s+-\s+|©|copyright\s*(?:©|\(c\)|\d{4}\b))/i.test(title)) return fallback("technical-title");
	const cleaned = cleanTitle(cleanSearchSource(title));
	if (!cleaned) return fallback("empty-cleaned-title");
	return {title: cleaned, source: "localDetails", reason: "local-title"};
}
