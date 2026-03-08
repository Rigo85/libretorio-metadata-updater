export function cleanFilename(filename: string): string {
	return filename
		.replace(/\.[^/.]+$/, "")
		.replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚüÜ0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function cleanTitle(title: string): string {
	return title
		.replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚüÜ0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
