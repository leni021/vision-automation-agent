import fs from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";

const sqlite = sqlite3.verbose();

export default class DatabaseManager {
  constructor(dbPath = "data/jobhunter.db") {
    this.dbPath = dbPath;
    this.db = null;
  }

  async connect() {
    if (this.db) {
      return this.db;
    }

    const directory = path.dirname(this.dbPath);
    if (directory && directory !== ".") {
      fs.mkdirSync(directory, { recursive: true });
    }

    this.db = await new Promise((resolve, reject) => {
      const instance = new sqlite.Database(this.dbPath, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(instance);
      });
    });

    return this.db;
  }

  async run(sql, params = []) {
    await this.connect();

    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(error) {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          lastID: this.lastID,
          changes: this.changes
        });
      });
    });
  }

  async get(sql, params = []) {
    await this.connect();

    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(row ?? null);
      });
    });
  }

  async all(sql, params = []) {
    await this.connect();

    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(rows ?? []);
      });
    });
  }

  async init() {
    await this.connect();

    await this.run(`
      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        portal TEXT NOT NULL,
        empresa TEXT,
        puesto TEXT,
        url TEXT NOT NULL UNIQUE,
        fecha_postulacion TEXT NOT NULL,
        estado TEXT NOT NULL
      )
    `);

    await this.run("CREATE INDEX IF NOT EXISTS idx_applications_url ON applications(url)");
    await this.run("CREATE INDEX IF NOT EXISTS idx_applications_fecha ON applications(fecha_postulacion)");
  }

  async isAlreadyApplied(url) {
    const normalizedUrl = String(url ?? "").trim();
    if (!normalizedUrl) {
      return false;
    }

    const row = await this.get("SELECT id FROM applications WHERE url = ? LIMIT 1", [normalizedUrl]);
    return Boolean(row);
  }

  async registerApplication({
    portal,
    empresa,
    puesto,
    url,
    fechaPostulacion = new Date().toISOString(),
    estado = "postulado"
  }) {
    const normalizedUrl = String(url ?? "").trim();
    if (!normalizedUrl) {
      throw new Error("URL invalida para registrar postulacion.");
    }

    await this.run(
      `
        INSERT INTO applications (portal, empresa, puesto, url, fecha_postulacion, estado)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          portal = excluded.portal,
          empresa = excluded.empresa,
          puesto = excluded.puesto,
          fecha_postulacion = excluded.fecha_postulacion,
          estado = excluded.estado
      `,
      [
        String(portal ?? "Desconocido"),
        String(empresa ?? ""),
        String(puesto ?? ""),
        normalizedUrl,
        String(fechaPostulacion),
        String(estado)
      ]
    );
  }

  async listRecentApplications(limit = 20) {
    const safeLimit = Math.max(1, Number(limit) || 20);
    return this.all(
      `
        SELECT id, portal, empresa, puesto, url, fecha_postulacion, estado
        FROM applications
        ORDER BY datetime(fecha_postulacion) DESC
        LIMIT ?
      `,
      [safeLimit]
    );
  }

  async close() {
    if (!this.db) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.db.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    this.db = null;
  }
}