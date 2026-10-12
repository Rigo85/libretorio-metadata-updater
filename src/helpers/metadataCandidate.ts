import { WebDetails } from "../models/interfaces/OpenLibrary";

function tokens(text: string): string[] {
	return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function romanNumber(part: string | undefined): number | undefined {
	if (!part || !/^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/.test(part)) return undefined;
	const values: Record<string, number> = {i:1, v:5, x:10, l:50, c:100, d:500, m:1000};
	return [...part].reduce((sum, digit, i) => sum + (values[digit] < (values[part[i + 1]] ?? 0) ? -values[digit] : values[digit]), 0);
}

export function terminalVolumeVariant(title: string): string | undefined {
	if (title.length > 500) return undefined;
	const match = title.match(/^(.+\S)\s+(?:vol(?:umen|ume)?\.?|tomo)\s+(\d+|[ivxlcdm]+)$/iu);
	if (!match) return undefined;
	const number = /^\d+$/.test(match[2]) ? Number(match[2]) : romanNumber(match[2].toLowerCase());
	if (!Number.isSafeInteger(number) || number <= 0) return undefined;
	return `${match[1]} ${number}`;
}

function titleTokens(title: string): string[] {
	const parts = tokens(terminalVolumeVariant(title) ?? title);
	return parts.map((part, index) => {
		const roman = romanNumber(part);
		// Convert only explicit volume labels; e.g. Malcolm X is not Malcolm 10.
		return roman !== undefined && ["tomo", "volumen", "volume", "vol", "libro", "book", "parte", "part"].includes(parts[index - 1]) ? String(roman) : part;
	});
}

export function resolveMetadataAuthor(details: unknown): string | undefined {
	if (typeof details === "string") {
		try {
			details = JSON.parse(details);
		} catch {
			return undefined;
		}
	}
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const value = (details as Record<string, unknown>)["author(s)"];
	if (typeof value !== "string" || value.length > 300) return undefined;
	const cleaned = value.replace(/\s*\[([^\]]+)\]\s*$/, (bracket, contents: string, offset: number) => {
		const outer = tokens(value.slice(0, offset)).sort().join(" ");
		return outer === tokens(contents).sort().join(" ") ? "" : bracket;
	}).trim();
	const normalized = tokens(cleaned).join(" ");
	if (/^(?:usuario|user|utilisateur|benutzer)(?: de| del| of)? (?:microsoft )?windows(?: \d+| xp| vista)?$/.test(normalized)) return undefined;
	if (!normalized || /^(unknown|desconocido|anonimo|anonymous|admin|administrator|administrador|user|usuario|windows(?: user| xp| vista| nt| server| \d+)?|microsoft|calibre|booksmedicos org|varios autores|autores varios|various authors|aa vv|aavv|vv aa|vvaa)$/.test(normalized)) return undefined;
	if (/https?:|www\.|@/i.test(value)) return undefined;
	return cleaned;
}

function nameTokens(name: string): string[] {
	const inverted = name.match(/^([^,]+),\s*([^,]+)$/);
	const parts = tokens(inverted ? `${inverted[2]} ${inverted[1]}` : name);
	return parts.length > 1 ? parts.filter(part => !["de", "del", "la", "las", "los", "y", "and", "von", "van"].includes(part)) : parts;
}

function compatibleExpandedAuthor(query: string[], result: string[]): boolean {
	const full = query.filter(part => part.length > 1);
	if (!full.length || !full.every(part => result.includes(part))) return false;
	const initials = query.filter(part => part.length === 1);
	if (!initials.length) return true;
	// Missing initials are allowed, but supplied initials/names must not contradict them.
	const remaining = [...initials];
	for (const part of result.filter(part => !full.includes(part))) {
		const index = remaining.indexOf(part[0]);
		if (index < 0) return false;
		remaining.splice(index, 1);
	}
	return true;
}

function compatibleAuthor(query: string[], result: string[]): boolean {
	if (compatibleExpandedAuthor(query, result)) return true;
	// Reverse expansion requires an explicit shared surname, not just a shared given name.
	const surname = query[query.length - 1];
	return !!surname && surname.length > 1 && surname === result[result.length - 1] &&
		result.length <= query.length && result.some(part => part.length === 1) && compatibleExpandedAuthor(result, query);
}

function packedInitials(name: string): string[] | undefined {
	const match = name.trim().match(/^([A-Z]{2,3})\s+(\p{Lu}\p{Ll}+(?:[-' ]\p{Lu}?\p{Ll}+)*)$/u);
	if (!match) return undefined;
	// Only another explicit set of initials corroborates a packed spelling; never guess full names.
	return [...match[1].toLowerCase(), ...nameTokens(match[2])];
}

function compatibleCredit(query: string, result: string): boolean {
	const left = nameTokens(query), right = nameTokens(result);
	const packedLeft = packedInitials(query), packedRight = packedInitials(result);
	if (packedLeft || packedRight) {
		const a = packedLeft ?? left, b = packedRight ?? right;
		return left.join(" ") === right.join(" ") || (a.length === b.length && a.every((part, i) => part === b[i]));
	}
	return compatibleAuthor(left, right);
}

export function metadataCandidateRejection(title: string, author: string | undefined, candidate: WebDetails): string | undefined {
	const queryParts = titleTokens(title);
	const query = new Set(queryParts);
	if (!query.size || !candidate || typeof candidate.title !== "string" || !candidate.title.trim()) return "invalid-title";
	const numbers = queryParts.filter(token => /^\d+$/.test(token)).map(Number).join(",");
	const resultParts = titleTokens(candidate.title);
	const result = new Set(resultParts);
	const resultNumbers = resultParts.filter(token => /^\d+$/.test(token)).map(Number).join(",");
	if (numbers !== resultNumbers) return "volume-mismatch";
	if (romanNumber(queryParts.at(-1)) !== romanNumber(resultParts.at(-1))) return "volume-mismatch";
	if (["no", "not", "nunca", "never", "jamas", "sin", "without"].some(word => query.has(word) !== result.has(word))) return "title-mismatch";
	const common = [...query].filter(token => result.has(token)).length;
	if (common / query.size < 0.8 || common / result.size < 0.8) return "title-mismatch";
	if (author) {
		const groups = author.split(/\s+(?:y|and|&)\s+|\s*;\s*/i);
		if (!groups.length || groups.some(group => !nameTokens(group).some(part => part.length > 1))) return "insufficient-author";
		if (!Array.isArray(candidate.author_name) || !candidate.author_name.length) return "missing-author";
		const authors = candidate.author_name.filter(value => typeof value === "string");
		if (!groups.every(group => authors.some(name => compatibleCredit(group, name)))) return "author-mismatch";
	}
	return undefined;
}

// A conservative admission filter, not a bibliographic identity certificate.
export function selectMetadataCandidate(title: string, author: string | undefined, candidates: WebDetails[]): WebDetails | undefined {
	const matches = candidates.filter(candidate => !metadataCandidateRejection(title, author, candidate));
	// Without an author, do not resolve a homonym by provider ordering alone.
	if (!author && matches.length > 1) {
		const signatures = new Set(matches.map(candidate => (candidate.author_name ?? []).map(name => tokens(name).join(" ")).sort().join("|")));
		if (signatures.size > 1) return undefined;
	}
	return matches[0];
}
