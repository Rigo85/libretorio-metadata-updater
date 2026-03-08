import path from "path";
import * as dotenv from "dotenv";

dotenv.config({path: ".env"});

export const config = {
	production: {
		db: {
			databaseUrl: process.env.DATABASE_URL
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
			cron: process.env.CRON_SCHEDULE || "0 3 * * *",
			action: process.env.ACTION || "update-metadata",
			canUseOpenLibrary: (process.env.CAN_USE_OPENLIBRARY_API || "true").toLowerCase() === "true",
			googleApiKeys: (process.env.GOOGLE_API_KEYS || "").split(",").map(k => k.trim()).filter(Boolean),
			dailyRequestLimit: parseInt(process.env.DAILY_REQUEST_LIMIT || "1000"),
			maxAttempts: parseInt(process.env.MAX_ATTEMPTS || "3"),
			requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || "2000")
		}
	},
	development: {}
};
