import path from "path";
import * as dotenv from "dotenv";

dotenv.config({path: ".env"});

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`Invalid integer setting: ${name}`);
	}
	return value;
}

const mode = process.env.METADATA_MODE ?? "paused";
if (!["paused", "preview", "write"].includes(mode)) throw new Error("Invalid METADATA_MODE");
const archiveIds: unknown = JSON.parse(process.env.METADATA_ARCHIVE_IDS ?? "[]");
if (!Array.isArray(archiveIds) || archiveIds.length > 100 ||
	archiveIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(archiveIds).size !== archiveIds.length) throw new Error("Invalid METADATA_ARCHIVE_IDS");
if (mode === "preview" && !archiveIds.length) throw new Error("Preview requires explicit METADATA_ARCHIVE_IDS");
const retryExhausted = process.env.METADATA_RETRY_EXHAUSTED ?? "false";
if (!["true", "false"].includes(retryExhausted) || (retryExhausted === "true" && !archiveIds.length)) throw new Error("Retrying exhausted requires explicit archive IDs");

export const config = {
	production: {
		db: {
			databaseUrl: process.env.DATABASE_URL,
			redisUrl: process.env.REDIS_URL || "redis://localhost:6379"
		},
		server: {
			port: parseInt(process.env.PORT || "3010"),
			environment: process.env.NODE_ENV || "development"
		},
		paths: {
			tempCovers: path.join(__dirname, "..", "public", "temp_covers"),
			covers: path.join(__dirname, "..", "public", "covers")
		},
		metadata: {
			mode: mode as "paused" | "preview" | "write",
			archiveIds: archiveIds as number[],
			retryExhausted: retryExhausted === "true",
			maxArchivesPerRun: integerSetting("METADATA_MAX_ARCHIVES_PER_RUN", 20, 1, 10000),
			maxRequestsPerRun: integerSetting("METADATA_MAX_REQUESTS_PER_RUN", 80, 1, 10000),
			cron: process.env.CRON_SCHEDULE || "0 3 * * *",
			action: process.env.ACTION || "update-metadata",
			canUseOpenLibrary: (process.env.CAN_USE_OPENLIBRARY_API || "true").toLowerCase() === "true",
			googleApiKeys: (process.env.GOOGLE_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean),
			dailyRequestLimit: integerSetting("DAILY_REQUEST_LIMIT", 1000, 1, 100000),
			requestSafetyBufferPerKey: integerSetting("REQUEST_SAFETY_BUFFER_PER_KEY", 100, 0, 100000),
			maxAttempts: integerSetting("MAX_ATTEMPTS", 3, 1, 100),
			requestDelayMs: integerSetting("REQUEST_DELAY_MS", 2000, 1000, 60000),
			batchSize: integerSetting("METADATA_BATCH_SIZE", 50, 1, 100)
		}
	},
	development: {}
};
