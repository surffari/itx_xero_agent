#!/usr/bin/env node
import "dotenv/config";
import { NextcloudWebDavClient } from "../src/nextcloud/webdav-client.js";
const nc = new NextcloudWebDavClient();
const files = await nc.listFolder("📥 01 - Incoming");
console.log(`=== ${files.length} files in Incoming ===`);
for (const f of files) console.log(f.filename || f.path || JSON.stringify(f));
