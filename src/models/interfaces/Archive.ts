export interface ArchiveRecord {
	id: number;
	name: string;
	coverId: string;
	localDetails: string | undefined;
	webDetails: string | undefined;
	customDetails: boolean;
}
