import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/server/db.js";

test("database startup creates the SQLite parent directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cnama-plex-db-"));
  const dbPath = path.join(root, "nested", "cnama.sqlite");
  const db = new AppDatabase(dbPath);

  try {
    assert.ok(fs.existsSync(dbPath));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "database startup reports unwritable SQLite directories clearly",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cnama-plex-db-unwritable-"));
    const dbPath = path.join(root, "cnama.sqlite");
    fs.chmodSync(root, 0o555);

    try {
      assert.throws(
        () => new AppDatabase(dbPath),
        /SQLite database is not writable at .*cnama\.sqlite.*PUID\/PGID/
      );
    } finally {
      fs.chmodSync(root, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
