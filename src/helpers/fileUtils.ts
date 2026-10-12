export function cleanFilename(filename: string): string {
	return filename
		.replace(/\.(?:epub|pdf|mobi|azw3?|fb2|docx?|odt|rtf|txt|md|cb[rz7t]|zip|rar|7z|mp3|m4[ab])$/i, "")
		.replace(/[^\p{L}\p{N} ]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function cleanTitle(title: string): string {
	return title
		.replace(/[^\p{L}\p{N} ]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}
