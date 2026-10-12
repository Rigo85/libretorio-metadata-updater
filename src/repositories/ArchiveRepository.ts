import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import { ArchiveRecord } from "(src)/models/interfaces/Archive";
import { LocalIdentityCorrection } from "(src)/helpers/metadataRecovery";

export class ArchiveRepository {
	private static instance: ArchiveRepository;

	public static getInstance(): ArchiveRepository {
		return ArchiveRepository.instance ??= new ArchiveRepository();
	}

	async getArchivesNeedingMetadata(maxAttempts: number, limit: number, afterId: number,
		selection?: {ids: number[]; includeExhausted: boolean}): Promise<ArchiveRecord[]> {
		if (selection?.includeExhausted && !selection.ids.length) throw new Error("Exhausted preview requires IDs");
		return PostgresAdapter.getInstance().query(`
			SELECT a.id, a.name, a."coverId", a."localDetails", a."webDetails", a."customDetails",
			  md5(ROW(a.name,a."coverId",a."localDetails")::text) AS "sourceFingerprint"
			FROM archive a
			WHERE a."webDetails" IS NULL AND a."customDetails" = false AND a.id > $1
			  AND (cardinality($4::int[]) = 0 OR a.id = ANY($4::int[]))
			  AND ($5::boolean OR NOT EXISTS (
				SELECT 1 FROM metadata_lookup_control c
				WHERE c.archive_id = a.id AND c.attempts >= $2
			  ))
			ORDER BY a.id ASC LIMIT $3
		`, [afterId, maxAttempts, limit, selection?.ids ?? [], selection?.includeExhausted ?? false]);
	}

	private correctionPatch(correction: LocalIdentityCorrection): string {
		if (correction.provider !== "google" || correction.evidence !== "google-isbn-confirmed-field-swap" ||
			!correction.isbn || !/^[A-Za-z0-9_-]{1,120}$/.test(correction.providerId ?? "")) {
			throw new Error("Local identity correction requires verified Google provenance");
		}
		// eslint-disable-next-line @typescript-eslint/naming-convention -- Preserve Calibre's local metadata field.
		return JSON.stringify({title: correction.title, "author(s)": correction.author,
			_identityCorrection: {version: 1, ...correction, correctedAt: new Date().toISOString()}});
	}

	async updateLocalIdentity(archiveId: number, correction: LocalIdentityCorrection, sourceFingerprint: string): Promise<string | undefined> {
		if (!sourceFingerprint) return undefined;
		const rows = await PostgresAdapter.getInstance().query(`
			UPDATE archive SET "localDetails" = "localDetails" || $1::jsonb
			WHERE id = $2 AND "customDetails" = false AND "webDetails" IS NULL
			  AND md5(ROW(name,"coverId","localDetails")::text) = $3
			  AND jsonb_typeof("localDetails") = 'object' AND NOT ("localDetails" ? '_identityCorrection')
			RETURNING md5(ROW(name,"coverId","localDetails")::text) AS "sourceFingerprint"
		`, [this.correctionPatch(correction), archiveId, sourceFingerprint]);
		return rows[0]?.sourceFingerprint;
	}

	async updateWebDetails(archiveId: number, webDetails: string, sourceFingerprint?: string, correction?: LocalIdentityCorrection): Promise<boolean> {
		if (correction && !sourceFingerprint) return false;
		// A user or another service may have edited this row during HTTP lookup.
		const rows = await PostgresAdapter.getInstance().query(`
			UPDATE archive SET "webDetails" = $1,
			  "localDetails" = CASE WHEN $4::jsonb IS NULL THEN "localDetails" ELSE "localDetails" || $4::jsonb END
			WHERE id = $2 AND "customDetails" = false AND "webDetails" IS NULL
			  AND ($3::text IS NULL OR md5(ROW(name,"coverId","localDetails")::text) = $3)
			  AND ($4::jsonb IS NULL OR (jsonb_typeof("localDetails") = 'object' AND NOT ("localDetails" ? '_identityCorrection')))
			RETURNING id
		`, [webDetails, archiveId, sourceFingerprint, correction ? this.correctionPatch(correction) : undefined]);
		return rows.length > 0;
	}
}
