import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import axios from "axios";
import fs from "fs-extra";
import { config } from "(src)/config/configuration";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("CoverService");
const runConverter = promisify(execFile);

export class CoverService {
	private static instance: CoverService;

	public static getInstance(): CoverService {
		return CoverService.instance ??= new CoverService();
	}

	async downloadAndConvertCover(coverUrl: string, coverId: string): Promise<boolean> {
		if (!/^[a-zA-Z0-9_-]+$/.test(coverId)) {
			logger.error({coverId}, "Invalid cover identifier");
			return false;
		}
		const paths = config.production.paths;
		const finalPath = path.join(paths.covers, `${coverId}.webp`);
		const token = randomUUID();
		const input = path.join(paths.tempCovers, `${token}.image`);
		const output = path.join(paths.covers, `.${token}.webp.tmp`);
		try {
			if (await fs.pathExists(finalPath)) {
				logger.info({coverId}, "Cover already exists; unchanged");
				return false;
			}
			await fs.ensureDir(paths.tempCovers);
			await fs.ensureDir(paths.covers);
			const signal = AbortSignal.timeout(20000);
			const response = await axios.get(coverUrl, {responseType: "stream", timeout: 20000, signal, maxRedirects: 3});
			let bytes = 0;
			const bounded = new Transform({transform(chunk, encoding, callback) {
				bytes += chunk.length;
				if (bytes > 20 * 1024 * 1024) callback(new Error("Cover exceeds 20 MiB"));
				else callback(undefined, chunk);
			}});
			await pipeline(response.data, bounded, fs.createWriteStream(input, {flags: "wx"}), {signal});
			await runConverter("cwebp", ["-q", "85", input, "-o", output], {timeout: 20000, maxBuffer: 1024 * 1024});
			if (!(await fs.stat(output)).size) throw new Error("Empty converted cover");
			// Same directory/filesystem: publish complete output without replacing an existing cover.
			await fs.link(output, finalPath);
			logger.info({coverId, bytes}, "Cover downloaded and converted to webp");
			return true;
		} catch (error: any) {
			if (error?.code === "EEXIST") logger.info({coverId}, "Cover created meanwhile; unchanged");
			else logger.error({coverId, code: error?.code, message: error?.message}, "Failed to download/convert cover");
			return false;
		} finally {
			for (const file of [input, output]) {
				try {
					await fs.remove(file);
				} catch {
					logger.warn({file}, "Could not remove temporary cover");
				}
			}
		}
	}
}
