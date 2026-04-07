#!/usr/bin/env node

import { build } from "@seedcli/core";

const cli = build("cloakmail-cli")
	.src(import.meta.dirname) // Auto-discovers commands/ and extensions/
	.help()
	.version("0.1.0")
	.create();

await cli.run();
