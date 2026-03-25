import { main } from "../src/main.ts";
// import { embeddedFiles } from "bun";
// console.log(embeddedFiles);
// uncomment for quickly checking wtf
await main(process.argv.slice(2), true);
