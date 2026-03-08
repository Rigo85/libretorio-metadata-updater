// Represents the webDetails JSON structure stored in the archive table.
// Follows the OpenLibrary search response format so the frontend can
// consume metadata from both OL and Google Books uniformly.
export interface WebDetails {
	key?: string;
	title: string;
	cover_i?: number;
	author_name?: string[];
	publisher?: string[];
	subject?: string[];
	description?: string;
	first_sentence?: string[];
	language?: string[];
	isbn?: string[];
	first_publish_year?: number;
	edition_count?: number;
	has_fulltext?: boolean;
	public_scan_b?: boolean;
	ebook_access?: string;
	cover_edition_key?: string;
	// source indicator — not present in OL responses, used to identify Google Books origin
	_source?: string;
}
