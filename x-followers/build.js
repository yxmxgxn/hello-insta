// followers.js からブックマークレット(bookmarklet.txt)を作る: node x-followers/build.js
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "followers.js"), "utf8")
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l))   // 行まるごとのコメント
  .map((l) => l.replace(/\s+\/\/ .*$/, ""))  // 行末のコメント
  .join("\n");
fs.writeFileSync(path.join(__dirname, "bookmarklet.txt"), "javascript:" + encodeURIComponent(src) + "\n");
