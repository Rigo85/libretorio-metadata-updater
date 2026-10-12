export interface ArchiveRecord {
	id: number;
	sourceFingerprint?: string;
	name: string;
	coverId: string;
	localDetails: unknown;
	webDetails: string | undefined;
	customDetails: boolean;
}
