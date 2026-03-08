export interface GoogleBooksResponse {
	kind: string;
	totalItems: number;
	items: Volume[];
}

export interface Volume {
	kind: string;
	id: string;
	etag: string;
	selfLink: string;
	volumeInfo: VolumeInfo;
}

export interface VolumeInfo {
	title: string;
	subtitle?: string;
	authors?: string[];
	publisher?: string;
	publishedDate?: string;
	description?: string;
	industryIdentifiers?: IndustryIdentifier[];
	pageCount?: number;
	categories?: string[];
	averageRating?: number;
	ratingsCount?: number;
	language: string;
	imageLinks?: ImageLinks;
}

export interface IndustryIdentifier {
	type: string;
	identifier: string;
}

export interface ImageLinks {
	smallThumbnail: string;
	thumbnail: string;
}
