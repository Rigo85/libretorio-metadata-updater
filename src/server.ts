// Hack to get module importing from typescript correctly translated to Node.js (CommonJS)
const moduleAlias = require("module-alias");
moduleAlias.addAliases({
	"@root": __dirname + "/..",
	"(src)": __dirname
});

import { Request, Response, NextFunction } from "express";
import errorHandler from "errorhandler";

import { bootstrap } from "(src)/app";
import { PostgresAdapter } from "(src)/db/PostgresAdapter";
import RedisAdapter from "(src)/db/RedisAdapter";
import { config } from "(src)/config/configuration";
import { createLogger } from "(src)/helpers/logger";

async function fullServerStart() {
	const app = await bootstrap();
	if (!app) {
		throw new Error("Failed to bootstrap the application.");
	}

	const logger = createLogger("server");
	const shutdown = async (signal?: string) => {
		const exitCode = signal ? 0 : 1;
		const reason = signal || "Critical error";

		logger.info({reason}, "Starting graceful shutdown");

		const forceExit = setTimeout(() => {
			logger.error("Forcing shutdown after timeout");
			process.exit(exitCode);
		}, 10000);

		try {
			const dbService = PostgresAdapter.getInstance();
			await dbService.disconnect();
			await RedisAdapter.disconnect();

			clearTimeout(forceExit);
			logger.info("Graceful shutdown completed");
			process.exit(exitCode);
		} catch (error) {
			logger.error({err: error}, "Error during shutdown");
			process.exit(1);
		}
	};

	if (config.production.server.environment === "development") {
		app.use(errorHandler());
	} else {
		app.use((err: any, req: Request, res: Response, next: NextFunction) => {
			logger.error({err}, "Unhandled request error");
			res.status(err.status || 500);
			res.send({error: "Internal Server Error", message: err.message || "An unexpected error occurred."});
		});
	}

	process.on("uncaughtException", (error) => {
		logger.error({err: error}, "Uncaught Exception");
		shutdown().catch(e => logger.error({err: e}, "Shutdown error"));
	});

	process.on("unhandledRejection", (reason, promise) => {
		logger.error({reason}, "Unhandled Rejection");
		shutdown().catch(e => logger.error({err: e}, "Shutdown error"));
	});

	["SIGINT", "SIGTERM"].forEach(signal => {
		process.on(signal, () => {
			logger.info({signal}, "Received signal. Shutting down gracefully.");
			shutdown(signal).catch(e => logger.error({err: e}, "Shutdown error"));
		});
	});

	const startServer = async () => {
		try {
			const port = config.production.server.port;
			const nodeEnv = config.production.server.environment;
			app.listen(port, () => {
				logger.info({port, nodeEnv}, "Server running");
			});
		} catch (error) {
			logger.error({err: error}, "Error starting server");
			process.exit(1);
		}
	};

	startServer().catch((error) => {
		logger.error({err: error}, "Error in startServer");
		process.exit(1);
	});
}

fullServerStart().catch(console.error);
