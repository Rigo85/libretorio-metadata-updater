import * as dotenv from "dotenv";
import express from "express";
import compression from "compression";
import lusca from "lusca";
import helmet from "helmet";
import cors from "cors";
import path from "path";
import { schedule } from "node-cron";
import moment from "moment-timezone";

import { MetadataUpdaterService } from "(src)/services/MetadataUpdaterService";
import { config } from "(src)/config/configuration";
import * as homeController from "(src)/controllers/home";
import { createLogger } from "(src)/helpers/logger";

dotenv.config({path: ".env"});

export async function bootstrap(): Promise<express.Express> {
	const logger = createLogger("App");

	const app = express();

	app.use(helmet());
	app.use(compression());

	app.use(express.json());
	app.use(express.urlencoded({extended: true}));

	app.use(cors());
	app.use(lusca.xframe("SAMEORIGIN"));
	app.use(lusca.xssProtection(true));

	app.set("port", config.production.server.port);
	app.use(express.static(path.join(__dirname, "public"), {maxAge: 31557600000}));

	app.get("/", homeController.index);
	app.get("/check/:action", homeController.checkParameter);

	schedule(
		config.production.metadata.cron,
		async () => {
			logger.info(`Executing metadata update cron at ${moment(new Date()).tz("America/Lima").format("LLLL")}`);
			MetadataUpdaterService
				.getInstance()
				.runUpdate()
				.catch((error: any) => {
					logger.error({err: error}, "Metadata update cron failed");
				});
		},
		{
			timezone: "America/Lima"
		}
	);

	logger.info({cron: config.production.metadata.cron}, "Cron scheduled");

	return app;
}
