/* eslint-disable @typescript-eslint/naming-convention -- PostgreSQL column names are part of the stored contract. */
export interface MetadataLookupControl {
	id?: number;
	archive_id: number;
	attempts: number;
	last_attempt_at: Date;
}
