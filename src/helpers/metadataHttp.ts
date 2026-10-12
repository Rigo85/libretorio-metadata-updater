export const METADATA_TIMEOUT_MS = 20000;
export const METADATA_MAX_BYTES = 2 * 1024 * 1024;

export interface MetadataRequestGate {
	available(): boolean;
	record(): boolean;
}

export function retryAfterMilliseconds(value: unknown, now = Date.now()): number | undefined {
	if (typeof value !== "string" || value.length > 128) return undefined;
	const text = value.trim();
	const milliseconds = /^\d+$/.test(text) ? Number(text) * 1000 :
		/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(text) ? Date.parse(text) - now : NaN;
	return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}

export function metadataHttpOptions() {
	return {
		timeout: METADATA_TIMEOUT_MS,
		signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
		maxContentLength: METADATA_MAX_BYTES,
		maxBodyLength: METADATA_MAX_BYTES,
		maxRedirects: 3
	};
}
