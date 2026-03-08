import { execSync } from "child_process";

const run = (cmd: string) => execSync(cmd, {stdio: "inherit"});

run("mkdir -p dist/public");
run("ln -sfn /media/RIGO7/Libretorio-conf/covers dist/public/covers");
run("ln -sfn /media/RIGO7/Libretorio-conf/temp_covers dist/public/temp_covers");
