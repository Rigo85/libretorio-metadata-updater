import { Request, Response, NextFunction } from "express";
import { config } from "(src)/config/configuration";
import { MetadataUpdaterService } from "(src)/services/MetadataUpdaterService";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("home");

export const index = async (req: Request, res: Response, next: NextFunction) => {
	res.end("Ok");
};

export const checkParameter = async (req: Request, res: Response, next: NextFunction) => {
	const action = req.params.action || req.query.action;

	if (action === config.production.metadata.action) {
		try {
			MetadataUpdaterService
				.getInstance()
				.runUpdate()
				.catch((error: any) => {
					logger.error({err: error}, "Executing metadata update:");
				});

			return res.status(200).json({message: "Metadata update triggered", success: true});
		} catch (error) {
			logger.error({err: error}, "Error triggering metadata update");
			return res.status(400).json({message: "Error triggering update", success: false});
		}
	}
	return res.status(400).json({message: "Invalid parameter", success: false});
};
