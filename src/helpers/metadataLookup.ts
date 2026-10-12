export type LookupFailure = "error" | "limited" | "rejected" | undefined;

// At most two queries per provider. A failed variant cannot become a completed empty search.
export async function lookupWithFallback<T extends object>(title: string, fallbackTitle: string | undefined,
	lookup: (title: string, general: boolean) => Promise<T | LookupFailure>): Promise<T | LookupFailure> {
	const first = await lookup(title, false);
	if (typeof first === "object" || first === "limited" || first === "error" || !fallbackTitle?.trim() || fallbackTitle.length > 500) return first;
	const second = await lookup(fallbackTitle, true);
	if (second === undefined && first === "rejected") return "rejected";
	return second;
}
