import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("cloakmail-cli CLI", () => {
	test("hello command runs", async () => {
		const { stdout } = await execFileAsync("node", [
			"--import", "tsx",
			"src/index.ts",
			"hello",
		]);
		expect(stdout).toContain("Hello, World!");
	});
});
