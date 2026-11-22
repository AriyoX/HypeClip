import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv[2];
if (!target) throw Error("Supply an output folder for the download page.");
const output = resolve(target);

const files = [
  ["website/index.html", "index.html"],
  ["website/styles.css", "styles.css"],
  ["website/assets/studio.png", "assets/studio.png"],
  ["Start Here.html", "quick-start.html"],
  ...[
    "barlow-condensed-700.woff2",
    "barlow-condensed-OFL.txt",
    "dm-sans.woff2",
    "dm-sans-OFL.txt",
  ].map((file) => ["dashboard/fonts/" + file, "assets/" + file]),
];

mkdirSync(join(output, "assets"), { recursive: true });
for (const [source, destination] of files)
  copyFileSync(join(root, source), join(output, destination));
writeFileSync(join(output, ".nojekyll"), "");
console.log(output);
