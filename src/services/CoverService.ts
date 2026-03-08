import { execSync } from "child_process";
import path from "path";
import axios from "axios";
import fs from "fs-extra";
import { config } from "(src)/config/configuration";
import { createLogger } from "(src)/helpers/logger";

const logger = createLogger("CoverService");

export class CoverService {
	private static instance: CoverService;

	private constructor() {
	}

	public static getInstance(): CoverService {
		if (!CoverService.instance) {
			CoverService.instance = new CoverService();
		}
		return CoverService.instance;
	}

	async downloadAndConvertCover(coverUrl: string, coverId: string): Promise<boolean> {
		const tempPath = path.join(config.production.paths.tempCovers, `${coverId}.jpg`);
		const finalPath = path.join(config.production.paths.covers, `${coverId}.webp`);

		try {
			await this.downloadImage(coverUrl, tempPath);
			this.convertToWebp(tempPath, finalPath);
			logger.info({coverId}, "Cover downloaded and converted to webp");
			return true;
		} catch (error) {
			logger.error({coverId, coverUrl, err: error}, "Failed to download/convert cover");
			return false;
		}
	}

	private async downloadImage(url: string, filepath: string): Promise<void> {
		if (!url?.trim() || !filepath?.trim()) {
			logger.error({url, filepath}, "downloadImage: missing parameters");
			return;
		}

		const response = await axios({
			url,
			method: "GET",
			responseType: "stream"
		});

		return new Promise((resolve, reject) => {
			const writer = fs.createWriteStream(filepath);
			response.data.pipe(writer);
			writer.on("finish", resolve);
			writer.on("error", reject);
		});
	}

	private convertToWebp(jpgPath: string, webpPath: string): void {
		try {
			execSync(`cwebp -q 85 "${jpgPath}" -o "${webpPath}"`, {stdio: "ignore"});
			fs.removeSync(jpgPath);
		} catch (error) {
			logger.error({jpgPath}, "convertToWebp: could not convert — keeping original");
		}
	}
}
