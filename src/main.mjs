#!/usr/bin/env node
// @ts-check
import { connect } from "./acp.mjs";
import { backstageClient } from "./backstage.mjs";
import { createBridge } from "./bridge.mjs";
import { loadConfig } from "./config.mjs";

const config = loadConfig(process.argv.slice(2), process.env);
/** @type {import("./acp.mjs").Connection} */
let connection;
const bridge = createBridge({ config, client: backstageClient(config), acp: () => connection });
connection = connect(process.stdin, process.stdout, bridge);
await connection.closed;
process.exit(0);
