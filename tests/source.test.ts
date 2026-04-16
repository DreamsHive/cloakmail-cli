import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AcquireError } from "../src/lib/errors"

// Hoisted so the `vi.mock` factory below can reach it — `vi.mock` is pulled
// to the top of the module at transform time, which runs before any plain
// top-level `const` declarations would be initialized.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}))

// Imported AFTER the mock is declared. extractTarballToDir does not exist in
// source.ts yet — this import is what forces the TDD red step: the test file
// will fail to load until Task 2 lands.
import { extractTarballToDir } from "../src/extensions/source"

interface FakeChildHandle {
  child: EventEmitter & { stderr: EventEmitter }
  emitStderr: (chunk: string) => void
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void
  emitError: (err: NodeJS.ErrnoException) => void
}

/**
 * Minimal EventEmitter-shaped fake that matches the subset of the
 * ChildProcess surface `extractTarballToDir` actually reads: a `.stderr`
 * stream that emits 'data', plus `close` and `error` on the child itself.
 * Tests stage one of these per case and drive it through the helper with
 * the emit* functions.
 */
function makeFakeChild(): FakeChildHandle {
  const stderr = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { stderr }) as EventEmitter & {
    stderr: EventEmitter
  }
  return {
    child,
    emitStderr: (chunk) => {
      stderr.emit("data", Buffer.from(chunk))
    },
    emitClose: (code, signal = null) => {
      child.emit("close", code, signal)
    },
    emitError: (err) => {
      child.emit("error", err)
    },
  }
}

describe("source > extractTarballToDir", () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  test("passes archive and destination as separate argv entries on POSIX-shaped paths", async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake.child)

    const archivePath = "/home/u/.cloakmail-cli/cache/cloakmail-v1.1.0.tar.gz"
    const destDir = "/tmp/cloakmail-extract-abc"
    const version = "v1.1.0"

    const run = extractTarballToDir(archivePath, destDir, version)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", archivePath, "-C", destDir],
      expect.objectContaining({ windowsHide: true }),
    )
    const argv = spawnMock.mock.calls[0]?.[1] as string[]
    for (const arg of argv) {
      expect(arg).not.toContain('"')
    }

    fake.emitClose(0)
    await expect(run).resolves.toBeUndefined()
  })

  // This is the specific shape that reproduces issue #5: a Windows-style
  // archive path with backslashes and an embedded space. Under the old
  // shell-string invocation (`tar -xzf "${path}"`), cmd.exe preserved the
  // inner double quotes and tar saw a filename starting and ending with
  // literal `"` characters. With argv-based spawn this can never happen —
  // the test pins that guarantee.
  test("passes Windows-shaped archive path (backslashes + spaces) as clean argv entries", async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake.child)

    const archivePath = "C:\\Users\\Some User\\.cloakmail-cli\\cache\\cloakmail-v1.1.0.tar.gz"
    const destDir = "C:\\Users\\Some User\\AppData\\Local\\Temp\\cloakmail-extract-CTzB8a"
    const version = "v1.1.0"

    const run = extractTarballToDir(archivePath, destDir, version)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", archivePath, "-C", destDir],
      expect.objectContaining({ windowsHide: true }),
    )
    const argv = spawnMock.mock.calls[0]?.[1] as string[]
    expect(argv[1]).toBe(archivePath)
    expect(argv[3]).toBe(destDir)
    for (const arg of argv) {
      expect(arg).not.toContain('"')
    }

    fake.emitClose(0)
    await expect(run).resolves.toBeUndefined()
  })

  test("wraps a non-zero tar exit in AcquireError with stderr and exit code", async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake.child)

    const run = extractTarballToDir("/archive.tar.gz", "/tmp/dest", "v1.1.0")

    fake.emitStderr("tar: Error opening archive: Failed to open 'corrupt'")
    fake.emitClose(1)

    const err = await run.catch((e) => e)
    expect(err).toBeInstanceOf(AcquireError)
    expect((err as Error).message).toContain("corrupt")
    expect((err as Error).message).toContain("1")
  })

  test("wraps ENOENT spawn error in AcquireError identifying tar", async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake.child)

    const run = extractTarballToDir("/archive.tar.gz", "/tmp/dest", "v1.1.0")

    const enoent = Object.assign(new Error("spawn tar ENOENT"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException
    fake.emitError(enoent)

    const err = await run.catch((e) => e)
    expect(err).toBeInstanceOf(AcquireError)
    expect((err as Error).message.toLowerCase()).toContain("tar")
    expect((err as Error).message.toLowerCase()).toContain("not found on path")
    // The underlying ErrnoException carries a `.code` property; AcquireError
    // does not, which is how we prove the raw error isn't leaking out wrapped
    // only in a rethrow-shaped disguise.
    expect((err as NodeJS.ErrnoException).code).toBeUndefined()
  })

  test("treats any other spawn error as a generic AcquireError", async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake.child)

    const run = extractTarballToDir("/archive.tar.gz", "/tmp/dest", "v1.1.0")

    const eacces = Object.assign(new Error("EACCES: permission denied"), {
      code: "EACCES",
    }) as NodeJS.ErrnoException
    fake.emitError(eacces)

    const err = await run.catch((e) => e)
    expect(err).toBeInstanceOf(AcquireError)
    expect((err as Error).message).toContain("EACCES: permission denied")
    // The ENOENT branch must not be triggered for other error codes.
    expect((err as Error).message.toLowerCase()).not.toContain("not found on path")
  })

  test("wraps signal termination in AcquireError without emitting 'tar exit null'", async () => {
    const fake = makeFakeChild()
    spawnMock.mockReturnValue(fake.child)

    const run = extractTarballToDir("/archive.tar.gz", "/tmp/dest", "v1.1.0")

    fake.emitStderr("tar: interrupted")
    fake.emitClose(null, "SIGTERM")

    const err = await run.catch((e) => e)
    expect(err).toBeInstanceOf(AcquireError)
    const msg = (err as Error).message
    expect(msg).toContain("signal")
    expect(msg).toContain("SIGTERM")
    expect(msg).not.toContain("tar exit null")
  })
})
